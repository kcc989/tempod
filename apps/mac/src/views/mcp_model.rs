//! Settings → MCP servers (04; 02, MCP servers): the form model, shared with the web tab.
use std::collections::BTreeSet;
use tempo_protocol as p;

pub const TRANSPORTS: [p::McpTransport; 3] = [
    p::McpTransport::Stdio,
    p::McpTransport::Http,
    p::McpTransport::Sse,
];
const MAX_ARGS: usize = 32;
const MAX_ENV: usize = 32;
const MAX_HEADERS: usize = 16;
const RESERVED_HEADERS: [&str; 4] = ["host", "content-length", "connection", "transfer-encoding"];

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Row {
    pub name: String,
    pub value: String,
    pub secret: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct McpForm {
    pub id: Option<String>,
    pub name: String,
    pub enabled: bool,
    pub transport: p::McpTransport,
    pub command: String,
    pub args: String,
    pub env: Vec<Row>,
    pub url: String,
    pub headers: Vec<Row>,
}

impl Default for McpForm {
    fn default() -> Self {
        Self {
            id: None,
            name: String::new(),
            enabled: true,
            transport: p::McpTransport::Stdio,
            command: String::new(),
            args: String::new(),
            env: vec![],
            url: String::new(),
            headers: vec![],
        }
    }
}

impl McpForm {
    pub fn of(s: &p::McpServer) -> Self {
        Self {
            id: Some(s.id.clone()),
            name: s.name.clone(),
            enabled: s.enabled,
            transport: s.transport,
            command: s.command.clone().unwrap_or_default(),
            args: s.args.join("\n"),
            env: s
                .env
                .iter()
                .map(|e| Row {
                    name: e.name.clone(),
                    value: e.value.clone(),
                    secret: false,
                })
                .collect(),
            url: s.url.clone().unwrap_or_default(),
            headers: s
                .headers
                .iter()
                .map(|h| Row {
                    name: h.name.clone(),
                    value: h.value.clone().unwrap_or_default(),
                    secret: h.secret,
                })
                .collect(),
        }
    }

    /// Only the fields valid for the transport. An empty secret value is left out so the stored
    /// one is kept.
    pub fn input(&self) -> p::McpServerInput {
        let mut input = p::McpServerInput {
            id: self.id.clone().filter(|id| !id.is_empty()),
            name: self.name.trim().into(),
            enabled: self.enabled,
            transport: self.transport,
            command: None,
            args: None,
            env: None,
            url: None,
            headers: None,
        };
        if self.transport == p::McpTransport::Stdio {
            input.command = Some(self.command.trim().into());
            input.args = Some(
                self.args
                    .split('\n')
                    .filter(|a| !a.trim().is_empty())
                    .map(Into::into)
                    .collect(),
            );
            input.env = Some(
                self.env
                    .iter()
                    .filter(|e| !e.name.is_empty() || !e.value.is_empty())
                    .map(|e| p::McpEnvVar {
                        name: e.name.trim().into(),
                        value: e.value.clone(),
                    })
                    .collect(),
            );
        } else {
            input.url = Some(self.url.trim().into());
            input.headers = Some(
                self.headers
                    .iter()
                    .filter(|h| !h.name.is_empty() || !h.value.is_empty())
                    .map(|h| p::McpHeaderInput {
                        name: h.name.trim().into(),
                        secret: h.secret,
                        value: (!h.secret || !h.value.is_empty()).then(|| h.value.clone()),
                    })
                    .collect(),
            );
        }
        input
    }
}

/// Lowercase names of secret headers that have a stored value.
pub fn stored_secrets(server: Option<&p::McpServer>) -> BTreeSet<String> {
    server
        .map(|s| {
            s.headers
                .iter()
                .filter(|h| h.secret && h.set == Some(true))
                .map(|h| h.name.to_lowercase())
                .collect()
        })
        .unwrap_or_default()
}

/// The text a server row shows after its transport.
pub fn target(s: &p::McpServer) -> String {
    if s.transport == p::McpTransport::Stdio {
        std::iter::once(s.command.clone().unwrap_or_default())
            .chain(s.args.iter().cloned())
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        s.url.clone().unwrap_or_default()
    }
}

fn name_ok(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name.chars().count() <= 32
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn env_name_ok(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_uppercase() || c == '_')
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

fn header_name_ok(name: &str) -> bool {
    (1..=64).contains(&name.len()) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// `Some(true)` for an https URL with a host, `Some(false)` for another scheme, `None` when it
/// does not parse.
fn https_url(url: &str) -> Option<bool> {
    let url = url.trim_matches(|c: char| c <= ' ');
    let (scheme, rest) = url.split_once(':')?;
    let mut chars = scheme.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        || !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    {
        return None;
    }
    if !scheme.eq_ignore_ascii_case("https") {
        return Some(false);
    }
    let authority = rest
        .trim_start_matches(['/', '\\'])
        .split(['/', '\\', '?', '#'])
        .next()
        .unwrap_or_default();
    let host = authority.rsplit('@').next().unwrap_or_default();
    let (host, port) = match host.rsplit_once(':') {
        Some((h, port)) if !port.contains(']') => (h, port),
        _ => (host, ""),
    };
    (!host.is_empty()
        && !host.contains(char::is_whitespace)
        && port.chars().all(|c| c.is_ascii_digit()))
    .then_some(true)
}

/// The rules of `saveMcpServer` that need no stored state, in the order of `mcpInputProblem`.
pub fn input_problem(input: &p::McpServerInput, stored: &BTreeSet<String>) -> Option<String> {
    if !name_ok(&input.name) {
        return Some("Name uses a to z, 0 to 9, - and _, starts with a letter or digit, and has at most 32 characters.".into());
    }
    if input.name == "playwright" {
        return Some("The name playwright is reserved.".into());
    }
    let args = input.args.as_deref().unwrap_or_default();
    let env = input.env.as_deref().unwrap_or_default();
    let headers = input.headers.as_deref().unwrap_or_default();
    if input.transport == p::McpTransport::Stdio {
        let command = input.command.as_deref().unwrap_or_default().trim();
        if command.is_empty() || command.encode_utf16().count() > 1024 {
            return Some("A stdio server needs a command.".into());
        }
        if input.url.is_some() || !headers.is_empty() {
            return Some("A stdio server has no URL or headers.".into());
        }
        if args.len() > MAX_ARGS {
            return Some(format!("At most {MAX_ARGS} arguments."));
        }
        if env.len() > MAX_ENV {
            return Some(format!("At most {MAX_ENV} env vars."));
        }
        let mut names = BTreeSet::new();
        for e in env {
            if !env_name_ok(&e.name) {
                let name = if e.name.is_empty() {
                    "(empty)"
                } else {
                    &e.name
                };
                return Some(format!("Env var {name} must match A-Z, 0-9 and _."));
            }
            if !names.insert(e.name.as_str()) {
                return Some(format!("Env var {} is listed twice.", e.name));
            }
        }
        return None;
    }
    if input.command.is_some() || !args.is_empty() || !env.is_empty() {
        return Some("An http or sse server has no command, arguments or env vars.".into());
    }
    let url = input.url.as_deref().unwrap_or_default();
    match https_url(url) {
        None => return Some("The URL is not valid.".into()),
        Some(false) => return Some("The URL must start with https://.".into()),
        Some(true) => {}
    }
    if url.encode_utf16().count() > 2048 {
        return Some("The URL is too long.".into());
    }
    if headers.len() > MAX_HEADERS {
        return Some(format!("At most {MAX_HEADERS} headers."));
    }
    let mut seen = BTreeSet::new();
    for h in headers {
        let lower = h.name.to_lowercase();
        if !header_name_ok(&h.name) {
            let name = if h.name.is_empty() {
                "(empty)"
            } else {
                &h.name
            };
            return Some(format!("Header {name} uses A-Z, a-z, 0-9 and -."));
        }
        if RESERVED_HEADERS.contains(&lower.as_str()) {
            return Some(format!("Header {} is set by Tempo.", h.name));
        }
        if !seen.insert(lower.clone()) {
            return Some(format!("Header {} is listed twice.", h.name));
        }
        if !h.secret && h.value.is_none() {
            return Some(format!("Header {} needs a value.", h.name));
        }
        if h.secret && h.value.as_deref().unwrap_or_default().is_empty() && !stored.contains(&lower)
        {
            return Some(format!("Secret header {} needs a value.", h.name));
        }
        if h.value.as_deref().is_some_and(|v| v.contains(['\r', '\n'])) {
            return Some(format!("Header {} has a line break.", h.name));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> p::McpServer {
        serde_json::from_value(serde_json::json!({
            "id": "mcp_1", "name": "linear", "enabled": true, "transport": "http",
            "command": null, "args": [], "env": [], "url": "https://mcp.linear.app/mcp",
            "headers": [
                {"name": "Authorization", "secret": true, "value": null, "set": true},
                {"name": "X-Team", "secret": false, "value": "eng"}
            ],
            "createdAt": 1, "updatedAt": 2
        }))
        .unwrap()
    }

    fn stdio() -> McpForm {
        McpForm {
            name: "files".into(),
            command: "npx".into(),
            ..McpForm::default()
        }
    }

    fn problem(form: &McpForm) -> Option<String> {
        input_problem(&form.input(), &BTreeSet::new())
    }

    #[test]
    fn empty_secret_keeps_the_stored_value() {
        let s = server();
        let form = McpForm::of(&s);
        let input = form.input();
        let headers = input.headers.clone().unwrap();
        assert_eq!(headers[0].name, "Authorization");
        assert!(headers[0].secret);
        assert_eq!(headers[0].value, None);
        assert_eq!(headers[1].value.as_deref(), Some("eng"));
        assert_eq!(input.id.as_deref(), Some("mcp_1"));
        let json = serde_json::to_value(&input).unwrap();
        assert!(json["headers"][0].get("value").is_none());
        assert!(json.get("command").is_none() && json.get("env").is_none());
        assert_eq!(input_problem(&input, &stored_secrets(Some(&s))), None);
        assert_eq!(
            input_problem(&input, &BTreeSet::new()).as_deref(),
            Some("Secret header Authorization needs a value.")
        );
    }

    #[test]
    fn a_typed_secret_is_sent() {
        let mut form = McpForm::of(&server());
        form.headers[0].value = "Bearer t".into();
        let headers = form.input().headers.unwrap();
        assert_eq!(headers[0].value.as_deref(), Some("Bearer t"));
    }

    #[test]
    fn input_keeps_only_the_fields_of_its_transport() {
        let mut form = McpForm {
            name: " files ".into(),
            command: " npx ".into(),
            args: "-y\n\n  \n@scope/server\n".into(),
            env: vec![
                Row {
                    name: "LOG_LEVEL".into(),
                    value: "debug".into(),
                    secret: false,
                },
                Row::default(),
            ],
            url: "https://example.com".into(),
            headers: vec![Row {
                name: "X-A".into(),
                value: "1".into(),
                secret: false,
            }],
            ..McpForm::default()
        };
        let input = form.input();
        assert_eq!(input.name, "files");
        assert_eq!(input.command.as_deref(), Some("npx"));
        assert_eq!(input.args.as_deref().unwrap(), ["-y", "@scope/server"]);
        assert_eq!(input.env.as_ref().unwrap().len(), 1);
        assert!(input.url.is_none() && input.headers.is_none() && input.id.is_none());
        assert_eq!(input_problem(&input, &BTreeSet::new()), None);
        form.transport = p::McpTransport::Sse;
        let input = form.input();
        assert!(input.command.is_none() && input.args.is_none() && input.env.is_none());
        assert_eq!(input.url.as_deref(), Some("https://example.com"));
        assert_eq!(input.headers.as_ref().unwrap().len(), 1);
        assert_eq!(input_problem(&input, &BTreeSet::new()), None);
    }

    #[test]
    fn names_follow_the_spec() {
        for ok in ["a", "0", "my-server_2", &"a".repeat(32)] {
            let form = McpForm {
                name: ok.into(),
                ..stdio()
            };
            assert_eq!(problem(&form), None, "{ok}");
        }
        for bad in ["", "-a", "_a", "A", "a.b", "a b", &"a".repeat(33)] {
            let form = McpForm {
                name: bad.into(),
                ..stdio()
            };
            assert!(problem(&form).unwrap().starts_with("Name uses"), "{bad}");
        }
        let form = McpForm {
            name: "playwright".into(),
            ..stdio()
        };
        assert_eq!(
            problem(&form).as_deref(),
            Some("The name playwright is reserved.")
        );
    }

    #[test]
    fn stdio_rules() {
        let mut form = McpForm {
            command: "  ".into(),
            ..stdio()
        };
        assert_eq!(
            problem(&form).as_deref(),
            Some("A stdio server needs a command.")
        );
        form.command = "x".repeat(1025);
        assert_eq!(
            problem(&form).as_deref(),
            Some("A stdio server needs a command.")
        );
        form.command = "npx".into();
        form.args = vec!["a"; 33].join("\n");
        assert_eq!(problem(&form).as_deref(), Some("At most 32 arguments."));
        form.args.clear();
        form.env = vec![
            Row {
                name: "lower".into(),
                ..Row::default()
            };
            1
        ];
        assert_eq!(
            problem(&form).as_deref(),
            Some("Env var lower must match A-Z, 0-9 and _.")
        );
        form.env = vec![
            Row {
                name: "A_1".into(),
                value: "x".into(),
                secret: false,
            };
            2
        ];
        assert_eq!(
            problem(&form).as_deref(),
            Some("Env var A_1 is listed twice.")
        );
        form.env = (0..33)
            .map(|i| Row {
                name: format!("V{i}"),
                ..Row::default()
            })
            .collect();
        assert_eq!(problem(&form).as_deref(), Some("At most 32 env vars."));
        let mut input = stdio().input();
        input.url = Some("https://example.com".into());
        assert_eq!(
            input_problem(&input, &BTreeSet::new()).as_deref(),
            Some("A stdio server has no URL or headers.")
        );
    }

    #[test]
    fn http_rules() {
        let mut form = McpForm {
            name: "remote".into(),
            transport: p::McpTransport::Http,
            url: "https://mcp.example.com/mcp".into(),
            ..McpForm::default()
        };
        assert_eq!(problem(&form), None);
        for (url, expected) in [
            ("", "The URL is not valid."),
            ("mcp.example.com", "The URL is not valid."),
            ("https://", "The URL is not valid."),
            ("https://example.com:abc", "The URL is not valid."),
            (
                "http://mcp.example.com",
                "The URL must start with https://.",
            ),
            ("ftp://x", "The URL must start with https://."),
        ] {
            form.url = url.into();
            assert_eq!(problem(&form).as_deref(), Some(expected), "{url}");
        }
        form.url = format!("https://example.com/{}", "a".repeat(2048));
        assert_eq!(problem(&form).as_deref(), Some("The URL is too long."));
        form.url = "HTTPS://user@example.com:8443/x".into();
        assert_eq!(problem(&form), None);
        let header = |name: &str, value: &str, secret: bool| Row {
            name: name.into(),
            value: value.into(),
            secret,
        };
        for (headers, expected) in [
            (
                vec![header("Bad Name", "1", false)],
                "Header Bad Name uses A-Z, a-z, 0-9 and -.",
            ),
            (
                vec![header("", "1", false)],
                "Header (empty) uses A-Z, a-z, 0-9 and -.",
            ),
            (
                vec![header("Host", "1", false)],
                "Header Host is set by Tempo.",
            ),
            (
                vec![header("X-A", "1", false), header("x-a", "2", false)],
                "Header x-a is listed twice.",
            ),
            (
                vec![header("X-A", "", true)],
                "Secret header X-A needs a value.",
            ),
            (
                vec![header("X-A", "a\nb", false)],
                "Header X-A has a line break.",
            ),
        ] {
            form.headers = headers;
            assert_eq!(problem(&form).as_deref(), Some(expected));
        }
        form.headers = (0..17)
            .map(|i| header(&format!("X-{i}"), "v", false))
            .collect();
        assert_eq!(problem(&form).as_deref(), Some("At most 16 headers."));
        let mut input = form.input();
        input.headers = Some(vec![p::McpHeaderInput {
            name: "X-A".into(),
            secret: false,
            value: None,
        }]);
        assert_eq!(
            input_problem(&input, &BTreeSet::new()).as_deref(),
            Some("Header X-A needs a value.")
        );
        input.headers = None;
        input.command = Some("npx".into());
        assert_eq!(
            input_problem(&input, &BTreeSet::new()).as_deref(),
            Some("An http or sse server has no command, arguments or env vars.")
        );
    }

    #[test]
    fn row_target_shows_command_or_url() {
        let mut s = server();
        assert_eq!(target(&s), "https://mcp.linear.app/mcp");
        s.transport = p::McpTransport::Stdio;
        s.command = Some("npx".into());
        s.args = vec!["-y".into(), "pkg".into()];
        assert_eq!(target(&s), "npx -y pkg");
    }
}
