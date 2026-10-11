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
        let safe = !path.is_empty() && path.split('/').all(|seg| !seg.is_empty() && seg != "." && seg != "..");
        if safe {
            return LinkTarget::FileTab(path.to_string());
        }
    }
    LinkTarget::Ignore
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_links_open_in_the_browser() {
        assert_eq!(classify("https://example.com/a?b"), LinkTarget::Browser("https://example.com/a?b".into()));
        assert_eq!(classify("HTTP://x.test"), LinkTarget::Browser("HTTP://x.test".into()));
    }

    #[test]
    fn workspace_files_open_a_file_tab() {
        assert_eq!(classify("file:///workspace/src/main.rs"), LinkTarget::FileTab("src/main.rs".into()));
        assert_eq!(classify("file:///workspace/a.md#L3"), LinkTarget::FileTab("a.md".into()));
    }

    #[test]
    fn everything_else_is_ignored() {
        for url in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "file:///workspace/../etc/passwd",
            "file:///workspace/",
            "tempo://workspace/x",
            "mailto:a@b.c",
            "ftp://x",
            "/relative",
        ] {
            assert_eq!(classify(url), LinkTarget::Ignore, "{url}");
        }
    }
}
