//! Agent text passes through [`escape_raw_html`] before `TextView::markdown` (07, Transcript;
//! 05: no raw HTML). Spike S11 found that GPUI Kit 0.7.1's `TextView::markdown` renders raw HTML
//! blocks and inline tags (`<img>`, `<a>`, tables, headings, `<b>` and more).
//!
//! Every `<` becomes `&lt;` unless it sits in code that CommonMark is sure to treat as code:
//! a fenced block or an inline code span. Where the block structure is ambiguous (a fence behind
//! a list or quote marker, or a less indented line inside an indented fence), the rest of the text
//! is escaped everywhere. That can show `&lt;` inside code, but never lets a tag through.
use std::borrow::Cow;

pub fn escape_raw_html(src: &str) -> Cow<'_, str> {
    if !src.contains('<') {
        return Cow::Borrowed(src);
    }
    let mut out = String::with_capacity(src.len() + 32);
    let mut state = State::Normal { group_unsafe: false };
    for line in src.split_inclusive('\n') {
        let body = line.trim_end_matches(['\n', '\r']);
        state = match state {
            State::Uncertain => {
                escape_inline(line, false, &mut out);
                State::Uncertain
            }
            State::InFence(fence) => match fence_line(body, &fence) {
                FenceLine::Content => {
                    out.push_str(line);
                    State::InFence(fence)
                }
                FenceLine::Close => {
                    out.push_str(line);
                    State::Normal { group_unsafe: false }
                }
                FenceLine::Ambiguous => {
                    escape_inline(line, false, &mut out);
                    State::Uncertain
                }
            },
            State::Normal { group_unsafe } => {
                if let Some(fence) = opening_fence(body) {
                    out.push_str(line);
                    State::InFence(fence)
                } else if fence_like(body) {
                    escape_inline(line, false, &mut out);
                    State::Uncertain
                } else if body.trim().is_empty() {
                    out.push_str(line);
                    State::Normal { group_unsafe: false }
                } else {
                    let unmatched = escape_inline(line, !group_unsafe, &mut out);
                    State::Normal { group_unsafe: group_unsafe || unmatched }
                }
            }
        };
    }
    Cow::Owned(out)
}

enum State {
    /// `group_unsafe`: an earlier line of this paragraph left a backtick run open, so a code
    /// span may continue onto this line.
    Normal { group_unsafe: bool },
    InFence(Fence),
    Uncertain,
}

struct Fence {
    ch: u8,
    len: usize,
    indent: usize,
}

enum FenceLine {
    Content,
    Close,
    Ambiguous,
}

/// Leading indentation in columns (tab stops of 4) and its length in bytes.
fn indent(line: &str) -> (usize, usize) {
    let mut col = 0;
    let mut bytes = 0;
    for b in line.bytes() {
        match b {
            b' ' => col += 1,
            b'\t' => col += 4 - col % 4,
            _ => break,
        }
        bytes += 1;
    }
    (col, bytes)
}

fn run_len(s: &str, ch: u8) -> usize {
    s.bytes().take_while(|&b| b == ch).count()
}

/// A bare fence opener: up to 3 columns of indentation and nothing else before it.
fn opening_fence(line: &str) -> Option<Fence> {
    let (col, start) = indent(line);
    if col > 3 {
        return None;
    }
    let rest = &line[start..];
    let ch = *rest.as_bytes().first()?;
    if ch != b'`' && ch != b'~' {
        return None;
    }
    let len = run_len(rest, ch);
    if len < 3 || (ch == b'`' && rest[len..].contains('`')) {
        return None;
    }
    Some(Fence { ch, len, indent: col })
}

/// A run of 3 or more backticks or tildes after list or quote markers, or any other spot where
/// a fence may open that `opening_fence` does not accept.
fn fence_like(line: &str) -> bool {
    let rest = line.trim_start_matches(|c: char| {
        c.is_ascii_whitespace() || c.is_ascii_digit() || matches!(c, '>' | '-' | '+' | '*' | '.' | ')')
    });
    rest.starts_with("```") || rest.starts_with("~~~")
}

/// The fence may sit inside a list item whose content indent is anywhere from 0 to
/// `fence.indent`; a line is content or a closer only when every such reading agrees.
fn fence_line(line: &str, fence: &Fence) -> FenceLine {
    if line.trim().is_empty() {
        return FenceLine::Content;
    }
    let (col, start) = indent(line);
    let rest = &line[start..];
    let run = run_len(rest, fence.ch);
    let closer_like = run >= fence.len && rest[run..].trim_matches([' ', '\t']).is_empty();
    match (closer_like, fence.indent) {
        (true, 0) if col <= 3 => FenceLine::Close,
        (_, 0) => FenceLine::Content,
        (true, _) if col >= fence.indent && col <= 3 => FenceLine::Close,
        (true, _) if col > fence.indent + 3 => FenceLine::Content,
        (true, _) => FenceLine::Ambiguous,
        (false, _) if col >= fence.indent => FenceLine::Content,
        (false, _) => FenceLine::Ambiguous,
    }
}

