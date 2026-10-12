//! Custom agents (01, Custom agents; 04, Settings → Agents): the form, menu entries and the
//! profile-issues notice, matching the web's agents-model.ts and chat-tabs-model.ts.
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use tempo_protocol::{self as p, AgentId};

use super::chat_model::{agent_label, has_login};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ServerForm {
    pub name: String,
    /// `stdio`, `http` or `sse`.
    pub kind: String,
    pub command: String,
    /// Arguments, one per line.
    pub args: String,
    pub url: String,
    /// `KEY=${NAME}` lines: env for stdio, headers for http and sse.
    pub vars: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AgentForm {
    pub name: String,
    pub description: String,
    pub base_agent: AgentId,
    pub model: String,
    pub thought_level: String,
    pub system_prompt: String,
    /// Tool names separated by commas, spaces or new lines.
    pub allow: String,
    pub deny: String,
    pub playwright: bool,
    pub servers: Vec<ServerForm>,
}

impl Default for AgentForm {
    fn default() -> Self {
        Self {
            name: String::new(),
            description: String::new(),
            base_agent: AgentId::Claude,
            model: String::new(),
            thought_level: String::new(),
            system_prompt: String::new(),
            allow: String::new(),
            deny: String::new(),
            playwright: true,
            servers: vec![],
        }
    }
}

/// What each base agent ignores, shown below Base agent (01, Custom agents table).
pub fn unsupported_note(agent: AgentId) -> Option<&'static str> {
    match agent {
        AgentId::Codex => Some("Tool limits are not supported."),
        AgentId::Pi => Some("SSE MCP servers are not supported."),
        AgentId::Claude | AgentId::Opencode => None,
    }
}

pub fn split_tags(text: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for t in text.split(|c: char| c == ',' || c.is_whitespace()) {
        let t = t.trim();
        if !t.is_empty() && !out.iter().any(|x| x == t) {
            out.push(t.into());
        }
    }
    out
}

fn is_env_ref(value: &str) -> bool {
    value
        .strip_prefix("${")
        .and_then(|v| v.strip_suffix('}'))
        .is_some_and(|name| {
            let mut chars = name.chars();
            chars
                .next()
                .is_some_and(|c| c.is_ascii_uppercase() || c == '_')
                && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        })
}

fn is_tool_name(t: &str) -> bool {
    (1..=128).contains(&t.len())
        && t.chars()
            .all(|c| c.is_ascii_alphanumeric() || "_.:*-".contains(c))
}

fn is_server_name(n: &str) -> bool {
    (1..=32).contains(&n.len())
        && n.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn parse_vars(text: &str) -> Result<Map<String, Value>, String> {
    let mut vars = Map::new();
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let Some((key, value)) = line.split_once('=') else {
            return Err(format!("Write each line as NAME=${{SECRET}}: {line}"));
        };
        let (key, value) = (key.trim(), value.trim());
        if key.is_empty() {
            return Err(format!("Write each line as NAME=${{SECRET}}: {line}"));
        }
        if !is_env_ref(value) {
            return Err(format!(
                "{key}: use ${{NAME}} of a project env var or secret."
            ));
        }
        vars.insert(key.into(), Value::String(value.into()));
    }
    Ok(vars)
}

fn tool_error(list: &[String]) -> Option<String> {
    if list.len() > 100 {
        return Some("At most 100 tools.".into());
    }
    list.iter()
        .find(|t| !is_tool_name(t))
        .map(|t| format!("Not a valid tool name: {t}"))
}

