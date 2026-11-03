use serde::Serialize;
use serialport::{DataBits, FlowControl, Parity, StopBits};
use std::io::{self, Read, Write};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Options {
    port: String,
    baud_rate: u32,
    data_bits: DataBits,
    parity: Parity,
    stop_bits: StopBits,
    flow_control: FlowControl,
    format: UidFormat,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UidFormat {
    Hex8,
    Hex,
    Decimal,
    Octal,
    Binary,
}

fn parse_args(args: &[String]) -> Result<Options, ()> {
    if args.len() != 14
        || args[0] != "--port"
        || args[2] != "--baud"
        || args[4] != "--data-bits"
        || args[6] != "--parity"
        || args[8] != "--stop-bits"
        || args[10] != "--flow-control"
        || args[12] != "--format"
    {
        return Err(());
    }
    let port = args[1].trim();
    if port.is_empty() || port.len() > 128 || port.chars().any(|c| c.is_control()) {
        return Err(());
    }
    let baud_rate = args[3].parse::<u32>().map_err(|_| ())?;
    if !(300..=921_600).contains(&baud_rate) {
        return Err(());
    }
    let data_bits = match args[5].as_str() {
        "5" => DataBits::Five,
        "6" => DataBits::Six,
        "7" => DataBits::Seven,
        "8" => DataBits::Eight,
        _ => return Err(()),
    };
    let parity = match args[7].as_str() {
        "none" => Parity::None,
        "odd" => Parity::Odd,
        "even" => Parity::Even,
        _ => return Err(()),
    };
    let stop_bits = match args[9].as_str() {
        "1" => StopBits::One,
        "2" => StopBits::Two,
        _ => return Err(()),
    };
    let flow_control = match args[11].as_str() {
        "none" => FlowControl::None,
        "hardware" => FlowControl::Hardware,
        "software" => FlowControl::Software,
        _ => return Err(()),
    };
    let format = match args[13].as_str() {
        "hex8" => UidFormat::Hex8,
        "hex" => UidFormat::Hex,
        "decimal" => UidFormat::Decimal,
        "octal" => UidFormat::Octal,
        "binary" => UidFormat::Binary,
        _ => return Err(()),
    };
    Ok(Options {
        port: port.into(),
        baud_rate,
        data_bits,
        parity,
        stop_bits,
        flow_control,
        format,
    })
}

fn parse_uid(line: &[u8], format: UidFormat) -> Option<String> {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    let (radix, max_len) = match format {
        UidFormat::Hex8 | UidFormat::Hex => (16, 8),
        UidFormat::Decimal => (10, 10),
        UidFormat::Octal => (8, 11),
        UidFormat::Binary => (2, 32),
    };
    if line.is_empty() || line.len() > max_len || (format == UidFormat::Hex8 && line.len() != 8) {
        return None;
    }
    let value = std::str::from_utf8(line).ok()?;
    if !value
        .bytes()
        .all(|byte| (byte as char).to_digit(radix).is_some())
    {
        return None;
    }
    Some(format!("{:08x}", u32::from_str_radix(value, radix).ok()?))
}

#[derive(Serialize)]
struct Ports {
    ports: Vec<String>,
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

fn read_cards(
    port: &mut dyn serialport::SerialPort,
    control: Receiver<bool>,
    format: UidFormat,
) -> io::Result<()> {
    let mut line = Vec::with_capacity(16);
    let mut bytes = [0u8; 64];
    loop {
        if let Ok(valid) = control.try_recv() {
            return if valid {
                Ok(())
            } else {
                Err(io::Error::other("INVALID_CONTROL"))
            };
        }
        match port.read(&mut bytes) {
            Ok(n) => {
                for byte in &bytes[..n] {
                    if *byte == b'\n' {
                        let uid = parse_uid(&line, format);
                        line.fill(0);
                        line.clear();
                        if let Some(uid) = uid {
                            send(&format!(r#"{{"type":"scan","uidHex":"{uid}"}}"#))?;
                        } else {
                            send(r#"{"type":"error","code":"INVALID_FRAME"}"#)?;
                            bytes.fill(0);
                            return Err(io::Error::other("INVALID_FRAME"));
                        }
                    } else if line.len() < 33 {
                        line.push(*byte);
                    } else {
                        line.fill(0);
                        bytes.fill(0);
                        send(r#"{"type":"error","code":"INVALID_FRAME"}"#)?;
                        return Err(io::Error::other("INVALID_FRAME"));
                    }
                }
                bytes.fill(0);
            }
            Err(error) if error.kind() == io::ErrorKind::TimedOut => continue,
            Err(_) => {
                line.fill(0);
                bytes.fill(0);
                send(r#"{"type":"error","code":"READER_IO"}"#)?;
                return Err(io::Error::other("READER_IO"));
            }
        }
    }
}

fn run() -> Result<(), ()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["--list-ports"] {
        let mut ports: Vec<String> = serialport::available_ports()
            .map_err(|_| ())?
            .into_iter()
            .map(|p| p.port_name)
            .collect();
        ports.sort();
        ports.dedup();
        println!(
            "{}",
            serde_json::to_string(&Ports { ports }).map_err(|_| ())?
        );
        return Ok(());
    }
    let options = parse_args(&args)?;
    let mut port = serialport::new(&options.port, options.baud_rate)
        .data_bits(options.data_bits)
        .parity(options.parity)
        .stop_bits(options.stop_bits)
        .flow_control(options.flow_control)
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|_| ())?;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(control(io::stdin().lock()));
    });
    send(r#"{"type":"ready","protocol":1,"kind":"hardware"}"#).map_err(|_| ())?;
    read_cards(port.as_mut(), receiver, options.format).map_err(|_| ())
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
    fn uid_lines_convert_selected_radix_to_the_same_four_bytes() {
        assert_eq!(
            parse_uid(b"00AbCd01\r", UidFormat::Hex8),
            Some("00abcd01".into())
        );
        assert_eq!(
            parse_uid(b"ABCDEF01", UidFormat::Hex),
            Some("abcdef01".into())
        );
        assert_eq!(parse_uid(b"1", UidFormat::Hex), Some("00000001".into()));
        assert_eq!(parse_uid(b"1", UidFormat::Decimal), Some("00000001".into()));
        assert_eq!(
            parse_uid(b"0000000001", UidFormat::Decimal),
            Some("00000001".into())
        );
        assert_eq!(
            parse_uid(b"4294967295", UidFormat::Decimal),
            Some("ffffffff".into())
        );
        assert_eq!(
            parse_uid(b"37777777777", UidFormat::Octal),
            Some("ffffffff".into())
        );
        assert_eq!(
            parse_uid(b"11111111111111111111111111111111", UidFormat::Binary),
            Some("ffffffff".into())
        );
        assert_eq!(parse_uid(b"0", UidFormat::Binary), Some("00000000".into()));
        for invalid in [b"1".as_slice(), b"0000000g", b" 00000001", b"00000001 "] {
            assert_eq!(parse_uid(invalid, UidFormat::Hex8), None);
        }
        for (input, format) in [
            ("4294967296", UidFormat::Decimal),
            ("40000000000", UidFormat::Octal),
            ("100000000000000000000000000000000", UidFormat::Binary),
            ("100000000", UidFormat::Hex),
            ("0x1", UidFormat::Hex),
            ("+1", UidFormat::Decimal),
            ("1.0", UidFormat::Decimal),
            ("8", UidFormat::Octal),
            ("2", UidFormat::Binary),
        ] {
            assert_eq!(parse_uid(input.as_bytes(), format), None);
        }
    }

    #[test]
    fn control_accepts_only_shutdown_or_eof() {
        assert!(control(&b""[..]));
        assert!(control(&b"{\"type\":\"shutdown\"}\r\n"[..]));
        assert!(!control(&b"{\"type\":\"scan\"}\n"[..]));
    }

    #[test]
    fn serial_settings_are_strict() {
        let valid = [
            "--port",
            "COM3",
            "--baud",
            "9600",
            "--data-bits",
            "8",
            "--parity",
            "none",
            "--stop-bits",
            "1",
            "--flow-control",
            "none",
            "--format",
            "hex8",
        ];
        let args: Vec<String> = valid.iter().map(|s| s.to_string()).collect();
        assert_eq!(parse_args(&args).unwrap().port, "COM3");
        for changed in [3, 5, 7, 9, 11, 13] {
            let mut malformed = args.clone();
            malformed[changed] = "invalid".into();
            assert!(parse_args(&malformed).is_err());
        }
        let mut malformed = args;
        malformed[1] = "".into();
        assert!(parse_args(&malformed).is_err());
    }
}
