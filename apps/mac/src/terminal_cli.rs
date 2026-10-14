//! Bundled `tempo terminal`: saved Keychain sign-in and the user's local terminal.
use crate::{platform::TokenStore, storage};
use std::io::{self, IsTerminal, Write};
use std::process::{Command, Stdio};
use tempo_client::terminal_bridge::{TerminalBridgeError, TerminalTarget};
use tempo_client::{Runtime, Server, Token};
use tempo_protocol::{WorkspaceSummary, api};

pub const USAGE: &str = "Usage: tempo terminal <workspace-id-or-slug> [t1..t9]\n\nConnect your local terminal to a cloud workspace using your Tempo for Mac sign-in.\nPress Ctrl+] to disconnect; Ctrl+C goes to the cloud shell.";

#[derive(Debug, PartialEq, Eq)]
pub struct Arguments {
    pub workspace: String,
    pub terminal: String,
}

impl Arguments {
    pub fn parse(args: &[String]) -> Result<Option<Self>, &'static str> {
        if args == ["--help"] || args == ["-h"] || args == ["terminal", "--help"] {
            return Ok(None);
        }
        if !(args.len() == 2 || args.len() == 3) || args[0] != "terminal" {
            return Err(USAGE);
        }
        let workspace = &args[1];
        if workspace.is_empty() || workspace.len() > 128 || workspace.chars().any(char::is_control)
        {
            return Err("Use a workspace ID or slug.");
        }
        let terminal = args.get(2).map(String::as_str).unwrap_or("t1");
        if !tempo_client::TERMINAL_IDS.contains(&terminal) {
            return Err("Choose a terminal from t1 to t9.");
        }
        Ok(Some(Self {
            workspace: workspace.clone(),
            terminal: terminal.into(),
        }))
    }
}

pub fn resolve_workspace<'a>(
    workspaces: &'a [WorkspaceSummary],
    name: &str,
) -> Result<&'a str, &'static str> {
    if let Some(workspace) = workspaces.iter().find(|w| w.id == name) {
        return Ok(&workspace.id);
    }
    let mut found = workspaces.iter().filter(|w| w.slug == name);
    let first = found
        .next()
        .ok_or("Workspace not found. Use its ID or slug.")?;
    if found.next().is_some() {
        return Err("More than one workspace has this slug. Use the workspace ID.");
    }
    Ok(&first.id)
}

fn saved_server(
    runtime: &Runtime,
    tokens: &dyn TokenStore,
) -> Result<tempo_client::Client, &'static str> {
    let dir = storage::support_dir().ok_or("Could not find Tempo for Mac settings.")?;
    let text = std::fs::read_to_string(dir.join(storage::CONFIG_FILE))
        .map_err(|_| "Sign in to Tempo for Mac first.")?;
    let config =
        storage::Config::parse(&text).map_err(|_| "Could not read Tempo for Mac settings.")?;
    client_from_config(runtime, config, tokens)
}

fn client_from_config(
    runtime: &Runtime,
    config: storage::Config,
    tokens: &dyn TokenStore,
) -> Result<tempo_client::Client, &'static str> {
    let url = config.url.ok_or("Sign in to Tempo for Mac first.")?;
    let server = Server::new(&runtime.handle(), &url, crate::VERSION)
        .map_err(|_| "Could not connect to the saved Tempo server.")?;
    let token = tokens
        .get(server.host())
        .ok_or("Sign in to Tempo for Mac first.")?;
    Ok(server.client(Token::new(token)))
}

pub fn run(args: &[String]) -> Result<(), String> {
    let Some(arguments) = Arguments::parse(args).map_err(String::from)? else {
        println!("{USAGE}");
        return Ok(());
    };
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err("Run this command in a terminal window.".into());
    }
    let runtime = Runtime::start().map_err(|_| "Could not start Tempo's network runtime.")?;
    let tokens = crate::platform::token_store();
    let client = saved_server(&runtime, tokens.as_ref())?;
    let handle = runtime.handle();
    let workspaces = handle
        .tokio()
        .block_on(client.call::<api::ListWorkspaces>(Default::default()))
        .map_err(|_| {
            if client.is_unauthorized() {
                tokens.delete(client.server().host());
                "Sign in to Tempo for Mac again."
            } else {
                "Could not load cloud workspaces. Try again."
            }
        })?;
    let workspace_id = resolve_workspace(&workspaces, &arguments.workspace)?.to_owned();
    let (cols, rows) = terminal_size().map_err(|_| "Could not measure the local terminal.")?;
    eprintln!(
        "Connecting to cloud workspace {} ({})... Ctrl+] disconnects.",
        arguments.workspace, arguments.terminal
    );
    let _raw = RawTerminal::enter().map_err(|_| "Could not put the local terminal in raw mode.")?;
    #[cfg(unix)]
    let result = handle
        .tokio()
        .block_on(tempo_client::terminal_bridge::local_terminal(
            &client,
            TerminalTarget {
                workspace_id,
                terminal_id: arguments.terminal,
                cols,
                rows,
            },
            terminal_size,
        ));
    #[cfg(not(unix))]
    let result: Result<(), TerminalBridgeError> = {
        let _ = (workspace_id, cols, rows);
        Err(TerminalBridgeError::InvalidTerminal)
    };
    if matches!(
        &result,
        Err(TerminalBridgeError::Closed(
            tempo_client::CloseReason::Unauthorized
        ))
    ) {
        tokens.delete(client.server().host());
    }
    result.map_err(|error| error.to_string())
}

