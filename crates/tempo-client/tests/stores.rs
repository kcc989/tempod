//! 07 Testing, Stores: every channel fixture (`packages/protocol/fixtures/channel/*.jsonl`) gives the
//! same end state and events in the Rust stores as in the web stores (`<session>.expected.json`).

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};
use tempo_client::state::{HubState, WorkspaceState};
use tempo_protocol::{HubServerMessage, WorkspaceServerMessage};

fn channel_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/protocol/fixtures/channel")
}

/// expected.json is `JSON.stringify` of the web state: numbers have no type, and an absent
/// optional field is the same as one the Rust encoder wrote as `null` (and the reverse).
fn normalize(v: Value) -> Value {
    match v {
        Value::Number(n) => {
            let f = n.as_f64().expect("finite number");
            if f.fract() == 0.0 && f.abs() < 9.0e15 {
                json!(f as i64)
            } else {
                json!(f)
            }
        }
        Value::Array(a) => Value::Array(a.into_iter().map(normalize).collect()),
        Value::Object(o) => Value::Object(
            o.into_iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k, normalize(v)))
                .collect::<Map<_, _>>(),
        ),
        other => other,
    }
}

fn first_difference(expected: &Value, actual: &Value, at: &str) -> Option<String> {
    match (expected, actual) {
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in a {
                match b.get(k) {
                    Some(w) => {
                        if let Some(d) = first_difference(v, w, &format!("{at}.{k}")) {
                            return Some(d);
                        }
                    }
                    None => return Some(format!("{at}.{k} is missing")),
                }
            }
            b.keys()
                .find(|k| !a.contains_key(*k))
                .map(|k| format!("{at}.{k} is extra"))
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => a
            .iter()
            .zip(b)
            .enumerate()
            .find_map(|(i, (x, y))| first_difference(x, y, &format!("{at}[{i}]"))),
        (a, b) if a == b => None,
        (a, b) => Some(format!("{at}: expected {a}, got {b}")),
    }
}

struct Replay {
    channel: &'static str,
    messages: usize,
    state: Value,
    events: Vec<Value>,
}

fn replay(lines: &[&str], channel: &str) -> Replay {
    let mut events = Vec::new();
    if channel == "hub" {
        let mut hub = HubState::new();
        for (i, raw) in lines.iter().enumerate() {
            let msg: HubServerMessage =
                serde_json::from_str(raw).unwrap_or_else(|e| panic!("line {}: {e}", i + 1));
            for e in hub.apply(msg) {
                events.push(json!({
                    "line": i + 1,
                    "event": { "kind": e.kind, "workspaceId": e.workspace.id },
                }));
            }
        }
        Replay {
            channel: "hub",
            messages: lines.len(),
            state: serde_json::to_value(&hub).expect("hub state encodes"),
            events,
        }
    } else {
        let mut ws = WorkspaceState::new();
        for (i, raw) in lines.iter().enumerate() {
            let msg: WorkspaceServerMessage =
                serde_json::from_str(raw).unwrap_or_else(|e| panic!("line {}: {e}", i + 1));
            for e in ws.apply(msg) {
                events.push(json!({ "line": i + 1, "event": e }));
            }
        }
        Replay {
            channel: "workspace",
            messages: lines.len(),
            state: serde_json::to_value(&ws).expect("workspace state encodes"),
            events,
        }
    }
}

