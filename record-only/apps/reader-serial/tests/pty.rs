#![cfg(unix)]

use serialport::{SerialPort, TTYPort};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

#[test]
fn actual_serial_port_delivers_lines_and_stops_on_shutdown() {
    let (mut master, slave) = TTYPort::pair().unwrap();
    let port_name = slave.name().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_cyez-reader-serial"))
        .args([
            "--port",
            &port_name,
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
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let (sender, receiver) = mpsc::channel();
    let output = child.stdout.take().unwrap();
    std::thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            let _ = sender.send(line.unwrap());
        }
    });
    let next = || receiver.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(next(), r#"{"type":"ready","protocol":1,"kind":"hardware"}"#);
    master.write_all(b"00Ab").unwrap();
    master.write_all(b"Cd01\r\nffffffff\n").unwrap();
    assert_eq!(next(), r#"{"type":"scan","uidHex":"00abcd01"}"#);
    assert_eq!(next(), r#"{"type":"scan","uidHex":"ffffffff"}"#);
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"{\"type\":\"shutdown\"}\n")
        .unwrap();
    assert!(child.wait().unwrap().success());
}

#[test]
fn invalid_serial_line_is_rejected_without_emitting_a_scan() {
    let (mut master, slave) = TTYPort::pair().unwrap();
    let port_name = slave.name().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_cyez-reader-serial"))
        .args([
            "--port",
            &port_name,
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
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    output.read_line(&mut line).unwrap();
    assert!(line.contains("\"ready\""));
    master.write_all(b"not-a-uid\n").unwrap();
    line.clear();
    output.read_line(&mut line).unwrap();
    assert_eq!(line.trim(), r#"{"type":"error","code":"INVALID_FRAME"}"#);
    assert!(!child.wait().unwrap().success());
}

#[test]
fn decimal_serial_lines_are_normalized_and_overflow_fails() {
    let (mut master, slave) = TTYPort::pair().unwrap();
    let port_name = slave.name().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_cyez-reader-serial"))
        .args([
            "--port",
            &port_name,
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
            "decimal",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    output.read_line(&mut line).unwrap();
    assert!(line.contains("\"ready\""));
    master.write_all(b"1\r\n4294967295\n4294967296\n").unwrap();
    for expected in [
        r#"{"type":"scan","uidHex":"00000001"}"#,
        r#"{"type":"scan","uidHex":"ffffffff"}"#,
        r#"{"type":"error","code":"INVALID_FRAME"}"#,
    ] {
        line.clear();
        output.read_line(&mut line).unwrap();
        assert_eq!(line.trim(), expected);
    }
    assert!(!child.wait().unwrap().success());
}