fn stty(args: &[&str]) -> io::Result<Vec<u8>> {
    let output = Command::new("/bin/stty")
        .args(args)
        .stdin(Stdio::inherit())
        .stderr(Stdio::null())
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other("stty failed"));
    }
    Ok(output.stdout)
}

pub fn terminal_size() -> io::Result<(u16, u16)> {
    parse_size(&String::from_utf8_lossy(&stty(&["size"])?))
}

fn parse_size(text: &str) -> io::Result<(u16, u16)> {
    let mut values = text.split_whitespace();
    let rows = values
        .next()
        .and_then(|n| n.parse::<u16>().ok())
        .filter(|n| *n > 0);
    let cols = values
        .next()
        .and_then(|n| n.parse::<u16>().ok())
        .filter(|n| *n > 0);
    match (cols, rows, values.next()) {
        (Some(cols), Some(rows), None) => Ok((cols.clamp(10, 500), rows.clamp(5, 200))),
        _ => Err(io::Error::other("invalid terminal dimensions")),
    }
}

struct RawTerminal {
    saved: String,
}
impl RawTerminal {
    fn enter() -> io::Result<Self> {
        let saved = String::from_utf8(stty(&["-g"])?)
            .map_err(|_| io::Error::other("invalid terminal settings"))?;
        let guard = Self {
            saved: saved.trim().into(),
        };
        stty(&["raw", "-echo"])?;
        Ok(guard)
    }
}
impl Drop for RawTerminal {
    fn drop(&mut self) {
        let _ = stty(&[&self.saved]);
        let mut output = io::stdout().lock();
        let _ = output.write_all(b"\x1b[0m\x1b[?25h\x1b[?1049l\r\n");
        let _ = output.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
    }
    #[test]
    fn arguments_default_to_t1_and_accept_an_explicit_terminal() {
        assert_eq!(
            Arguments::parse(&args(&["terminal", "lisbon"])).unwrap(),
            Some(Arguments {
                workspace: "lisbon".into(),
                terminal: "t1".into()
            })
        );
        assert_eq!(
            Arguments::parse(&args(&["terminal", "id", "t9"]))
                .unwrap()
                .unwrap()
                .terminal,
            "t9"
        );
        assert_eq!(Arguments::parse(&args(&["--help"])).unwrap(), None);
        for value in ["t0", "t10", "x", "t1;ls"] {
            assert!(Arguments::parse(&args(&["terminal", "id", value])).is_err());
        }
        assert!(Arguments::parse(&args(&["terminal", "\x1b[31m"])).is_err());
        assert!(Arguments::parse(&args(&["terminal"])).is_err());
    }
    #[test]
    fn stty_rows_and_columns_are_reordered_and_clamped() {
        assert_eq!(parse_size("24 80\n").unwrap(), (80, 24));
        assert_eq!(parse_size("300 800").unwrap(), (500, 200));
        assert_eq!(parse_size("2 4").unwrap(), (10, 5));
        for bad in ["0 0", "24", "80 x", "24 80 4"] {
            assert!(parse_size(bad).is_err());
        }
    }
    #[test]
    fn resolves_unique_slugs_and_requires_ids_for_ambiguous_slugs() {
        let fixtures =
            include_str!("../../../packages/protocol/fixtures/types/WorkspaceSummary.jsonl");
        let mut workspace: WorkspaceSummary =
            serde_json::from_str(fixtures.lines().next().unwrap()).unwrap();
        workspace.id = "id1".into();
        workspace.slug = "lisbon".into();
        let mut duplicate = workspace.clone();
        duplicate.id = "id2".into();
        assert_eq!(resolve_workspace(&[workspace.clone()], "lisbon"), Ok("id1"));
        assert!(resolve_workspace(&[workspace.clone(), duplicate.clone()], "lisbon").is_err());
        assert_eq!(resolve_workspace(&[workspace, duplicate], "id2"), Ok("id2"));
    }
    #[test]
    fn saved_auth_uses_the_configured_host_and_never_falls_back_to_another_token() {
        let runtime = Runtime::start().unwrap();
        let tokens = crate::platform::MemoryTokenStore::default();
        tokens.set("other.test", "other-session").unwrap();
        let config = storage::Config {
            url: Some("https://tempo.test/path".into()),
            ..Default::default()
        };
        assert!(client_from_config(&runtime, config.clone(), &tokens).is_err());
        tokens.set("tempo.test", "saved-session").unwrap();
        let client = client_from_config(&runtime, config, &tokens).unwrap();
        assert_eq!(client.server().origin(), "https://tempo.test");
        assert!(!format!("{client:?}").contains("saved-session"));
    }

    #[test]
    #[ignore = "requires an attached terminal; run explicitly in a PTY"]
    fn raw_mode_restores_the_tty_on_an_error_when_attached() {
        assert!(io::stdin().is_terminal() && io::stdout().is_terminal());
        let before = stty(&["-g"]).unwrap();
        let failed = (|| -> io::Result<()> {
            let _guard = RawTerminal::enter()?;
            let flags = String::from_utf8(stty(&["-a"])?).unwrap();
            assert!(
                flags
                    .split_whitespace()
                    .any(|word| word.trim_end_matches(';') == "-echo")
            );
            Err(io::Error::other("test disconnect"))
        })();
        assert!(failed.is_err());
        assert_eq!(stty(&["-g"]).unwrap(), before);
    }
}