/// Field errors keyed like the web (`name`, `allow`, `server.<index>.url`), or the definition.
pub fn validate(form: &AgentForm) -> Result<p::CustomAgentDefinition, BTreeMap<String, String>> {
    let mut errors = BTreeMap::new();
    let name = form.name.trim();
    if name.is_empty() {
        errors.insert("name".into(), "Enter a name.".into());
    } else if name.chars().count() > 60 {
        errors.insert("name".into(), "At most 60 characters.".into());
    }
    if form.description.chars().count() > 200 {
        errors.insert("description".into(), "At most 200 characters.".into());
    }
    if form.system_prompt.chars().count() > 32_000 {
        errors.insert("systemPrompt".into(), "At most 32,000 characters.".into());
    }
    let allow = split_tags(&form.allow);
    let deny = split_tags(&form.deny);
    if let Some(e) = tool_error(&allow) {
        errors.insert("allow".into(), e);
    }
    if let Some(e) = tool_error(&deny) {
        errors.insert("deny".into(), e);
    }
    if form.servers.len() > 10 {
        errors.insert("servers".into(), "At most 10 MCP servers.".into());
    }
    let mut seen: Vec<&str> = vec![];
    let mut servers = vec![];
    for (i, s) in form.servers.iter().enumerate() {
        let at = |f: &str| format!("server.{i}.{f}");
        let s_name = s.name.trim();
        if !is_server_name(s_name) {
            errors.insert(at("name"), "Use 1 to 32 of a-z, 0-9, - and _.".into());
        } else if s_name == "playwright" {
            errors.insert(
                at("name"),
                "playwright is reserved. Use the Playwright switch.".into(),
            );
        } else if seen.contains(&s_name) {
            errors.insert(at("name"), "Each server needs its own name.".into());
        }
        seen.push(s_name);
        let vars = parse_vars(&s.vars).unwrap_or_else(|e| {
            errors.insert(at("vars"), e);
            Map::new()
        });
        if s.kind == "stdio" {
            if s.command.trim().is_empty() {
                errors.insert(at("command"), "Enter the command.".into());
            }
            let args: Vec<&str> = s
                .args
                .lines()
                .map(str::trim)
                .filter(|a| !a.is_empty())
                .collect();
            servers.push(json!({"name": s_name, "type": "stdio", "command": s.command.trim(), "args": args, "env": vars}));
        } else {
            let url = s.url.trim();
            if !url.starts_with("https://") || url.len() <= 8 || url.contains(char::is_whitespace) {
                errors.insert(at("url"), "Enter an https:// URL.".into());
            }
            servers.push(json!({"name": s_name, "type": s.kind, "url": url, "headers": vars}));
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    serde_json::from_value(json!({
        "name": name,
        "description": form.description,
        "baseAgent": form.base_agent,
        "model": form.model.trim(),
        "thoughtLevel": form.thought_level.trim(),
        "systemPrompt": form.system_prompt,
        "tools": {"allow": allow, "deny": deny},
        "mcp": {"playwright": form.playwright, "servers": servers},
    }))
    .map_err(|e| BTreeMap::from([("form".to_string(), format!("Check the fields: {e}"))]))
}

fn vars_text(m: &Map<String, Value>) -> String {
    m.iter()
        .map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or_default()))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn form_from_agent(a: &p::CustomAgent) -> AgentForm {
    AgentForm {
        name: a.name.to_string(),
        description: a.description.to_string(),
        base_agent: a.base_agent,
        model: a.model.clone(),
        thought_level: a.thought_level.clone(),
        system_prompt: a.system_prompt.to_string(),
        allow: a.tools.allow.join(", "),
        deny: a.tools.deny.join(", "),
        playwright: a.mcp.playwright,
        servers: a
            .mcp
            .servers
            .iter()
            .map(|s| match s {
                p::McpServerDef::StdioServer(s) => ServerForm {
                    name: s.name.clone(),
                    kind: "stdio".into(),
                    command: s.command.to_string(),
                    args: s.args.join("\n"),
                    url: String::new(),
                    vars: vars_text(&s.env),
                },
                p::McpServerDef::RemoteServer(s) => ServerForm {
                    name: s.name.clone(),
                    kind: s.type_.to_string(),
                    command: String::new(),
                    args: String::new(),
                    url: s.url.clone(),
                    vars: vars_text(&s.headers),
                },
            })
            .collect(),
    }
}

/// A New chat entry for a custom agent (04, Tabs).
#[derive(Clone, Debug, PartialEq)]
pub struct CustomAgentEntry {
    pub id: String,
    pub agent: AgentId,
    pub label: String,
    pub enabled: bool,
}

pub fn menu_entries(
    agents: &[p::CustomAgentSummary],
    credentials: Option<&p::CredentialStatus>,
) -> Vec<CustomAgentEntry> {
    agents
        .iter()
        .map(|a| {
            let enabled = credentials.is_some_and(|c| has_login(a.base_agent, c));
            let suffix = match credentials {
                None => "Loading logins…",
                Some(_) if !enabled => "Add login in Settings",
                Some(_) => agent_label(a.base_agent),
            };
            CustomAgentEntry {
                id: a.id.clone(),
                agent: a.base_agent,
                label: format!("{} · {suffix}", a.name.as_str()),
                enabled,
            }
        })
        .collect()
}

fn issue_label(issue: p::ProfileIssue) -> &'static str {
    match issue {
        p::ProfileIssue::SystemPrompt => "system prompt",
        p::ProfileIssue::Tools => "tool limits",
        p::ProfileIssue::McpServers => "MCP servers",
        p::ProfileIssue::Model => "model",
        p::ProfileIssue::ThoughtLevel => "reasoning level",
    }
}

