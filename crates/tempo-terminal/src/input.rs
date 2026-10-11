//! Keystrokes and pasted text to the bytes a shell expects (xterm conventions).
use alacritty_terminal::term::TermMode;
use gpui_kit::{Keystroke, Modifiers};

/// Whether the keystroke is a ⌘ shortcut. Those leave the terminal (07, Terminal); every
/// other key goes to the shell.
pub fn is_app_shortcut(keystroke: &Keystroke) -> bool {
    keystroke.modifiers.platform
}

/// The xterm modifier parameter: 1 + shift 1 + alt 2 + control 4. `None` with no modifier.
fn modifier_param(modifiers: &Modifiers) -> Option<u8> {
    let bits =
        u8::from(modifiers.shift) + 2 * u8::from(modifiers.alt) + 4 * u8::from(modifiers.control);
    (bits > 0).then_some(bits + 1)
}

/// `CSI 1;m <final>` with modifiers, else `SS3 <final>` (application mode) or `CSI <final>`.
fn cursor_key(final_byte: char, ss3: bool, modifiers: &Modifiers) -> Vec<u8> {
    match modifier_param(modifiers) {
        Some(m) => format!("\x1b[1;{m}{final_byte}").into_bytes(),
        None if ss3 => format!("\x1bO{final_byte}").into_bytes(),
        None => format!("\x1b[{final_byte}").into_bytes(),
    }
}

/// `CSI n ~`, or `CSI n;m ~` with modifiers.
fn tilde_key(code: u8, modifiers: &Modifiers) -> Vec<u8> {
    match modifier_param(modifiers) {
        Some(m) => format!("\x1b[{code};{m}~").into_bytes(),
        None => format!("\x1b[{code}~").into_bytes(),
    }
}

fn with_alt(alt: bool, mut bytes: Vec<u8>) -> Vec<u8> {
    if alt {
        bytes.insert(0, 0x1b);
    }
    bytes
}

fn control_byte(ch: char) -> Option<u8> {
    match ch {
        'a'..='z' => Some(ch as u8 - b'a' + 1),
        'A'..='Z' => Some(ch as u8 - b'A' + 1),
        '@' | ' ' | '2' => Some(0x00),
        '[' | '3' => Some(0x1b),
        '\\' | '4' => Some(0x1c),
        ']' | '5' => Some(0x1d),
        '^' | '6' => Some(0x1e),
        '_' | '-' | '7' => Some(0x1f),
        '?' | '8' => Some(0x7f),
        _ => None,
    }
}

/// Converts a keystroke to the bytes for the shell, or `None` when it sends nothing (⌘
/// shortcuts, bare modifiers, unknown keys).
///
/// `option_as_meta`: Option sends ESC + key. Otherwise Option types the character macOS
/// composed (Option-L is `@` on a German layout), and sends ESC + key only when it composed
/// none.
pub fn keystroke_to_bytes(
    keystroke: &Keystroke,
    mode: TermMode,
    option_as_meta: bool,
) -> Option<Vec<u8>> {
    let mods = &keystroke.modifiers;
    if mods.platform {
        return None;
    }
    let app_cursor = mode.contains(TermMode::APP_CURSOR);
    let bytes = match keystroke.key.as_str() {
        "enter" => with_alt(mods.alt, b"\r".to_vec()),
        "escape" => with_alt(mods.alt, b"\x1b".to_vec()),
        "backspace" if mods.control => with_alt(mods.alt, vec![0x08]),
        "backspace" => with_alt(mods.alt, vec![0x7f]),
        "tab" if mods.shift => b"\x1b[Z".to_vec(),
        "tab" => with_alt(mods.alt, b"\t".to_vec()),
        "space" if mods.control => with_alt(mods.alt, vec![0x00]),
        "space" => with_alt(mods.alt, b" ".to_vec()),
        "up" => cursor_key('A', app_cursor, mods),
        "down" => cursor_key('B', app_cursor, mods),
        "right" => cursor_key('C', app_cursor, mods),
        "left" => cursor_key('D', app_cursor, mods),
        "home" => cursor_key('H', app_cursor, mods),
        "end" => cursor_key('F', app_cursor, mods),
        "insert" => tilde_key(2, mods),
        "delete" => tilde_key(3, mods),
        "pageup" => tilde_key(5, mods),
        "pagedown" => tilde_key(6, mods),
        "f1" => cursor_key('P', true, mods),
        "f2" => cursor_key('Q', true, mods),
        "f3" => cursor_key('R', true, mods),
        "f4" => cursor_key('S', true, mods),
        key => {
            if let Some(code) = function_key_code(key) {
                tilde_key(code, mods)
            } else {
                return character_bytes(keystroke, option_as_meta);
            }
        }
    };
    Some(bytes)
}

