use pcsc::{Context, Error, Protocols, ReaderState, Scope, ShareMode, State};
use serde::Serialize;
use std::ffi::{CStr, CString};
use std::io::{self, Read, Write};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

const GET_UID: [u8; 5] = [0xff, 0xca, 0x00, 0x00, 0x00];

#[derive(Debug, PartialEq, Eq)]
struct Options {
    reader: String,
    poll_ms: u64,
}

#[derive(Serialize)]
struct Readers {
    readers: Vec<String>,
}

fn supported_reader(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    upper.contains("ACR1552") && upper.contains("PICC") && !upper.contains("SAM")
}

fn parse_args(args: &[String]) -> Result<Options, ()> {
    if args.len() != 4 || args[0] != "--reader" || args[2] != "--poll-ms" {
        return Err(());
    }
    let reader = &args[1];
    if reader.is_empty()
        || reader.len() > 128
        || reader.chars().any(char::is_control)
        || !supported_reader(reader)
    {
        return Err(());
    }
    let poll_ms = args[3].parse::<u64>().map_err(|_| ())?;
    if !(100..=2000).contains(&poll_ms) {
        return Err(());
    }
    Ok(Options {
        reader: reader.clone(),
        poll_ms,
    })
}

fn parse_uid_response(response: &[u8]) -> Option<[u8; 4]> {
    if response.len() != 6 || response[4..] != [0x90, 0x00] {
        return None;
    }
    response[..4].try_into().ok()
}

fn send(message: &str) -> io::Result<()> {
    let stdout = io::stdout();
    let mut output = stdout.lock();
    writeln!(output, "{message}")?;
    output.flush()
}

fn control(input: impl Read) -> bool {
    use io::BufRead;
    let mut line = Vec::new();
    match io::BufReader::new(input.take(257)).read_until(b'\n', &mut line) {
        Ok(0) => true,
        Ok(n) if n <= 256 => {
            line == b"{\"type\":\"shutdown\"}\n" || line == b"{\"type\":\"shutdown\"}\r\n"
        }
        _ => false,
    }
}

fn reader_names(context: &Context) -> Result<Vec<String>, Error> {
    let mut names: Vec<String> = context
        .list_readers_owned()?
        .iter()
        .filter_map(|name| name.to_str().ok())
        .filter(|name| supported_reader(name))
        .map(str::to_owned)
        .collect();
    names.sort();
    names.dedup();
    Ok(names)
}

fn read_uid(context: &Context, reader: &CStr) -> Result<Option<[u8; 4]>, Error> {
    let card = context.connect(reader, ShareMode::Shared, Protocols::ANY)?;
    let mut response = [0u8; 32];
    let result = card
        .transmit(&GET_UID, &mut response)
        .map(parse_uid_response);
    response.fill(0);
    result
}

fn present(state: State) -> bool {
    state.contains(State::PRESENT) && !state.intersects(State::UNKNOWN | State::UNAVAILABLE)
}

fn should_scan(state: State, scanned: bool, previous_count: Option<u32>, count: u32) -> bool {
    present(state)
        && (!scanned || previous_count.is_some_and(|previous| count.wrapping_sub(previous) >= 2))
}

