#![cfg_attr(windows, windows_subsystem = "windows")]

fn parse_uid(text: &str) -> Option<u32> {
    let value = text.trim();
    if value.len() != 8 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    u32::from_str_radix(value, 16).ok()
}

fn wiegand34_frame(uid: u32) -> u64 {
    let upper = uid >> 16;
    let lower = uid & 0xffff;
    let leading_even = (upper.count_ones() % 2) as u64;
    let trailing_odd = (1 - lower.count_ones() % 2) as u64;
    (leading_even << 33) | ((uid as u64) << 1) | trailing_odd
}

fn wiegand34_uid(frame: u64) -> Option<u32> {
    if frame >= (1u64 << 34) {
        return None;
    }
    let uid = ((frame >> 1) & 0xffff_ffff) as u32;
    let valid_leading = ((frame >> 33) & 1) == (uid >> 16).count_ones() as u64 % 2;
    let valid_trailing = (frame & 1) == (1 - (uid & 0xffff).count_ones() % 2) as u64;
    (valid_leading && valid_trailing).then_some(uid)
}

// Commands are bounded and canonical. EOF also means the parent has gone away.
fn wait_for_shutdown(input: impl std::io::Read) -> bool {
    use std::io::BufRead;
    let mut line = String::new();
    match std::io::BufReader::new(input.take(257)).read_line(&mut line) {
        Ok(0) => true,
        Ok(n) if n <= 256 => {
            line == "{\"type\":\"shutdown\"}\n" || line == "{\"type\":\"shutdown\"}\r\n"
        }
        _ => false,
    }
}

#[cfg(windows)]
fn send(message: &str) -> std::io::Result<()> {
    use std::io::Write;
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    writeln!(output, "{message}")?;
    output.flush()
}

#[cfg(windows)]
fn main() {
    use native_windows_gui as nwg;
    use std::rc::Rc;

    let args: Vec<String> = std::env::args().collect();
    if args.len() == 3 && args[1] == "--test-uid" {
        let Some(uid) = parse_uid(&args[2]) else {
            std::process::exit(2);
        };
        let uid = wiegand34_uid(wiegand34_frame(uid)).expect("generated parity");
        if send(r#"{"type":"ready","protocol":1,"kind":"mock"}"#).is_err()
            || send(&format!(r#"{{"type":"scan","uidHex":"{uid:08x}"}}"#)).is_err()
        {
            std::process::exit(3);
        }
        return;
    }
    if args.len() != 1 {
        std::process::exit(2);
    }
    nwg::init().expect("GUI_INIT_FAILED");
    nwg::Font::set_global_family("Segoe UI").expect("FONT_INIT_FAILED");

    let mut window = nwg::Window::default();
    let mut label = nwg::Label::default();
    let mut input = nwg::TextInput::default();
    let mut button = nwg::Button::default();
    let mut status = nwg::Label::default();
    nwg::Window::builder()
        .flags(nwg::WindowFlags::WINDOW | nwg::WindowFlags::VISIBLE)
        .size((380, 180))
        .position((300, 260))
        .title("Wiegand-34 UID Mock")
        .build(&mut window)
        .expect("WINDOW_INIT_FAILED");
    nwg::Label::builder()
        .text("UID (8 hex digits, 32 data bits)")
        .position((20, 16))
        .size((330, 24))
        .parent(&window)
        .build(&mut label)
        .expect("LABEL_INIT_FAILED");
    nwg::TextInput::builder()
        .text("")
        .limit(64)
        .position((20, 45))
        .size((225, 30))
        .focus(true)
        .parent(&window)
        .build(&mut input)
        .expect("INPUT_INIT_FAILED");
    nwg::Button::builder()
        .text("Send scan")
        .position((260, 45))
        .size((95, 30))
        .parent(&window)
        .build(&mut button)
        .expect("BUTTON_INIT_FAILED");
    nwg::Label::builder()
        .text("Enter a UID, then send it to the teacher app.")
        .position((20, 91))
        .size((335, 45))
        .parent(&window)
        .build(&mut status)
        .expect("STATUS_INIT_FAILED");

    // Explicitly show the GUI even when the spawning Node process hides consoles.
    window.set_visible(true);

    let window = Rc::new(window);
    let event_window = window.clone();
    let handler = nwg::full_bind_event_handler(&window.handle, move |event, _, handle| {
        if event == nwg::Event::OnWindowClose && &handle == &event_window.handle {
            nwg::stop_thread_dispatch();
        } else if event == nwg::Event::OnButtonClick && &handle == &button.handle {
            match parse_uid(&input.text()) {
                Some(uid) => {
                    let uid = wiegand34_uid(wiegand34_frame(uid)).expect("generated parity");
                    if send(&format!(r#"{{"type":"scan","uidHex":"{uid:08x}"}}"#)).is_ok() {
                        status.set_text("Scan sent.");
                        input.set_text("");
                    } else {
                        status.set_text("Teacher app disconnected.");
                    }
                }
                None => status.set_text("Enter exactly 8 hexadecimal digits (0-9, A-F)."),
            }
        }
    });

    std::thread::spawn(|| {
        std::process::exit(if wait_for_shutdown(std::io::stdin().lock()) {
            0
        } else {
            2
        });
    });
    if send(r#"{"type":"ready","protocol":1,"kind":"mock"}"#).is_err() {
        std::process::exit(3);
    }
    nwg::dispatch_thread_events();
    nwg::unbind_event_handler(&handler);
}

#[cfg(not(windows))]
fn main() {
    eprintln!("The mock reader window requires Windows.");
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uid_is_exactly_four_bytes_and_preserves_leading_zeroes() {
        assert_eq!(parse_uid("00000001"), Some(1));
        assert_eq!(parse_uid("ABCDEF01"), Some(0xabcdef01));
        assert_eq!(parse_uid("1234567"), None);
        assert_eq!(parse_uid("123456789"), None);
        assert_eq!(parse_uid("12 45678"), None);
    }

    #[test]
    fn generated_wiegand34_parity_is_verified() {
        for uid in [0, 1, 0x12345678, 0xffffffff] {
            let frame = wiegand34_frame(uid);
            assert_eq!(wiegand34_uid(frame), Some(uid));
            assert_eq!(wiegand34_uid(frame ^ (1 << 33)), None);
            assert_eq!(wiegand34_uid(frame ^ 1), None);
        }
        assert_eq!(wiegand34_uid(1 << 34), None);
    }

    #[test]
    fn shutdown_or_parent_eof_exits_without_accepting_other_commands() {
        assert!(wait_for_shutdown(&b"{\"type\":\"shutdown\"}\n"[..]));
        assert!(wait_for_shutdown(&b"{\"type\":\"shutdown\"}\r\n"[..]));
        assert!(wait_for_shutdown(&b""[..]));
        assert!(!wait_for_shutdown(&b"{\"type\":\"scan\"}\n"[..]));
        assert!(!wait_for_shutdown(&vec![b'x'; 300][..]));
    }
}