fn function_key_code(key: &str) -> Option<u8> {
    let n: u8 = key.strip_prefix('f')?.parse().ok()?;
    const CODES: [u8; 16] = [
        15, 17, 18, 19, 20, 21, 23, 24, 25, 26, 28, 29, 31, 32, 33, 34,
    ];
    CODES.get(usize::from(n.checked_sub(5)?)).copied()
}

fn character_bytes(keystroke: &Keystroke, option_as_meta: bool) -> Option<Vec<u8>> {
    let mods = &keystroke.modifiers;
    let key = keystroke.key.as_str();
    let mut chars = key.chars();
    let single = chars.next().filter(|_| chars.as_str().is_empty());

    if mods.control {
        let ch = single?;
        let base = if mods.shift { shifted(ch) } else { ch };
        let byte = control_byte(base).or_else(|| control_byte(ch))?;
        return Some(with_alt(mods.alt, vec![byte]));
    }

    let unmodified = single.map(|ch| if mods.shift { shifted(ch) } else { ch });
    if mods.alt {
        let composed = keystroke
            .key_char
            .as_deref()
            .filter(|typed| Some(*typed) != unmodified.map(String::from).as_deref());
        if let (false, Some(typed)) = (option_as_meta, composed) {
            return Some(typed.as_bytes().to_vec());
        }
        let ch = unmodified?;
        let mut buf = [0; 4];
        return Some(with_alt(true, ch.encode_utf8(&mut buf).as_bytes().to_vec()));
    }

    if let Some(typed) = keystroke.key_char.as_deref().filter(|s| !s.is_empty()) {
        return Some(typed.as_bytes().to_vec());
    }
    let ch = unmodified?;
    let mut buf = [0; 4];
    Some(ch.encode_utf8(&mut buf).as_bytes().to_vec())
}

/// US-layout shift, for keystrokes that carry no typed character (tests, synthetic events).
fn shifted(ch: char) -> char {
    match ch {
        'a'..='z' => ch.to_ascii_uppercase(),
        '1' => '!',
        '2' => '@',
        '3' => '#',
        '4' => '$',
        '5' => '%',
        '6' => '^',
        '7' => '&',
        '8' => '*',
        '9' => '(',
        '0' => ')',
        '-' => '_',
        '=' => '+',
        '[' => '{',
        ']' => '}',
        '\\' => '|',
        ';' => ':',
        '\'' => '"',
        ',' => '<',
        '.' => '>',
        '/' => '?',
        '`' => '~',
        other => other,
    }
}