fn run_reader(context: &Context, options: Options, control: Receiver<bool>) -> Result<(), ()> {
    let reader = CString::new(options.reader).map_err(|_| ())?;
    let mut state = ReaderState::new(reader.clone(), State::UNAWARE);
    let mut scanned = false;
    let mut previous_count = None;
    context
        .get_status_change(
            Duration::from_millis(options.poll_ms),
            std::slice::from_mut(&mut state),
        )
        .map_err(|_| ())?;
    if state
        .event_state()
        .intersects(State::UNKNOWN | State::UNAVAILABLE)
    {
        return Err(());
    }
    send(r#"{"type":"ready","protocol":1,"kind":"hardware"}"#).map_err(|_| ())?;
    loop {
        if let Ok(valid) = control.try_recv() {
            return if valid { Ok(()) } else { Err(()) };
        }
        let event = state.event_state();
        let count = state.event_count();
        if event.intersects(State::UNKNOWN | State::UNAVAILABLE) {
            send(r#"{"type":"error","code":"READER_IO"}"#).map_err(|_| ())?;
            return Err(());
        }
        if !present(event) {
            scanned = false;
        } else if should_scan(event, scanned, previous_count, count) {
            scanned = true;
            match read_uid(context, &reader) {
                Ok(Some(mut uid)) => {
                    let frame = format!(
                        "{{\"type\":\"scan\",\"uidHex\":\"{:02x}{:02x}{:02x}{:02x}\"}}",
                        uid[0], uid[1], uid[2], uid[3]
                    );
                    uid.fill(0);
                    send(&frame).map_err(|_| ())?;
                }
                Ok(None) => {
                    send(r#"{"type":"error","code":"INVALID_FRAME"}"#).map_err(|_| ())?;
                    return Err(());
                }
                Err(Error::NoSmartcard | Error::RemovedCard | Error::ResetCard) => {}
                Err(_) => {
                    send(r#"{"type":"error","code":"READER_IO"}"#).map_err(|_| ())?;
                    return Err(());
                }
            }
        }
        previous_count = Some(count);
        state.sync_current_state();
        match context.get_status_change(
            Duration::from_millis(options.poll_ms),
            std::slice::from_mut(&mut state),
        ) {
            Ok(()) => {}
            Err(Error::Timeout) => continue,
            Err(_) => {
                send(r#"{"type":"error","code":"READER_IO"}"#).map_err(|_| ())?;
                return Err(());
            }
        }
    }
}

fn run() -> Result<(), ()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let context = Context::establish(Scope::User).map_err(|_| ())?;
    if args == ["--list-readers"] {
        let readers = match reader_names(&context) {
            Ok(readers) => readers,
            Err(Error::NoReadersAvailable) => Vec::new(),
            Err(_) => return Err(()),
        };
        println!(
            "{}",
            serde_json::to_string(&Readers { readers }).map_err(|_| ())?
        );
        return Ok(());
    }
    let options = parse_args(&args)?;
    if !reader_names(&context)
        .map_err(|_| ())?
        .contains(&options.reader)
    {
        return Err(());
    }
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(control(io::stdin().lock()));
    });
    run_reader(&context, options, receiver)
}

fn main() {
    if run().is_err() {
        std::process::exit(2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_select_only_acr1552_contactless_reader() {
        let args = ["--reader", "ACS ACR1552U PICC 0", "--poll-ms", "250"].map(str::to_owned);
        assert_eq!(parse_args(&args).unwrap().poll_ms, 250);
        for name in ["ACS ACR1552U SAM 0", "ACS ACR1552U ICC 0", "Other PICC", ""] {
            let mut bad = args.clone();
            bad[1] = name.into();
            assert!(parse_args(&bad).is_err());
        }
        for poll in ["0", "99", "2001", "abc"] {
            let mut bad = args.clone();
            bad[3] = poll.into();
            assert!(parse_args(&bad).is_err());
        }
    }

    #[test]
    fn uid_response_requires_exactly_four_bytes_and_success_status() {
        assert_eq!(
            parse_uid_response(&[0, 0xab, 0xcd, 1, 0x90, 0]),
            Some([0, 0xab, 0xcd, 1])
        );
        assert_eq!(parse_uid_response(&[1, 2, 3, 4, 5, 6, 7, 0x90, 0]), None);
        assert_eq!(parse_uid_response(&[1, 2, 3, 4, 0x6a, 0x82]), None);
        assert_eq!(parse_uid_response(&[1, 2, 3, 4]), None);
    }

    #[test]
    fn one_scan_per_card_presence() {
        assert!(present(State::PRESENT));
        assert!(!present(State::EMPTY));
        assert!(!present(State::PRESENT | State::UNAVAILABLE));
        assert!(should_scan(State::PRESENT, false, None, 1));
        assert!(!should_scan(State::PRESENT, true, Some(1), 1));
        assert!(should_scan(State::PRESENT, true, Some(1), 3));
        assert!(!should_scan(State::EMPTY, true, Some(1), 3));
    }

    #[test]
    fn control_accepts_shutdown_or_eof_only() {
        assert!(control(&b""[..]));
        assert!(control(&b"{\"type\":\"shutdown\"}\n"[..]));
        assert!(!control(&b"{\"type\":\"scan\"}\n"[..]));
    }
}
