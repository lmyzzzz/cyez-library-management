use pcsc::{Context, Error, Protocols, ReaderState, Scope, ShareMode, State};
use serde::Serialize;
use std::ffi::{CStr, CString};
use std::io::{self, Read, Write};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

const GET_UID: [u8; 5] = [0xff, 0xca, 0x00, 0x00, 0x00];

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum UidByteOrder {
    Forward,
    Reverse,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum CardProtocol {
    Auto,
    T0,
    T1,
}

impl CardProtocol {
    fn pcsc(self) -> Protocols {
        match self {
            Self::Auto => Protocols::ANY,
            Self::T0 => Protocols::T0,
            Self::T1 => Protocols::T1,
        }
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum AccessMode {
    Shared,
    Exclusive,
}

impl AccessMode {
    fn pcsc(self) -> ShareMode {
        match self {
            Self::Shared => ShareMode::Shared,
            Self::Exclusive => ShareMode::Exclusive,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Options {
    reader: String,
    poll_ms: u64,
    uid_byte_order: UidByteOrder,
    protocol: CardProtocol,
    access_mode: AccessMode,
}

#[derive(Serialize)]
struct Readers {
    readers: Vec<String>,
}

fn supported_reader(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    upper.contains("ACR1552") && upper.contains("PICC") && !upper.contains("SAM")
}

// The teacher schema accepts non-empty names of at most 128 bytes without control characters.
fn valid_reader_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 128 && !name.chars().any(char::is_control)
}

fn parse_args(args: &[String]) -> Result<Options, ()> {
    if args.len() % 2 != 0 {
        return Err(());
    }
    let mut reader = None;
    let mut poll_ms = None;
    let mut uid_byte_order = None;
    let mut protocol = None;
    let mut access_mode = None;
    for pair in args.chunks_exact(2) {
        match pair[0].as_str() {
            "--reader" if reader.is_none() => reader = Some(pair[1].clone()),
            "--poll-ms" if poll_ms.is_none() => {
                poll_ms = Some(pair[1].parse::<u64>().map_err(|_| ())?);
            }
            "--uid-byte-order" if uid_byte_order.is_none() => {
                uid_byte_order = Some(match pair[1].as_str() {
                    "forward" => UidByteOrder::Forward,
                    "reverse" => UidByteOrder::Reverse,
                    _ => return Err(()),
                });
            }
            "--protocol" if protocol.is_none() => {
                protocol = Some(match pair[1].as_str() {
                    "auto" => CardProtocol::Auto,
                    "t0" => CardProtocol::T0,
                    "t1" => CardProtocol::T1,
                    _ => return Err(()),
                });
            }
            "--access-mode" if access_mode.is_none() => {
                access_mode = Some(match pair[1].as_str() {
                    "shared" => AccessMode::Shared,
                    "exclusive" => AccessMode::Exclusive,
                    _ => return Err(()),
                });
            }
            _ => return Err(()),
        }
    }
    let reader = reader.ok_or(())?;
    if !valid_reader_name(&reader) || !supported_reader(&reader) {
        return Err(());
    }
    let poll_ms = poll_ms.ok_or(())?;
    if !(100..=2000).contains(&poll_ms) {
        return Err(());
    }
    Ok(Options {
        reader,
        poll_ms,
        uid_byte_order: uid_byte_order.unwrap_or(UidByteOrder::Forward),
        protocol: protocol.unwrap_or(CardProtocol::Auto),
        access_mode: access_mode.unwrap_or(AccessMode::Shared),
    })
}

fn parse_uid_response(response: &[u8], order: UidByteOrder) -> Option<[u8; 4]> {
    if response.len() != 6 || response[4..] != [0x90, 0x00] {
        return None;
    }
    let mut uid: [u8; 4] = response[..4].try_into().ok()?;
    if order == UidByteOrder::Reverse {
        uid.reverse();
    }
    Some(uid)
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
        .filter(|name| valid_reader_name(name) && supported_reader(name))
        .map(str::to_owned)
        .collect();
    names.sort();
    names.dedup();
    Ok(names)
}

fn read_uid(context: &Context, reader: &CStr, options: &Options) -> Result<Option<[u8; 4]>, Error> {
    let card = context.connect(reader, options.access_mode.pcsc(), options.protocol.pcsc())?;
    let mut response = [0u8; 32];
    let result = card
        .transmit(&GET_UID, &mut response)
        .map(|response| parse_uid_response(response, options.uid_byte_order));
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
    let reader = CString::new(options.reader.as_str()).map_err(|_| ())?;
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
            match read_uid(context, &reader, &options) {
                Ok(Some(mut uid)) => {
                    // Consume the presence only after a successful UID read, so
                    // transient errors retry the same presence on the next poll.
                    scanned = true;
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
        let output = serde_json::to_string(&Readers { readers }).map_err(|_| ())?;
        send(&output).map_err(|_| ())?;
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
        let defaults = parse_args(&args).unwrap();
        assert_eq!(defaults.poll_ms, 250);
        assert_eq!(defaults.uid_byte_order, UidByteOrder::Forward);
        assert_eq!(defaults.protocol.pcsc(), Protocols::ANY);
        assert_eq!(defaults.access_mode.pcsc(), ShareMode::Shared);
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
    fn optional_settings_are_strict_and_map_to_pcsc_parameters() {
        let args = [
            "--reader",
            "ACS ACR1552U PICC 0",
            "--poll-ms",
            "250",
            "--uid-byte-order",
            "reverse",
            "--protocol",
            "t1",
            "--access-mode",
            "exclusive",
        ]
        .map(str::to_owned);
        let options = parse_args(&args).unwrap();
        assert_eq!(options.uid_byte_order, UidByteOrder::Reverse);
        assert_eq!(options.protocol.pcsc(), Protocols::T1);
        assert_eq!(options.access_mode.pcsc(), ShareMode::Exclusive);
        let mut t0 = args.clone();
        t0[7] = "t0".into();
        assert_eq!(parse_args(&t0).unwrap().protocol.pcsc(), Protocols::T0);
        for (index, value) in [(5, "decimal"), (7, "raw"), (9, "direct"), (4, "--unknown")] {
            let mut bad = args.clone();
            bad[index] = value.into();
            assert!(parse_args(&bad).is_err());
        }
        let mut duplicate = args.to_vec();
        duplicate.extend(["--uid-byte-order".into(), "forward".into()]);
        assert!(parse_args(&duplicate).is_err());
        assert!(parse_args(&args[..9]).is_err());
        assert!(parse_args(&[]).is_err());
    }

    #[test]
    fn uid_response_requires_exactly_four_bytes_and_success_status() {
        assert_eq!(
            parse_uid_response(&[0, 0xab, 0xcd, 1, 0x90, 0], UidByteOrder::Forward),
            Some([0, 0xab, 0xcd, 1])
        );
        for order in [UidByteOrder::Forward, UidByteOrder::Reverse] {
            for response in [
                &[1, 2, 3, 4, 5, 6, 7, 0x90, 0][..],
                &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0x90, 0][..],
                &[1, 2, 3, 4, 0x6a, 0x82][..],
                &[1, 2, 3, 4][..],
                &[][..],
            ] {
                assert_eq!(parse_uid_response(response, order), None);
            }
        }
    }

    #[test]
    fn byte_order_changes_only_the_four_uid_bytes_and_keeps_all_bits() {
        let response = [1, 2, 3, 4, 0x90, 0];
        let forward = parse_uid_response(&response, UidByteOrder::Forward).unwrap();
        let reverse = parse_uid_response(&response, UidByteOrder::Reverse).unwrap();
        assert_eq!(forward, [1, 2, 3, 4]);
        assert_eq!(reverse, [4, 3, 2, 1]);
        // The server's decimal conversion interprets the normalized bytes as big endian.
        assert_eq!(u32::from_be_bytes(forward).to_string(), "16909060");
        assert_eq!(u32::from_be_bytes(reverse).to_string(), "67305985");
        assert_eq!(
            parse_uid_response(&[1, 0xcd, 0xab, 0, 0x90, 0], UidByteOrder::Reverse),
            Some([0, 0xab, 0xcd, 1])
        );
        assert_eq!(
            parse_uid_response(&[0xff, 0xff, 0xff, 0xff, 0x90, 0], UidByteOrder::Reverse),
            Some([0xff; 4])
        );
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
