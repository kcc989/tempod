use sha2::{Digest, Sha256};

pub const MAX_DIFF_LINES: usize = 20_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineKind {
    Header,
    Context,
    Added,
    Removed,
    Meta,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: LineKind,
    pub old: Option<u32>,
    pub new: Option<u32>,
    pub text: String,
}

#[derive(Clone, Debug, Default)]
pub struct ParsedDiff {
    pub lines: Vec<DiffLine>,
    pub hash: String,
    pub split: Vec<SplitRow>,
    pub too_large: bool,
}

fn range_start(s: &str, prefix: char) -> Option<u32> {
    s.strip_prefix(prefix)?.split(',').next()?.parse().ok()
}

pub fn parse(diff: &str) -> ParsedDiff {
    let hash = Sha256::digest(diff.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if diff.lines().count() > MAX_DIFF_LINES {
        return ParsedDiff {
            hash,
            too_large: true,
            ..Default::default()
        };
    }
    let mut lines = Vec::new();
    let (mut old, mut new) = (0, 0);
    let mut in_hunk = false;
    for raw in diff.lines() {
        if raw.starts_with("@@ ") {
            let parts: Vec<_> = raw.split_whitespace().collect();
            in_hunk = parts.len() >= 4 && parts[3] == "@@";
            if in_hunk {
                match (range_start(parts[1], '-'), range_start(parts[2], '+')) {
                    (Some(a), Some(b)) => {
                        old = a;
                        new = b;
                    }
                    _ => in_hunk = false,
                }
            }
            lines.push(DiffLine {
                kind: LineKind::Header,
                old: None,
                new: None,
                text: raw.into(),
            });
            continue;
        }
        let (kind, a, b, text) = if in_hunk {
            match raw.as_bytes().first() {
                Some(b' ') => {
                    let numbers = (Some(old), Some(new));
                    old = old.saturating_add(1);
                    new = new.saturating_add(1);
                    (LineKind::Context, numbers.0, numbers.1, &raw[1..])
                }
                Some(b'+') => {
                    let n = new;
                    new = new.saturating_add(1);
                    (LineKind::Added, None, Some(n), &raw[1..])
                }
                Some(b'-') => {
                    let n = old;
                    old = old.saturating_add(1);
                    (LineKind::Removed, Some(n), None, &raw[1..])
                }
                _ => (LineKind::Meta, None, None, raw),
            }
        } else {
            (LineKind::Meta, None, None, raw)
        };
        lines.push(DiffLine {
            kind,
            old: a,
            new: b,
            text: text.into(),
        });
    }
    let split = split_rows(&lines);
    ParsedDiff {
        split,
        lines,
        hash,
        too_large: false,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SplitRow {
    pub left: Option<DiffLine>,
    pub right: Option<DiffLine>,
}

pub fn split_rows(lines: &[DiffLine]) -> Vec<SplitRow> {
    let mut rows = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if matches!(lines[i].kind, LineKind::Removed | LineKind::Added) {
            let start = i;
            while i < lines.len() && matches!(lines[i].kind, LineKind::Removed | LineKind::Added) {
                i += 1;
            }
            let left: Vec<_> = lines[start..i]
                .iter()
                .filter(|l| l.kind == LineKind::Removed)
                .collect();
            let right: Vec<_> = lines[start..i]
                .iter()
                .filter(|l| l.kind == LineKind::Added)
                .collect();
            for n in 0..left.len().max(right.len()) {
                rows.push(SplitRow {
                    left: left.get(n).map(|l| (*l).clone()),
                    right: right.get(n).map(|l| (*l).clone()),
                });
            }
        } else {
            rows.push(SplitRow {
                left: Some(lines[i].clone()),
                right: Some(lines[i].clone()),
            });
            i += 1;
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hunks_preserve_sides_and_no_newline_marker() {
        let d = parse(
            "--- a/a\n+++ b/a\n@@ -2,2 +3,3 @@\n same\n-old\n+new\n+extra\n\\ No newline at end of file\n@@ -8 +9 @@\n-tail\n+end",
        );
        assert_eq!((d.lines[3].old, d.lines[3].new), (Some(2), Some(3)));
        assert_eq!((d.lines[4].old, d.lines[4].new), (Some(3), None));
        assert_eq!((d.lines[6].old, d.lines[6].new), (None, Some(5)));
        assert_eq!(d.lines[7].kind, LineKind::Meta);
        assert_eq!(d.lines[9].old, Some(8));
        let split = split_rows(&d.lines);
        assert!(
            split
                .iter()
                .any(|r| r.left.is_none() && r.right.as_ref().is_some_and(|l| l.text == "extra"))
        );
    }
    #[test]
    fn added_deleted_binary_and_renamed_files() {
        assert_eq!(parse("@@ -0,0 +1 @@\n+hello").lines[1].new, Some(1));
        assert_eq!(parse("@@ -1 +0,0 @@\n-bye").lines[1].old, Some(1));
        assert!(
            parse("rename from a\nrename to b\nBinary files differ")
                .lines
                .iter()
                .all(|l| l.kind == LineKind::Meta)
        );
    }
    #[test]
    fn fallback_and_hash_invalidation() {
        assert!(parse(&"+x\n".repeat(MAX_DIFF_LINES + 1)).too_large);
        assert!(!parse(&"+x\n".repeat(MAX_DIFF_LINES)).too_large);
        assert_ne!(parse("+a").hash, parse("+b").hash);
    }
}
