//! Link clicks in the transcript (07, Transcript): http and https open in the default browser,
//! `file:///workspace/<path>` opens a file tab, every other scheme is ignored.

#[derive(Debug, PartialEq, Eq)]
pub enum LinkTarget {
    Browser(String),
    FileTab(String),
    Ignore,
}

const WORKSPACE_PREFIX: &str = "file:///workspace/";

pub fn classify(url: &str) -> LinkTarget {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return LinkTarget::Browser(url.to_string());
    }
    if lower.starts_with(WORKSPACE_PREFIX) {
        let path = &url[WORKSPACE_PREFIX.len()..];
        let path = path.split(['?', '#']).next().unwrap_or_default();
        let Some(path) = decode_path(path) else {
            return LinkTarget::Ignore;
        };
        let safe = !path.is_empty()
            && !path.chars().any(char::is_control)
            && path
                .split('/')
                .all(|seg| !seg.is_empty() && seg != "." && seg != "..");
        if safe {
            return LinkTarget::FileTab(path);
        }
    }
    LinkTarget::Ignore
}

fn decode_path(path: &str) -> Option<String> {
    let mut decoded = Vec::with_capacity(path.len());
    let mut bytes = path.bytes();
    while let Some(byte) = bytes.next() {
        if byte == b'%' {
            let high = (bytes.next()? as char).to_digit(16)?;
            let low = (bytes.next()? as char).to_digit(16)?;
            decoded.push((high * 16 + low) as u8);
        } else {
            decoded.push(byte);
        }
    }
    String::from_utf8(decoded).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_links_open_in_the_browser() {
        assert_eq!(
            classify("https://example.com/a?b"),
            LinkTarget::Browser("https://example.com/a?b".into())
        );
        assert_eq!(
            classify("HTTP://x.test"),
            LinkTarget::Browser("HTTP://x.test".into())
        );
    }

    #[test]
    fn workspace_files_open_a_file_tab() {
        assert_eq!(
            classify("file:///workspace/src/main.rs"),
            LinkTarget::FileTab("src/main.rs".into())
        );
        assert_eq!(
            classify("file:///workspace/a.md#L3"),
            LinkTarget::FileTab("a.md".into())
        );
    }

    #[test]
    fn encoded_filenames_open_the_decoded_path() {
        assert_eq!(
            classify("file:///workspace/src/a%20b.rs#L7"),
            LinkTarget::FileTab("src/a b.rs".into())
        );
        assert_eq!(
            classify("file:///workspace/%E6%96%87.md"),
            LinkTarget::FileTab("文.md".into())
        );
        assert_eq!(
            classify("file:///workspace/a%23b.md"),
            LinkTarget::FileTab("a#b.md".into())
        );
    }

    #[test]
    fn everything_else_is_ignored() {
        for url in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "file:///workspace/../etc/passwd",
            "file:///workspace/",
            "file:///workspace/src/%",
            "file:///workspace/%FF",
            "file:///workspace/%00",
            "file:///workspace/%2e%2e/etc/passwd",
            "file:///workspace/src//main.rs",
            "tempo://workspace/x",
            "mailto:a@b.c",
            "ftp://x",
            "/relative",
        ] {
            assert_eq!(classify(url), LinkTarget::Ignore, "{url}");
        }
    }
}
