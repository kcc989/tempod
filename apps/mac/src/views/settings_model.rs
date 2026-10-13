//! Settings → Project (04): every settings key as one field of a `SettingsLayer` form, as the
//! web's `settings-model.ts`. A field is inherited (not in the layer) or set here (a Tempo
//! override). Each field shows its effective value and where it came from.
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use tempo_protocol::SettingsSource;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Text,
    Multiline,
    Select,
    Bool,
    Number,
    Hosts,
    Instance,
    Run,
    Env,
}

pub struct FieldDef {
    pub path: &'static str,
    pub section: &'static str,
    pub label: &'static str,
    pub kind: Kind,
    /// `(value, label)` for a select.
    pub options: &'static [(&'static str, &'static str)],
    pub hint: Option<&'static str>,
}

const fn field(
    path: &'static str,
    section: &'static str,
    label: &'static str,
    kind: Kind,
) -> FieldDef {
    FieldDef {
        path,
        section,
        label,
        kind,
        options: &[],
        hint: None,
    }
}

pub const INSTANCE_PRESETS: [&str; 3] = ["standard-2", "standard-3", "standard-4"];
pub const CUSTOM: &str = "custom";

pub const FIELDS: &[FieldDef] = &[
    FieldDef {
        options: &[
            ("claude", "Claude"),
            ("codex", "Codex"),
            ("opencode", "OpenCode"),
            ("pi", "Pi"),
        ],
        ..field("agent.default", "Agent", "Default agent", Kind::Select)
    },
    FieldDef {
        hint: Some("The agent's model value. Empty uses the agent's own default."),
        ..field(
            "agent.models.claude",
            "Agent",
            "Claude default model",
            Kind::Text,
        )
    },
    FieldDef {
        hint: Some("The agent's model value. Empty uses the agent's own default."),
        ..field(
            "agent.models.codex",
            "Agent",
            "Codex default model",
            Kind::Text,
        )
    },
    FieldDef {
        hint: Some("The agent's model value. Required to start an OpenCode chat."),
        ..field(
            "agent.models.opencode",
            "Agent",
            "OpenCode default model",
            Kind::Text,
        )
    },
    FieldDef {
        hint: Some("The agent's model value. Required to start a Pi chat."),
        ..field("agent.models.pi", "Agent", "Pi default model", Kind::Text)
    },
    FieldDef {
        hint: Some(
            "Agents use Browser Run, watched in Live View. Ignored under the allowlist egress policy.",
        ),
        ..field("browser.run", "Browser", "Browser Run", Kind::Bool)
    },
    field("scripts.setup", "Scripts", "Setup script", Kind::Multiline),
    field("scripts.run", "Scripts", "Run scripts", Kind::Run),
    FieldDef {
        options: &[
            ("concurrent", "Concurrent"),
            ("nonconcurrent", "One at a time"),
        ],
        ..field("scripts.run_mode", "Scripts", "Run mode", Kind::Select)
    },
    field(
        "scripts.auto_run_after_setup",
        "Scripts",
        "Start the default run script after setup",
        Kind::Bool,
    ),
    field(
        "scripts.archive",
        "Scripts",
        "Archive script",
        Kind::Multiline,
    ),
    field(
        "environment_variables",
        "Environment",
        "Environment variables",
        Kind::Env,
    ),
    field(
        "environment.instance",
        "Environment",
        "Instance size",
        Kind::Instance,
    ),
    FieldDef {
        hint: Some("5 to 240."),
        ..field(
            "environment.sleep_after_idle_minutes",
            "Environment",
            "Sleep after idle (minutes)",
            Kind::Number,
        )
    },
    FieldDef {
        options: &[("open", "Open"), ("allowlist", "Allowlist")],
        ..field(
            "environment.egress_policy",
            "Environment",
            "Egress policy",
            Kind::Select,
        )
    },
    FieldDef {
        hint: Some("One host per line. *.example.com is allowed."),
        ..field(
            "environment.egress_allowlist",
            "Environment",
            "Egress allowlist",
            Kind::Hosts,
        )
    },
    field("git.branch_prefix", "Git", "Branch prefix", Kind::Text),
    field(
        "git.delete_branch_on_archive",
        "Git",
        "Delete the branch on archive",
        Kind::Bool,
    ),
    field(
        "git.archive_on_merge",
        "Git",
        "Archive on merge",
        Kind::Bool,
    ),
    FieldDef {
        hint: Some("Added to the first prompt of every session."),
        ..field(
            "prompts.general",
            "Prompts",
            "General prompt",
            Kind::Multiline,
        )
    },
    field(
        "roles.enabled",
        "Roles",
        "Enable role triggers and requests",
        Kind::Bool,
    ),
    field(
        "roles.max_chain_depth",
        "Roles",
        "Maximum chain depth",
        Kind::Number,
    ),
    field(
        "roles.max_runs_per_change",
        "Roles",
        "Maximum runs per change",
        Kind::Number,
    ),
    field(
        "roles.max_tokens_per_change",
        "Roles",
        "Maximum tokens per change",
        Kind::Number,
    ),
];