/// Pasted text for the shell. With bracketed paste on, it is wrapped in `ESC [200~` and
/// `ESC [201~`, and ESC is removed so the text cannot end the paste early. Without it, line
/// breaks become carriage returns, as typed.
pub fn paste_bytes(text: &str, mode: TermMode) -> Vec<u8> {
    if mode.contains(TermMode::BRACKETED_PASTE) {
        let mut out = b"\x1b[200~".to_vec();
        out.extend(text.bytes().filter(|&b| b != 0x1b));
        out.extend_from_slice(b"\x1b[201~");
        out
    } else {
        text.replace("\r\n", "\r").replace('\n', "\r").into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(source: &str) -> Option<Vec<u8>> {
        keys_in(source, TermMode::empty())
    }

    fn keys_in(source: &str, mode: TermMode) -> Option<Vec<u8>> {
        keystroke_to_bytes(&Keystroke::parse(source).unwrap(), mode, false)
    }

    #[test]
    fn enter_backspace_tab_escape_space() {
        assert_eq!(key("enter").unwrap(), b"\r");
        assert_eq!(key("shift-enter").unwrap(), b"\r");
        assert_eq!(key("alt-enter").unwrap(), b"\x1b\r");
        assert_eq!(key("backspace").unwrap(), b"\x7f");
        assert_eq!(key("ctrl-backspace").unwrap(), b"\x08");
        assert_eq!(key("alt-backspace").unwrap(), b"\x1b\x7f");
        assert_eq!(key("tab").unwrap(), b"\t");
        assert_eq!(key("shift-tab").unwrap(), b"\x1b[Z");
        assert_eq!(key("escape").unwrap(), b"\x1b");
        assert_eq!(key("space").unwrap(), b" ");
        assert_eq!(key("ctrl-space").unwrap(), b"\x00");
    }

    #[test]
    fn arrows_in_normal_and_application_cursor_mode() {
        for (name, last) in [("up", 'A'), ("down", 'B'), ("right", 'C'), ("left", 'D')] {
            assert_eq!(key(name).unwrap(), format!("\x1b[{last}").as_bytes());
            assert_eq!(
                keys_in(name, TermMode::APP_CURSOR).unwrap(),
                format!("\x1bO{last}").as_bytes()
            );
        }
        assert_eq!(key("home").unwrap(), b"\x1b[H");
        assert_eq!(keys_in("end", TermMode::APP_CURSOR).unwrap(), b"\x1bOF");
    }

    #[test]
    fn modified_arrows_use_the_xterm_parameter() {
        assert_eq!(key("shift-up").unwrap(), b"\x1b[1;2A");
        assert_eq!(key("alt-left").unwrap(), b"\x1b[1;3D");
        assert_eq!(key("ctrl-right").unwrap(), b"\x1b[1;5C");
        assert_eq!(
            keys_in("ctrl-shift-down", TermMode::APP_CURSOR).unwrap(),
            b"\x1b[1;6B"
        );
        assert_eq!(key("shift-home").unwrap(), b"\x1b[1;2H");
    }

    #[test]
    fn navigation_keys() {
        assert_eq!(key("insert").unwrap(), b"\x1b[2~");
        assert_eq!(key("delete").unwrap(), b"\x1b[3~");
        assert_eq!(key("pageup").unwrap(), b"\x1b[5~");
        assert_eq!(key("pagedown").unwrap(), b"\x1b[6~");
        assert_eq!(key("shift-pageup").unwrap(), b"\x1b[5;2~");
        assert_eq!(key("ctrl-delete").unwrap(), b"\x1b[3;5~");
    }

    #[test]
    fn function_keys() {
        assert_eq!(key("f1").unwrap(), b"\x1bOP");
        assert_eq!(key("f2").unwrap(), b"\x1bOQ");
        assert_eq!(key("f3").unwrap(), b"\x1bOR");
        assert_eq!(key("f4").unwrap(), b"\x1bOS");
        assert_eq!(key("shift-f1").unwrap(), b"\x1b[1;2P");
        let tilde = [
            ("f5", 15),
            ("f6", 17),
            ("f7", 18),
            ("f8", 19),
            ("f9", 20),
            ("f10", 21),
            ("f11", 23),
            ("f12", 24),
            ("f13", 25),
            ("f20", 34),
        ];
        for (name, code) in tilde {
            assert_eq!(
                key(name).unwrap(),
                format!("\x1b[{code}~").as_bytes(),
                "{name}"
            );
        }
        assert_eq!(key("ctrl-f5").unwrap(), b"\x1b[15;5~");
        assert_eq!(key("f21"), None);
        assert_eq!(key("fn"), None);
    }

    #[test]
    fn ctrl_letters_and_symbols() {
        assert_eq!(key("ctrl-a").unwrap(), [0x01]);
        assert_eq!(key("ctrl-c").unwrap(), [0x03]);
        assert_eq!(key("ctrl-d").unwrap(), [0x04]);
        assert_eq!(key("ctrl-z").unwrap(), [0x1a]);
        assert_eq!(key("ctrl-shift-a").unwrap(), [0x01]);
        assert_eq!(key("ctrl-[").unwrap(), [0x1b]);
        assert_eq!(key("ctrl-\\").unwrap(), [0x1c]);
        assert_eq!(key("ctrl-]").unwrap(), [0x1d]);
        assert_eq!(key("ctrl-shift-6").unwrap(), [0x1e]);
        assert_eq!(key("ctrl-shift--").unwrap(), [0x1f]);
        assert_eq!(key("ctrl-shift-2").unwrap(), [0x00]);
        assert_eq!(key("ctrl-shift-/").unwrap(), [0x7f]);
        assert_eq!(key("ctrl-alt-x").unwrap(), [0x1b, 0x18]);
        assert_eq!(key("ctrl-;"), None);
    }

    #[test]
    fn alt_sends_escape_unless_option_composed_a_character() {
        assert_eq!(key("alt-a").unwrap(), b"\x1ba");
        assert_eq!(key("alt-shift-b").unwrap(), b"\x1bB");
        assert_eq!(key("alt-.").unwrap(), b"\x1b.");
        assert_eq!(key("alt-l->@").unwrap(), b"@");
        assert_eq!(key("alt-s->ß").unwrap(), "ß".as_bytes());
        assert_eq!(key("alt-b->b").unwrap(), b"\x1bb");
        let meta = |source: &str| {
            keystroke_to_bytes(&Keystroke::parse(source).unwrap(), TermMode::empty(), true)
        };
        assert_eq!(meta("alt-s->ß").unwrap(), b"\x1bs");
        assert_eq!(meta("alt-b").unwrap(), b"\x1bb");
    }

    #[test]
    fn printable_characters_use_the_typed_character() {
        assert_eq!(key("a").unwrap(), b"a");
        assert_eq!(key("shift-a").unwrap(), b"A");
        assert_eq!(key("shift-1").unwrap(), b"!");
        assert_eq!(key("0").unwrap(), b"0");
        assert_eq!(key("a->ä").unwrap(), "ä".as_bytes());
        assert_eq!(key("shift-2->\"").unwrap(), b"\"");
    }

    #[test]
    fn command_shortcuts_send_nothing() {
        for source in [
            "cmd-c",
            "cmd-v",
            "cmd-k",
            "cmd-shift-d",
            "cmd-alt-up",
            "cmd-1",
        ] {
            let keystroke = Keystroke::parse(source).unwrap();
            assert!(is_app_shortcut(&keystroke), "{source}");
            assert_eq!(key(source), None, "{source}");
        }
        assert!(!is_app_shortcut(&Keystroke::parse("ctrl-tab").unwrap()));
        assert_eq!(key("ctrl-tab").unwrap(), b"\t");
        assert_eq!(key("ctrl-o").unwrap(), [0x0f]);
    }

    #[test]
    fn bare_modifiers_send_nothing() {
        assert_eq!(key("shift"), None);
        assert_eq!(key("control"), None);
        assert_eq!(key("alt"), None);
    }

    #[test]
    fn paste_without_bracketed_mode_turns_newlines_into_returns() {
        assert_eq!(
            paste_bytes("ls\nmake\r\n", TermMode::empty()),
            b"ls\rmake\r"
        );
    }

    #[test]
    fn bracketed_paste_wraps_the_text_and_drops_escapes() {
        assert_eq!(
            paste_bytes("echo hi\nrm\x1b[201~x", TermMode::BRACKETED_PASTE),
            b"\x1b[200~echo hi\nrm[201~x\x1b[201~"
        );
        assert_eq!(
            paste_bytes("", TermMode::BRACKETED_PASTE),
            b"\x1b[200~\x1b[201~"
        );
    }
}