/// The notice above the composer (04): None when there is nothing to show.
pub fn profile_issues_text(session: &p::Session) -> Option<String> {
    let custom = session.custom_agent.as_ref()?;
    let issues = session.profile_issues.as_deref().unwrap_or_default();
    if issues.is_empty() {
        return None;
    }
    let issues: Vec<_> = issues.iter().map(|i| issue_label(*i)).collect();
    Some(format!(
        "{} ignored some settings of {}: {}",
        agent_label(session.agent),
        custom.name,
        issues.join(", ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(name: &str) -> ServerForm {
        ServerForm {
            name: name.into(),
            kind: "stdio".into(),
            command: "docs-mcp".into(),
            args: "--stdio\n".into(),
            vars: "TOKEN=${DOCS_TOKEN}\n".into(),
            ..Default::default()
        }
    }

    #[test]
    fn a_valid_form_builds_the_definition() {
        let form = AgentForm {
            name: " Reviewer ".into(),
            deny: "Edit, Write Edit".into(),
            thought_level: " high ".into(),
            servers: vec![server("docs")],
            ..Default::default()
        };
        let def = validate(&form).expect("valid");
        assert_eq!(def.name.as_str(), "Reviewer");
        assert_eq!(def.tools.deny, vec!["Edit", "Write"]);
        assert_eq!(def.thought_level, "high");
        let json = serde_json::to_value(&def).unwrap();
        assert_eq!(json["mcp"]["servers"][0]["env"]["TOKEN"], "${DOCS_TOKEN}");
        assert_eq!(json["mcp"]["servers"][0]["args"], json!(["--stdio"]));
    }

    #[test]
    fn errors_name_each_field() {
        let mut bad = server("playwright");
        bad.vars = "TOKEN=sk-live".into();
        let remote = ServerForm {
            name: "web".into(),
            kind: "http".into(),
            url: "http://x".into(),
            ..Default::default()
        };
        let form = AgentForm {
            allow: "a/b".into(),
            servers: vec![bad, remote],
            ..Default::default()
        };
        let errors = validate(&form).unwrap_err();
        assert_eq!(errors["name"], "Enter a name.");
        assert_eq!(errors["allow"], "Not a valid tool name: a/b");
        assert!(errors["server.0.name"].contains("reserved"));
        assert!(errors["server.0.vars"].starts_with("TOKEN: use"));
        assert_eq!(errors["server.1.url"], "Enter an https:// URL.");
    }

    #[test]
    fn a_saved_agent_round_trips_through_the_form() {
        let agent: p::CustomAgent = serde_json::from_value(json!({
            "id": "a1", "commitSha": "c", "updatedAt": 1.0, "name": "R", "description": "",
            "baseAgent": "pi", "model": "", "thoughtLevel": "", "systemPrompt": "",
            "tools": {"allow": ["read"], "deny": []},
            "mcp": {"playwright": true, "servers": [
                {"name": "s", "type": "http", "url": "https://x.dev", "headers": {"A": "${B}"}}
            ]}
        }))
        .unwrap();
        let form = form_from_agent(&agent);
        assert_eq!(form.servers[0].vars, "A=${B}");
        let def = validate(&form).unwrap();
        assert_eq!(
            serde_json::to_value(&def.mcp.servers).unwrap(),
            json!([{"name": "s", "type": "http", "url": "https://x.dev", "headers": {"A": "${B}"}}])
        );
    }

    #[test]
    fn menu_entries_and_notice_match_the_web() {
        let agents: Vec<p::CustomAgentSummary> = serde_json::from_value(json!([
            {"id": "a1", "name": "Reviewer", "description": "", "baseAgent": "codex", "updatedAt": 1.0}
        ]))
        .unwrap();
        let no_login: p::CredentialStatus = serde_json::from_value(json!({
            "claude": {"set": false, "updatedAt": null}, "codex": {"set": false, "updatedAt": null, "lastRefresh": null},
            "openrouter": {"set": false, "updatedAt": null}, "anthropic": {"set": false, "updatedAt": null},
            "openai": {"set": false, "updatedAt": null}
        }))
        .unwrap();
        assert_eq!(
            menu_entries(&agents, None)[0].label,
            "Reviewer · Loading logins…"
        );
        let mut codex = no_login.clone();
        codex.codex.set = true;
        assert_eq!(
            menu_entries(&agents, Some(&codex))[0].label,
            "Reviewer · Codex"
        );
        assert!(menu_entries(&agents, Some(&codex))[0].enabled);
        let off = &menu_entries(&agents, Some(&no_login))[0];
        assert!(!off.enabled);
        assert_eq!(off.label, "Reviewer · Add login in Settings");

        let session: p::Session = serde_json::from_value(json!({
            "id": "s", "agent": "codex", "title": "", "status": "idle", "modeId": null, "modes": [],
            "configOptions": [], "config": {}, "commands": [], "usage": {}, "sortOrder": 1.0,
            "customAgent": {"id": "a1", "name": "Reviewer", "commitSha": "c"},
            "profileIssues": ["tools", "thoughtLevel"]
        }))
        .unwrap();
        assert_eq!(
            profile_issues_text(&session).as_deref(),
            Some("Codex ignored some settings of Reviewer: tool limits, reasoning level")
        );
        assert_eq!(
            super::super::chat_model::session_title(&session),
            "Reviewer"
        );
        assert_eq!(
            super::super::chat_model::session_tooltip(&session).as_deref(),
            Some("Reviewer · Codex")
        );
    }

    #[test]
    fn notes_and_tags() {
        assert_eq!(
            unsupported_note(AgentId::Codex),
            Some("Tool limits are not supported.")
        );
        assert_eq!(unsupported_note(AgentId::Claude), None);
        assert_eq!(split_tags("a, b\nc  a"), vec!["a", "b", "c"]);
    }
}