/// Escapes `<` in one line. With `honor_spans`, code spans closed on this line are copied as
/// they are. Returns true when a backtick run stayed open, or a backslash came before one.
fn escape_inline(line: &str, honor_spans: bool, out: &mut String) -> bool {
    let b = line.as_bytes();
    let mut honor = honor_spans;
    let mut unmatched = false;
    let mut copied = 0;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\\' => {
                if b.get(i + 1) == Some(&b'`') {
                    honor = false;
                    unmatched = true;
                }
                i += 2;
            }
            b'`' => {
                let n = run_len(&line[i..], b'`');
                match honor.then(|| closing_run(b, i + n, n)).flatten() {
                    Some(end) => i = end,
                    None => {
                        unmatched = true;
                        i += n;
                    }
                }
            }
            b'<' => {
                out.push_str(&line[copied..i]);
                out.push_str("&lt;");
                i += 1;
                copied = i;
            }
            _ => i += 1,
        }
    }
    out.push_str(&line[copied.min(line.len())..]);
    unmatched
}

/// The end of the next run of exactly `n` backticks from `from`. A `|` stops the search,
/// because a GFM table splits its cells before it parses code spans.
fn closing_run(b: &[u8], from: usize, n: usize) -> Option<usize> {
    let mut j = from;
    while j < b.len() {
        match b[j] {
            b'|' => return None,
            b'`' => {
                let m = b[j..].iter().take_while(|&&c| c == b'`').count();
                if m == n {
                    return Some(j + m);
                }
                j += m;
            }
            _ => j += 1,
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::escape_raw_html as esc;

    #[test]
    fn text_without_angle_brackets_is_borrowed() {
        assert!(matches!(esc("plain **text**"), std::borrow::Cow::Borrowed(_)));
    }

    #[test]
    fn tags_in_text_are_escaped() {
        assert_eq!(esc("hi <img src=x onerror=y>"), "hi &lt;img src=x onerror=y>");
        assert_eq!(esc("<div>\nblock\n</div>\n"), "&lt;div>\nblock\n&lt;/div>\n");
        assert_eq!(esc("a <b>bold</b>"), "a &lt;b>bold&lt;/b>");
    }

    #[test]
    fn fenced_code_is_left_alone() {
        let src = "x <a>\n```rust\nlet v: Vec<u8> = vec![];\n```\nafter <i>\n";
        assert_eq!(esc(src), "x &lt;a>\n```rust\nlet v: Vec<u8> = vec![];\n```\nafter &lt;i>\n");
        let tilde = "~~~ info `ok`\n<b>\n~~~~\n<b>";
        assert_eq!(esc(tilde), "~~~ info `ok`\n<b>\n~~~~\n&lt;b>");
    }

    #[test]
    fn an_unclosed_fence_runs_to_the_end_like_commonmark() {
        assert_eq!(esc("```\n<b>\nstill code <i>"), "```\n<b>\nstill code <i>");
    }

    #[test]
    fn inline_code_is_left_alone() {
        assert_eq!(esc("use `Vec<T>` and <b>"), "use `Vec<T>` and &lt;b>");
        assert_eq!(esc("``a ` <b>`` x"), "``a ` <b>`` x");
    }

    #[test]
    fn a_span_that_may_cross_lines_is_escaped() {
        assert_eq!(esc("a `b\nc` <img> `d`"), "a `b\nc` &lt;img> `d`");
        assert_eq!(esc("a `b\n\n`<i>`"), "a `b\n\n`<i>`");
    }

    #[test]
    fn backslashes() {
        assert_eq!(esc(r"\<b>"), r"\<b>");
        assert_eq!(esc(r"\\<b>"), r"\\&lt;b>");
        assert_eq!(esc(r"\`<b>`"), r"\`&lt;b>`");
    }

    #[test]
    fn table_pipes_stop_a_span() {
        assert_eq!(esc("| `a | <img> | b` |"), "| `a | &lt;img> | b` |");
        assert_eq!(esc("| `Vec<T>` | x |"), "| `Vec<T>` | x |");
    }

    #[test]
    fn a_fence_in_a_list_item_keeps_its_code() {
        let src = "1. Run:\n   ```sh\n   echo <x>\n   ```\n2. Then <b>\n";
        assert_eq!(esc(src), "1. Run:\n   ```sh\n   echo <x>\n   ```\n2. Then &lt;b>\n");
    }

    #[test]
    fn ambiguous_blocks_escape_the_rest() {
        assert_eq!(
            esc("- ```\n  <b>\n  ```\n  <img src=x>"),
            "- ```\n  &lt;b>\n  ```\n  &lt;img src=x>"
        );
        assert_eq!(
            esc("  ```\nfoo\n  ```\n  <img src=x>"),
            "  ```\nfoo\n  ```\n  &lt;img src=x>"
        );
        assert_eq!(esc("> ```\n> <b>\n```\n<i>"), "> ```\n> &lt;b>\n```\n&lt;i>");
        assert_eq!(esc("``` a`b\n<b>\n```\n<i>"), "``` a`b\n&lt;b>\n```\n&lt;i>");
    }

    #[test]
    fn crlf_lines() {
        assert_eq!(esc("```\r\n<b>\r\n```\r\n<i>\r\n"), "```\r\n<b>\r\n```\r\n&lt;i>\r\n");
    }

    #[test]
    fn multibyte_text_survives() {
        assert_eq!(esc("héllo <b> 日本 `<x>` ✓"), "héllo &lt;b> 日本 `<x>` ✓");
    }
}
