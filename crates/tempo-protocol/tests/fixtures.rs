//! Decodes every file in packages/protocol/fixtures (07, Testing) and checks that it round-trips.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tempo_protocol::{
    ChangesSummary, CredentialProvider, HubServerMessage, Item, PermissionRequest, ScriptRun,
    Session, Turn, WorkspaceDetail, WorkspaceServerMessage, WorkspaceSummary, roundtrip, wire,
};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/protocol/fixtures")
}

fn files(dir: &Path, suffix: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .map(|e| e.expect("dir entry").path())
        .filter(|p| p.to_string_lossy().ends_with(suffix))
        .collect();
    out.sort();
    out
}

fn stem(path: &Path, suffix: &str) -> String {
    let name = path.file_name().expect("file name").to_string_lossy();
    name.strip_suffix(suffix).expect("suffix").to_string()
}

fn lines(path: &Path) -> Vec<String> {
    fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

/// JSON equality where 5 and 5.0 are equal, and an optional `null` the encoder left out is equal to absent.
fn same_json(original: &Value, encoded: &Value, at: &str) -> Result<(), String> {
    match (original, encoded) {
        (Value::Number(a), Value::Number(b)) if a.as_f64() == b.as_f64() => Ok(()),
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in a {
                match b.get(k) {
                    Some(w) => same_json(v, w, &format!("{at}.{k}"))?,
                    None if v.is_null() => {}
                    None => return Err(format!("{at}.{k} was dropped")),
                }
            }
            match b.keys().find(|k| !a.contains_key(*k)) {
                Some(k) => Err(format!("{at}.{k} was added")),
                None => Ok(()),
            }
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => a
            .iter()
            .zip(b)
            .enumerate()
            .try_for_each(|(i, (x, y))| same_json(x, y, &format!("{at}[{i}]"))),
        (a, b) if a == b => Ok(()),
        (a, b) => Err(format!("{at}: {a} became {b}")),
    }
}

fn check(name: &str, raw: &str, encoded: Result<Value, String>, origin: &str) {
    let encoded = encoded.unwrap_or_else(|e| panic!("{origin}: {name}: {e}\n{raw}"));
    let original: Value = serde_json::from_str(raw).expect("fixture is JSON");
    if let Err(e) = same_json(&original, &encoded, "$") {
        panic!("{origin}: {name} does not round-trip: {e}");
    }
}

#[test]
fn every_wire_type_has_fixtures_and_they_round_trip() {
    let dir = fixtures().join("types");
    let found = files(&dir, ".jsonl");
    let names: Vec<String> = found.iter().map(|p| stem(p, ".jsonl")).collect();
    let mut expected: Vec<String> = wire::NAMES.iter().map(|s| s.to_string()).collect();
    expected.sort();
    assert_eq!(
        names, expected,
        "fixture files and generated types differ; run bun run protocol:gen"
    );

    let mut samples = 0;
    for path in &found {
        let name = stem(path, ".jsonl");
        let values = lines(path);
        assert!(!values.is_empty(), "{name} has no samples");
        for (i, raw) in values.iter().enumerate() {
            let result = wire::roundtrip(&name, raw).expect("known type");
            check(&name, raw, result, &format!("types/{name}.jsonl:{}", i + 1));
            samples += 1;
        }
    }
    assert!(samples > found.len());
}

fn channel_sessions() -> Vec<(String, PathBuf)> {
    files(&fixtures().join("channel"), ".jsonl")
        .into_iter()
        .map(|p| (stem(&p, ".jsonl"), p))
        .collect()
}

fn decode_all<T: DeserializeOwned>(name: &str, path: &Path) -> Vec<T> {
    lines(path)
        .iter()
        .enumerate()
        .map(|(i, raw)| {
            serde_json::from_str(raw).unwrap_or_else(|e| panic!("{name}.jsonl:{}: {e}", i + 1))
        })
        .collect()
}

#[test]
fn every_channel_message_decodes_and_round_trips() {
    let sessions = channel_sessions();
    assert!(sessions.iter().any(|(n, _)| n.starts_with("hub-")));
    assert!(sessions.iter().any(|(n, _)| n.starts_with("workspace-")));
    for (name, path) in sessions {
        for (i, raw) in lines(&path).iter().enumerate() {
            let origin = format!("channel/{name}.jsonl:{}", i + 1);
            if name.starts_with("hub-") {
                check(
                    "HubServerMessage",
                    raw,
                    roundtrip::<HubServerMessage>(raw),
                    &origin,
                );
            } else {
                check(
                    "WorkspaceServerMessage",
                    raw,
                    roundtrip::<WorkspaceServerMessage>(raw),
                    &origin,
                );
            }
        }
    }
}

#[test]
fn channel_messages_pick_the_right_variant() {
    let path = fixtures().join("channel/workspace-first-load.jsonl");
    let messages: Vec<WorkspaceServerMessage> = decode_all("workspace-first-load", &path);
    assert!(matches!(messages[0], WorkspaceServerMessage::Hello(_)));
    assert!(matches!(messages[1], WorkspaceServerMessage::Items(_)));
    let path = fixtures().join("channel/hub-sidebar.jsonl");
    let messages: Vec<HubServerMessage> = decode_all("hub-sidebar", &path);
    assert!(matches!(messages[0], HubServerMessage::HubHello(_)));
    assert!(
        messages
            .iter()
            .any(|m| matches!(m, HubServerMessage::HubWorkspaceRemoved(_)))
    );
}

#[derive(Deserialize)]
struct Expected<S> {
    channel: String,
    messages: usize,
    state: S,
    events: Vec<Value>,
}

#[derive(Deserialize)]
struct HubState {
    ready: bool,
    workspaces: BTreeMap<String, WorkspaceSummary>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code, reason = "decoded to check the shape only")]