pub const SECTIONS: [&str; 7] = [
    "Agent",
    "Browser",
    "Scripts",
    "Environment",
    "Git",
    "Prompts",
    "Roles",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstanceEdit {
    /// One of [`INSTANCE_PRESETS`] or [`CUSTOM`].
    pub preset: String,
    pub vcpu: String,
    pub memory_mib: String,
    pub disk_mb: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunRow {
    pub id: String,
    pub command: String,
    pub cwd: String,
    pub is_default: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnvRow {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EditValue {
    Text(String),
    Bool(bool),
    Instance(InstanceEdit),
    Run(Vec<RunRow>),
    Env(Vec<EnvRow>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FieldState {
    /// True when the project sets this key itself (a Tempo override).
    pub set: bool,
    pub value: EditValue,
}

pub fn defaults() -> Value {
    serde_json::from_str(include_str!("../../resources/settings-defaults.json"))
        .expect("shared defaults")
}

/// The value at a dotted path. `null` counts as absent.
pub fn get_at<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.')
        .try_fold(value, |v, key| v.as_object()?.get(key))
        .filter(|v| !v.is_null())
}

fn set_at(target: &mut Map<String, Value>, path: &str, value: Value) {
    let mut keys: Vec<&str> = path.split('.').collect();
    let last = keys.pop().unwrap_or_default();
    let mut map = target;
    for key in keys {
        let entry = map.entry(key).or_insert_with(|| json!({}));
        if !entry.is_object() {
            *entry = json!({});
        }
        map = entry.as_object_mut().expect("object");
    }
    map.insert(last.into(), value);
}

fn text_of(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn custom_start(preset: &str) -> InstanceEdit {
    InstanceEdit {
        preset: preset.into(),
        vcpu: "2".into(),
        memory_mib: "8192".into(),
        disk_mb: "10000".into(),
    }
}

/// A stored value as the field's editor value.
pub fn to_edit(def: &FieldDef, value: Option<&Value>) -> EditValue {
    match def.kind {
        Kind::Text | Kind::Multiline | Kind::Select => EditValue::Text(match value {
            Some(Value::String(s)) => s.clone(),
            _ => String::new(),
        }),
        Kind::Number => EditValue::Text(match value {
            Some(Value::Number(n)) => n.to_string(),
            _ => String::new(),
        }),
        Kind::Hosts => EditValue::Text(
            value
                .and_then(Value::as_array)
                .map(|hosts| {
                    hosts
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default(),
        ),
        Kind::Bool => EditValue::Bool(value == Some(&Value::Bool(true))),
        Kind::Instance => EditValue::Instance(match value {
            Some(Value::String(s)) if INSTANCE_PRESETS.contains(&s.as_str()) => custom_start(s),
            Some(Value::Object(o)) => InstanceEdit {
                preset: CUSTOM.into(),
                vcpu: text_of(o.get("vcpu")),
                memory_mib: text_of(o.get("memoryMib")),
                disk_mb: text_of(o.get("diskMb")),
            },
            _ => custom_start("standard-3"),
        }),
        Kind::Run => EditValue::Run(
            value
                .and_then(Value::as_object)
                .map(|scripts| {
                    scripts
                        .iter()
                        .map(|(id, s)| RunRow {
                            id: id.clone(),
                            command: text_of(s.get("command")),
                            cwd: text_of(s.get("cwd")),
                            is_default: s.get("default") == Some(&Value::Bool(true)),
                        })
                        .collect()
                })
                .unwrap_or_default(),
        ),
        Kind::Env => EditValue::Env(
            value
                .and_then(Value::as_object)
                .map(|vars| {
                    vars.iter()
                        .map(|(name, v)| EnvRow {
                            name: name.clone(),
                            value: v.as_str().unwrap_or_default().into(),
                        })
                        .collect()
                })
                .unwrap_or_default(),
        ),
    }
}

/// `HostPattern` in packages/protocol: `(*.)?label(.label)*`, lowercase.
pub fn is_host(host: &str) -> bool {
    let host = host.strip_prefix("*.").unwrap_or(host);
    !host.is_empty()
        && host.split('.').all(|label| {
            let b = label.as_bytes();
            let alnum = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
            !b.is_empty()
                && alnum(&b[0])
                && alnum(&b[b.len() - 1])
                && b.iter().all(|c| alnum(c) || *c == b'-')
        })
}

/// `EnvName` in packages/protocol.
pub fn is_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_uppercase() || c == '_')
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

fn whole(text: &str) -> Option<i64> {
    let text = text.trim();
    (!text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse().ok())
        .flatten()
}

/// The editor value as a layer value, or the reason it is not valid.
pub fn from_edit(def: &FieldDef, edit: &EditValue) -> Result<Value, String> {
    match edit {
        EditValue::Text(text) => match def.kind {
            Kind::Number if def.path.starts_with("roles.") => {
                let min = if def.path == "roles.max_tokens_per_change" {
                    0
                } else {
                    1
                };
                match whole(text) {
                    Some(n) if n >= min && n <= 9_007_199_254_740_991 => Ok(json!(n)),
                    _ => Err(format!("Use a whole number of at least {min}.")),
                }
            }
            Kind::Number => match whole(text) {
                Some(n) if (5..=240).contains(&n) => Ok(json!(n)),
                _ => Err("Use a whole number from 5 to 240.".into()),
            },
            Kind::Hosts => {
                let hosts: Vec<String> = text
                    .lines()
                    .map(|l| l.trim().to_lowercase())
                    .filter(|l| !l.is_empty())
                    .collect();
                match hosts.iter().find(|h| !is_host(h)) {
                    Some(bad) => Err(format!("Not a host pattern: {bad}")),
                    None => Ok(json!(hosts)),
                }
            }
            Kind::Select => {
                if def.options.iter().any(|(value, _)| value == text) {
                    Ok(json!(text))
                } else {
                    Err("Pick a value.".into())
                }
            }
            Kind::Text => Ok(json!(text.trim())),
            _ => Ok(json!(text)),
        },
        EditValue::Bool(on) => Ok(json!(on)),
        EditValue::Instance(i) => {
            if i.preset != CUSTOM {
                return Ok(json!(i.preset));
            }
            let parts = [&i.vcpu, &i.memory_mib, &i.disk_mb].map(|s| whole(s));
            match parts {
                [Some(vcpu), Some(memory), Some(disk)]
                    if (1..=4).contains(&vcpu)
                        && (4096..=12288).contains(&memory)
                        && (1..=20000).contains(&disk)
                        && memory >= vcpu * 3072 =>
                {
                    Ok(json!({"vcpu": vcpu, "memoryMib": memory, "diskMb": disk}))
                }
                _ => Err("Use 1 to 4 vCPU, 4096 to 12288 MiB of memory (3072 MiB per vCPU at least) and 1 to 20000 MB of disk.".into()),
            }
        }
        EditValue::Run(rows) => {
            let mut out = Map::new();
            for r in rows {
                let id = r.id.trim();
                if id.is_empty() {
                    return Err("Each run script needs a name.".into());
                }
                if out.contains_key(id) {
                    return Err(format!("Two run scripts are named {id}."));
                }
                if r.command.trim().is_empty() {
                    return Err(format!("Run script {id} needs a command."));
                }
                let mut script = Map::new();
                script.insert("command".into(), json!(r.command));
                if !r.cwd.trim().is_empty() {
                    script.insert("cwd".into(), json!(r.cwd.trim()));
                }
                if r.is_default {
                    script.insert("default".into(), json!(true));
                }
                out.insert(id.into(), Value::Object(script));
            }
            Ok(Value::Object(out))
        }
        EditValue::Env(rows) => {
            let mut out = Map::new();
            for r in rows {
                let name = r.name.trim();
                if name.is_empty() {
                    return Err("Each variable needs a name.".into());
                }
                if out.contains_key(name) {
                    return Err(format!("Two variables are named {name}."));
                }
                out.insert(name.into(), json!(r.value));
            }
            Ok(Value::Object(out))
        }
    }
}

fn is_record(def: &FieldDef) -> bool {
    matches!(def.kind, Kind::Run | Kind::Env)
}

/// The form for a project's saved overrides, one state per entry of [`FIELDS`]. A field the
/// project does not set starts from its effective value, so turning the override on keeps what
/// is in use. Run scripts and variables merge per entry with the repo files, so their editors
/// hold only the project's own entries.
pub fn form_from_layer(layer: &Value, effective: &Value) -> Vec<FieldState> {
    let empty = json!({});
    FIELDS
        .iter()
        .map(|def| {
            let own = get_at(layer, def.path);
            let start = own.or_else(|| {
                if is_record(def) {
                    Some(&empty)
                } else {
                    get_at(effective, def.path)
                }
            });
            FieldState {
                set: own.is_some(),
                value: to_edit(def, start),
            }
        })
        .collect()
}

/// The layer to save, or the fields that are not valid, by path.
pub fn layer_from_form(form: &[FieldState]) -> (Value, BTreeMap<&'static str, String>) {
    let mut layer = Map::new();
    let mut errors = BTreeMap::new();
    for (def, state) in FIELDS.iter().zip(form) {
        if !state.set {
            continue;
        }
        match from_edit(def, &state.value) {
            Ok(value) => set_at(&mut layer, def.path, value),
            Err(error) => {
                errors.insert(def.path, error);
            }
        }
    }
    (Value::Object(layer), errors)
}

/// Where the effective values come from.
pub struct EffectiveContext<'a> {
    /// The open workspace's effective settings, when it belongs to this project.
    pub settings: Option<&'a Value>,
    pub sources: Option<&'a BTreeMap<String, SettingsSource>>,
    /// The project's saved overrides.
    pub layer: &'a Value,
    pub defaults: &'a Value,
}

/// `SETTINGS_SOURCE_LABELS` in packages/protocol.
pub fn source_label(source: SettingsSource) -> &'static str {
    match source {
        SettingsSource::Tempo => "Tempo",
        SettingsSource::Xtempo => ".tempo",
        SettingsSource::Default => "default",
    }
}

fn source_of(ctx: &EffectiveContext, path: &str, from_layer: bool) -> SettingsSource {
    match (ctx.settings, ctx.sources) {
        (Some(_), Some(sources)) => sources
            .get(path)
            .copied()
            .unwrap_or(SettingsSource::Default),
        _ if from_layer => SettingsSource::Tempo,
        _ => SettingsSource::Default,
    }
}

pub fn format_value(def: &FieldDef, value: Option<&Value>) -> String {
    match def.kind {
        Kind::Bool => if value == Some(&Value::Bool(true)) {
            "On"
        } else {
            "Off"
        }
        .into(),
        Kind::Select => {
            let text = text_of(value);
            def.options
                .iter()
                .find(|(v, _)| *v == text)
                .map_or(text, |(_, label)| (*label).into())
        }
        Kind::Hosts => match value.and_then(Value::as_array) {
            Some(hosts) if !hosts.is_empty() => hosts
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", "),
            _ => "None".into(),
        },
        Kind::Instance => value
            .and_then(|v| serde_json::from_value::<tempo_protocol::Instance>(v.clone()).ok())
            .map(|i| super::indicators::instance_label(&i))
            .unwrap_or_default(),
        Kind::Number => text_of(value),
        _ => match value {
            Some(Value::String(s)) if !s.is_empty() => s.clone(),
            _ => "Empty".into(),
        },
    }
}

/// One leaf key's effective value and source.
pub fn effective_leaf(def: &FieldDef, ctx: &EffectiveContext) -> (String, SettingsSource) {
    let own = get_at(ctx.layer, def.path);
    let value = match ctx.settings {
        Some(settings) => get_at(settings, def.path),
        None => own.or_else(|| get_at(ctx.defaults, def.path)),
    };
    (
        format_value(def, value),
        source_of(ctx, def.path, own.is_some()),
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EffectiveEntry {
    pub key: String,
    pub text: String,
    pub source: SettingsSource,
}

/// Run scripts or variables in effect, one row per entry with its own source.
pub fn effective_entries(def: &FieldDef, ctx: &EffectiveContext) -> Vec<EffectiveEntry> {
    let Some(record) =
        get_at(ctx.settings.unwrap_or(ctx.layer), def.path).and_then(Value::as_object)
    else {
        return vec![];
    };
    let own = get_at(ctx.layer, def.path).and_then(Value::as_object);
    let prefix = if def.kind == Kind::Run {
        "scripts.run"
    } else {
        "environment_variables"
    };
    record
        .iter()
        .map(|(key, v)| {
            let text = if def.kind == Kind::Run {
                let cwd = text_of(v.get("cwd"));
                format!(
                    "{}{}{}",
                    text_of(v.get("command")),
                    if cwd.is_empty() {
                        String::new()
                    } else {
                        format!(" (in {cwd})")
                    },
                    if v.get("default") == Some(&Value::Bool(true)) {
                        " · default"
                    } else {
                        ""
                    }
                )
            } else {
                format!("{key}={}", v.as_str().unwrap_or_default())
            };
            EffectiveEntry {
                key: key.clone(),
                text,
                source: source_of(
                    ctx,
                    &format!("{prefix}.{key}"),
                    own.is_some_and(|o| o.contains_key(key)),
                ),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(path: &str) -> &'static FieldDef {
        FIELDS.iter().find(|f| f.path == path).unwrap()
    }

    fn ix(path: &str) -> usize {
        FIELDS.iter().position(|f| f.path == path).unwrap()
    }

    #[test]
    fn every_field_has_a_section_in_order() {
        let mut seen = vec![];
        for f in FIELDS {
            assert!(SECTIONS.contains(&f.section), "{}", f.path);
            if seen.last() != Some(&f.section) {
                seen.push(f.section);
            }
        }
        assert_eq!(seen, SECTIONS);
    }

    #[test]
    fn unset_fields_start_from_the_effective_value_and_records_start_empty() {
        let layer = json!({"git": {"branch_prefix": "me/"}, "scripts": {"run": {"dev": {"command": "bun dev", "default": true}}}});
        let form = form_from_layer(&layer, &defaults());
        assert!(form[ix("git.branch_prefix")].set);
        assert_eq!(
            form[ix("git.branch_prefix")].value,
            EditValue::Text("me/".into())
        );
        assert!(!form[ix("environment.sleep_after_idle_minutes")].set);
        assert_eq!(
            form[ix("environment.sleep_after_idle_minutes")].value,
            EditValue::Text("15".into())
        );
        assert_eq!(
            form[ix("environment_variables")].value,
            EditValue::Env(vec![])
        );
        assert_eq!(
            form[ix("scripts.run")].value,
            EditValue::Run(vec![RunRow {
                id: "dev".into(),
                command: "bun dev".into(),
                cwd: String::new(),
                is_default: true
            }])
        );
        assert_eq!(
            form[ix("environment.instance")].value,
            EditValue::Instance(custom_start("standard-3"))
        );
    }

    #[test]
    fn only_set_fields_are_saved_and_the_layer_decodes() {
        let mut form = form_from_layer(&json!({}), &defaults());
        form[ix("environment.sleep_after_idle_minutes")] = FieldState {
            set: true,
            value: EditValue::Text(" 30 ".into()),
        };
        form[ix("environment.egress_allowlist")] = FieldState {
            set: true,
            value: EditValue::Text("Example.com\n\n*.api.dev".into()),
        };
        form[ix("environment.instance")] = FieldState {
            set: true,
            value: EditValue::Instance(InstanceEdit {
                preset: CUSTOM.into(),
                vcpu: "2".into(),
                memory_mib: "8192".into(),
                disk_mb: "100".into(),
            }),
        };
        form[ix("environment_variables")] = FieldState {
            set: true,
            value: EditValue::Env(vec![EnvRow {
                name: " APP_MODE ".into(),
                value: "dev".into(),
            }]),
        };
        let (layer, errors) = layer_from_form(&form);
        assert!(errors.is_empty(), "{errors:?}");
        assert_eq!(
            layer,
            json!({
                "environment": {
                    "sleep_after_idle_minutes": 30,
                    "egress_allowlist": ["example.com", "*.api.dev"],
                    "instance": {"vcpu": 2, "memoryMib": 8192, "diskMb": 100}
                },
                "environment_variables": {"APP_MODE": "dev"}
            })
        );
        let decoded: tempo_protocol::SettingsLayer = serde_json::from_value(layer).unwrap();
        assert_eq!(
            decoded.environment.unwrap().sleep_after_idle_minutes,
            Some(30)
        );
    }

    #[test]
    fn run_ids_with_dots_remain_one_key() {
        let mut form = form_from_layer(&json!({}), &defaults());
        form[ix("scripts.run")] = FieldState {
            set: true,
            value: EditValue::Run(vec![RunRow {
                id: "dev.web".into(),
                command: "bun dev".into(),
                cwd: " web ".into(),
                is_default: true,
            }]),
        };
        let (layer, errors) = layer_from_form(&form);
        assert!(errors.is_empty());
        assert_eq!(
            layer,
            json!({"scripts": {"run": {"dev.web": {"command": "bun dev", "cwd": "web", "default": true}}}})
        );
        let decoded: tempo_protocol::SettingsLayer = serde_json::from_value(layer).unwrap();
        assert!(
            decoded
                .scripts
                .unwrap()
                .run
                .unwrap()
                .contains_key("dev.web")
        );
    }

    #[test]
    fn invalid_values_name_the_problem() {
        let number = def("environment.sleep_after_idle_minutes");
        for bad in ["4", "241", "1.5", "", "x"] {
            assert!(
                from_edit(number, &EditValue::Text(bad.into())).is_err(),
                "{bad}"
            );
        }
        assert_eq!(
            from_edit(
                def("environment.egress_allowlist"),
                &EditValue::Text("ok.com\nbad_host".into())
            ),
            Err("Not a host pattern: bad_host".into())
        );
        assert_eq!(
            from_edit(def("agent.default"), &EditValue::Text("gpt".into())),
            Err("Pick a value.".into())
        );
        let low_memory = EditValue::Instance(InstanceEdit {
            preset: CUSTOM.into(),
            vcpu: "4".into(),
            memory_mib: "8192".into(),
            disk_mb: "10".into(),
        });
        assert!(from_edit(def("environment.instance"), &low_memory).is_err());
        let twice = EditValue::Run(vec![
            RunRow {
                id: "dev".into(),
                command: "a".into(),
                cwd: String::new(),
                is_default: false,
            },
            RunRow {
                id: "dev".into(),
                command: "b".into(),
                cwd: String::new(),
                is_default: false,
            },
        ]);
        assert_eq!(
            from_edit(def("scripts.run"), &twice),
            Err("Two run scripts are named dev.".into())
        );
        let mut form = form_from_layer(&json!({}), &defaults());
        form[ix("agent.default")] = FieldState {
            set: true,
            value: EditValue::Text("nope".into()),
        };
        let (_, errors) = layer_from_form(&form);
        assert_eq!(
            errors.keys().copied().collect::<Vec<_>>(),
            ["agent.default"]
        );
    }

    #[test]
    fn defaults_match_the_protocol_defaults() {
        let fixture = include_str!("../../../../packages/protocol/fixtures/types/Settings.jsonl");
        let first: Value = serde_json::from_str(fixture.lines().next().unwrap()).unwrap();
        assert_eq!(defaults(), first);
        let typed: tempo_protocol::Settings = serde_json::from_value(defaults()).unwrap();
        assert_eq!(typed.agent.models.opencode, "");
        assert!(!typed.browser.run);
    }

    #[test]
    fn every_settings_leaf_has_one_field() {
        fn leaves(value: &Value, prefix: &str, out: &mut Vec<String>) {
            for (key, v) in value.as_object().unwrap() {
                let path = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                if v.is_object() && path != "scripts.run" && path != "environment_variables" {
                    leaves(v, &path, out);
                } else {
                    out.push(path);
                }
            }
        }
        let mut expected = vec![];
        leaves(&defaults(), "", &mut expected);
        expected.sort();
        let mut paths: Vec<String> = FIELDS.iter().map(|f| f.path.to_string()).collect();
        paths.sort();
        assert_eq!(paths, expected);
    }

    #[test]
    fn agent_models_and_browser_run_save_as_a_layer() {
        let layer = json!({"agent": {"models": {"codex": "gpt-5-codex"}}});
        let mut form = form_from_layer(&layer, &defaults());
        assert!(form[ix("agent.models.codex")].set);
        assert_eq!(
            form[ix("agent.models.pi")],
            FieldState {
                set: false,
                value: EditValue::Text(String::new())
            }
        );
        assert_eq!(form[ix("browser.run")].value, EditValue::Bool(false));
        form[ix("agent.models.pi")] = FieldState {
            set: true,
            value: EditValue::Text(" openrouter/pi ".into()),
        };
        form[ix("browser.run")] = FieldState {
            set: true,
            value: EditValue::Bool(true),
        };
        let (layer, errors) = layer_from_form(&form);
        assert!(errors.is_empty(), "{errors:?}");
        assert_eq!(
            layer,
            json!({
                "agent": {"models": {"codex": "gpt-5-codex", "pi": "openrouter/pi"}},
                "browser": {"run": true}
            })
        );
        let decoded: tempo_protocol::SettingsLayer = serde_json::from_value(layer).unwrap();
        assert_eq!(
            decoded.agent.unwrap().models.unwrap().pi.as_deref(),
            Some("openrouter/pi")
        );
        assert_eq!(decoded.browser.unwrap().run, Some(true));
    }

    #[test]
    fn agent_models_show_their_effective_value_and_source() {
        let defaults = defaults();
        let mut settings = defaults.clone();
        settings["agent"]["models"]["pi"] = json!("openrouter/pi");
        settings["browser"]["run"] = json!(true);
        let sources = BTreeMap::from([
            ("agent.models.pi".to_string(), SettingsSource::Xtempo),
            ("browser.run".to_string(), SettingsSource::Tempo),
        ]);
        let layer = json!({"browser": {"run": true}});
        let open = EffectiveContext {
            settings: Some(&settings),
            sources: Some(&sources),
            layer: &layer,
            defaults: &defaults,
        };
        assert_eq!(
            effective_leaf(def("agent.models.pi"), &open),
            ("openrouter/pi".into(), SettingsSource::Xtempo)
        );
        assert_eq!(
            effective_leaf(def("agent.models.opencode"), &open),
            ("Empty".into(), SettingsSource::Default)
        );
        assert_eq!(
            effective_leaf(def("browser.run"), &open),
            ("On".into(), SettingsSource::Tempo)
        );
    }

    #[test]
    fn hosts_and_secret_names() {
        for good in ["example.com", "*.example.com", "a-b.c1", "localhost"] {
            assert!(is_host(good), "{good}");
        }
        for bad in ["-a.com", "a-.com", "a..com", "*.", "A.com", "*.*.a.com", ""] {
            assert!(!is_host(bad), "{bad}");
        }
        assert!(is_env_name("API_TOKEN") && is_env_name("_X1"));
        assert!(!is_env_name("1X") && !is_env_name("api") && !is_env_name(""));
    }

    #[test]
    fn effective_values_name_their_source() {
        let layer = json!({"git": {"branch_prefix": "me/"}, "environment_variables": {"A": "1"}});
        let defaults = defaults();
        let no_workspace = EffectiveContext {
            settings: None,
            sources: None,
            layer: &layer,
            defaults: &defaults,
        };
        assert_eq!(
            effective_leaf(def("git.branch_prefix"), &no_workspace),
            ("me/".into(), SettingsSource::Tempo)
        );
        assert_eq!(
            effective_leaf(def("environment.instance"), &no_workspace),
            ("standard-3".into(), SettingsSource::Default)
        );
        assert_eq!(
            effective_leaf(def("git.archive_on_merge"), &no_workspace).0,
            "Off"
        );
        let mut settings = defaults.clone();
        settings["environment_variables"] = json!({"A": "1", "B": "2"});
        settings["environment"]["egress_policy"] = json!("allowlist");
        let sources = BTreeMap::from([
            (
                "environment_variables.B".to_string(),
                SettingsSource::Xtempo,
            ),
            (
                "environment.egress_policy".to_string(),
                SettingsSource::Tempo,
            ),
        ]);
        let open = EffectiveContext {
            settings: Some(&settings),
            sources: Some(&sources),
            layer: &layer,
            defaults: &defaults,
        };
        assert_eq!(
            effective_leaf(def("environment.egress_policy"), &open),
            ("Allowlist".into(), SettingsSource::Tempo)
        );
        let entries = effective_entries(def("environment_variables"), &open);
        assert_eq!(
            entries
                .iter()
                .map(|e| (e.text.as_str(), source_label(e.source)))
                .collect::<Vec<_>>(),
            [("A=1", "default"), ("B=2", ".tempo")]
        );
        assert_eq!(source_label(SettingsSource::Tempo), "Tempo");
    }
}