#[test]
fn every_channel_fixture_gives_the_web_end_state_and_events() {
    let mut sessions: Vec<PathBuf> = fs::read_dir(channel_dir())
        .expect("packages/protocol/fixtures/channel exists")
        .map(|e| e.expect("dir entry").path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    sessions.sort();
    assert_eq!(sessions.len(), 6, "six channel sessions");
    for path in sessions {
        let name = path
            .file_stem()
            .expect("stem")
            .to_string_lossy()
            .to_string();
        let text = fs::read_to_string(&path).expect("read session");
        let lines: Vec<&str> = text.lines().filter(|l| !l.is_empty()).collect();
        let expected: Value = serde_json::from_str(
            &fs::read_to_string(channel_dir().join(format!("{name}.expected.json")))
                .expect("read expected"),
        )
        .expect("expected is JSON");
        let channel = expected["channel"].as_str().expect("channel");
        let got = replay(&lines, channel);
        assert_eq!(got.channel, channel, "{name}");
        assert_eq!(
            json!(got.messages),
            expected["messages"],
            "{name}: messages"
        );

        let want_state = normalize(expected["state"].clone());
        let got_state = normalize(got.state);
        if let Some(d) = first_difference(&want_state, &got_state, "state") {
            panic!("{name}: {d}");
        }
        let want_events = normalize(expected["events"].clone());
        let got_events = normalize(Value::Array(got.events));
        if let Some(d) = first_difference(&want_events, &got_events, "events") {
            panic!("{name}: {d}");
        }
    }
}

#[test]
fn item_delta_appends_only_to_its_item() {
    let lines = [
        r#"{"type":"items","items":[{"id":"a","sessionId":"s","turnId":null,"rev":1,"createdAt":1,"updatedAt":1,"kind":"agent_message","status":"streaming","content":{"text":"Hel"}}],"itemsRev":1,"done":true}"#,
        r#"{"type":"item.delta","itemId":"a","append":{"text":"lo"},"itemsRev":2}"#,
        r#"{"type":"item.delta","itemId":"missing","append":{"text":"x"},"itemsRev":3}"#,
        r#"{"type":"item.delta","itemId":"a","append":{"text":"!"},"itemsRev":1}"#,
    ];
    let mut ws = WorkspaceState::new();
    for raw in lines {
        ws.apply(serde_json::from_str(raw).expect("decodes"));
    }
    assert_eq!(ws.items["a"].content.text(), Some("Hello"));
    assert_eq!(ws.items_rev, 3.0);
    assert_eq!(ws.since_rev(), 3);
}

#[test]
fn script_output_keeps_the_newest_utf16_units() {
    let mut ws = WorkspaceState::new();
    let chunk = "é".repeat(1000);
    for _ in 0..600 {
        let raw = json!({"type":"script.output","runId":"r","stream":"stdout","data":chunk});
        ws.apply(serde_json::from_value(raw).expect("decodes"));
    }
    ws.apply(
        serde_json::from_value(
            json!({"type":"script.output","runId":"r","stream":"stdout","data":"END"}),
        )
        .expect("decodes"),
    );
    let out = &ws.script_output["r"];
    assert_eq!(
        out.encode_utf16().count(),
        tempo_client::state::MAX_SCRIPT_OUTPUT
    );
    assert!(out.ends_with("END"));
}

fn type_samples<T: serde::de::DeserializeOwned>(name: &str) -> Vec<T> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/protocol/fixtures/types")
        .join(format!("{name}.jsonl"));
    fs::read_to_string(path)
        .expect("fixture")
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| serde_json::from_str(l).expect("sample decodes"))
        .collect()
}

#[test]
fn sidebar_puts_pinned_first_then_projects_newest_activity_first() {
    use tempo_client::state::{SortMode, sidebar_sections};
    use tempo_protocol::{Project, WorkspaceSummary};

    let base: WorkspaceSummary = type_samples("WorkspaceSummary").remove(0);
    let project: Project = type_samples("Project").remove(0);
    let ws = |id: &str, pinned: bool, activity: f64, archived: bool| WorkspaceSummary {
        id: id.into(),
        pinned,
        last_activity_at: activity,
        archived_at: archived.then_some(1.0),
        project_id: project.id.clone(),
        ..base.clone()
    };
    let mut hub = HubState::new();
    for w in [
        ws("a", false, 10.0, false),
        ws("b", false, 30.0, false),
        ws("c", true, 20.0, false),
        ws("d", false, 40.0, true),
    ] {
        assert!(hub.merge(w));
    }
    let sections = sidebar_sections(
        &hub.workspaces,
        std::slice::from_ref(&project),
        SortMode::Activity,
    );
    let ids: Vec<(String, Vec<String>)> = sections
        .iter()
        .map(|s| {
            (
                s.key.clone(),
                s.workspaces.iter().map(|w| w.id.clone()).collect(),
            )
        })
        .collect();
    assert_eq!(
        ids,
        [
            ("pinned".to_owned(), vec!["c".to_owned()]),
            (project.id.clone(), vec!["b".to_owned(), "a".to_owned()]),
        ]
    );
    let stale = WorkspaceSummary {
        rev: base.rev - 1.0,
        ..ws("a", true, 99.0, false)
    };
    assert!(!hub.merge(stale), "an older rev is ignored");
    assert_eq!(hub.attention_count(), 0);
}