struct WorkspaceState {
    ready: bool,
    backlog_done: bool,
    workspace: Option<WorkspaceDetail>,
    sessions: BTreeMap<String, Session>,
    turns: BTreeMap<String, Turn>,
    items: BTreeMap<String, Item>,
    order: BTreeMap<String, Vec<String>>,
    items_rev: f64,
    permissions: BTreeMap<String, PermissionRequest>,
    script_runs: BTreeMap<String, ScriptRun>,
    script_output: BTreeMap<String, String>,
    changes: Option<ChangesSummary>,
    changes_seq: u64,
    credential_invalid: Vec<CredentialProvider>,
}

#[test]
fn every_expected_end_state_decodes() {
    for (name, path) in channel_sessions() {
        let expected_path = path.with_file_name(format!("{name}.expected.json"));
        let text = fs::read_to_string(&expected_path).unwrap_or_else(|e| panic!("{name}: {e}"));
        let count = lines(&path).len();
        if name.starts_with("hub-") {
            let e: Expected<HubState> =
                serde_json::from_str(&text).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!((e.channel.as_str(), e.messages), ("hub", count), "{name}");
            assert!(e.state.ready);
            assert!(e.state.workspaces.iter().all(|(id, w)| *id == w.id));
            assert!(e.events.iter().all(|v| v["line"].as_u64().is_some()));
        } else {
            let e: Expected<WorkspaceState> =
                serde_json::from_str(&text).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(
                (e.channel.as_str(), e.messages),
                ("workspace", count),
                "{name}"
            );
            assert!(e.state.ready && e.state.workspace.is_some());
            assert!(e.state.items.iter().all(|(id, item)| *id == item.id));
            let ordered: usize = e.state.order.values().map(Vec::len).sum();
            assert_eq!(ordered, e.state.items.len(), "{name}");
            assert!(e.events.iter().all(|v| v["line"].as_u64().is_some()));
        }
    }
}

#[test]
fn the_api_table_matches_api_json() {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/protocol/schema/Api.json");
    let api: Value =
        serde_json::from_str(&fs::read_to_string(path).expect("Api.json")).expect("JSON");
    let mut names: Vec<&str> = api["properties"]
        .as_object()
        .expect("properties")
        .keys()
        .map(String::as_str)
        .collect();
    names.sort_unstable();
    let mut table: Vec<&str> = tempo_protocol::api::ALL.iter().map(|(n, _)| *n).collect();
    table.sort_unstable();
    assert_eq!(names, table);
}

#[test]
fn legacy_workspace_hello_uses_default_models_and_rejects_malformed_maps() {
    let hello =
        include_str!("../../../packages/protocol/fixtures/channel/workspace-first-load.jsonl")
            .lines()
            .next()
            .unwrap();
    let mut value: Value = serde_json::from_str(hello).unwrap();
    value["workspace"]
        .as_object_mut()
        .unwrap()
        .remove("browserActive");
    value["workspace"]["settings"]["agent"]
        .as_object_mut()
        .unwrap()
        .remove("models");
    value["workspace"]["settings"]
        .as_object_mut()
        .unwrap()
        .remove("browser");
    let WorkspaceServerMessage::Hello(decoded) = serde_json::from_value(value.clone()).unwrap()
    else {
        panic!("expected hello");
    };
    assert_eq!(
        decoded.workspace.settings.agent.models,
        tempo_protocol::SettingsAgentModels::default()
    );
    assert!(!decoded.workspace.settings.browser.run);
    assert!(!decoded.workspace.browser_active);
    for models in [Value::Null, serde_json::json!({"claude": 1})] {
        value["workspace"]["settings"]["agent"]["models"] = models;
        assert!(serde_json::from_value::<WorkspaceServerMessage>(value.clone()).is_err());
    }
}
