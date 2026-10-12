//! Named environments (01, Environments) in Settings, the Environment… dialog and the proposal
//! review (04): copy and the pure parts of each form.
use tempo_protocol::{self as p, Environment, EnvironmentProposal};

pub const NEW_ENVIRONMENT: &str = "New environment";
pub const ENVIRONMENT_DIALOG_NOTE: &str = "Changes apply to new requests within a minute. Scripts and agents started later get the new secrets.";
pub const PROPOSAL_BANNER: &str = "The agent suggests environment changes";
pub const INJECTOR_WARNING: &str =
    "Injectors run with access to these secrets. Read the code before you apply.";
pub const VISIBLE_TO_AGENT: &str = "Visible to the agent";
pub const VALUES_HIDDEN: &str = "Values are never shown again.";

/// The environment with `id`, if it still exists; a missing id counts as none (01).
pub fn find<'a>(environments: &'a [Environment], id: Option<&str>) -> Option<&'a Environment> {
    id.and_then(|id| environments.iter().find(|e| e.id == id))
}

/// Which environment applies (01): the workspace override, else the project's, else none.
pub fn applies<'a>(
    environments: &'a [Environment],
    workspace: Option<&str>,
    project: Option<&str>,
) -> Option<&'a Environment> {
    find(environments, workspace).or_else(|| find(environments, project))
}

/// The first entry of the Environment… select.
pub fn project_default_label(environments: &[Environment], project: Option<&str>) -> String {
    format!(
        "Project default ({})",
        find(environments, project).map_or("None", |e| e.name.as_str())
    )
}

/// `(value, label)` entries of a select: the empty value means none or the project default.
pub fn select_entries(first: String, environments: &[Environment]) -> Vec<(String, String)> {
    std::iter::once((String::new(), first))
        .chain(environments.iter().map(|e| (e.id.clone(), e.name.clone())))
        .collect()
}

/// A select value back to an `environmentId`: empty means none.
pub fn selected_id(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_owned())
}

pub fn set_by(name: &str) -> String {
    format!("Set by environment {name}")
}

/// Settings paths that an environment controls while one is selected for the project.
pub fn is_egress_setting(path: &str) -> bool {
    matches!(
        path,
        "environment.egress_policy" | "environment.egress_allowlist"
    )
}

pub fn delete_confirm(name: &str) -> String {
    format!("Delete environment {name}? Projects that use it will use none.")
}

/// The warning or hint under a secret row.
pub fn secret_hint(name: &str, hosts: &[String]) -> String {
    if hosts.is_empty() {
        VISIBLE_TO_AGENT.into()
    } else {
        format!(
            "Use ${name} in the app; Tempo adds the value for {}",
            hosts.join(", ")
        )
    }
}

pub fn set_label(set: bool) -> &'static str {
    if set { "Set" } else { "Not set" }
}

/// One pattern per line.
pub fn lines(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `hosts`, comma separated.
pub fn hosts(text: &str) -> Vec<String> {
    text.split(',')
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .map(str::to_owned)
        .collect()
}

pub fn hosts_text(hosts: &[String]) -> String {
    hosts.join(", ")
}

/// The dialog target line of the proposal review.
pub fn target_label(target: Option<&Environment>, repo: &str) -> String {
    match target {
        Some(e) => format!("Apply to {}", e.name),
        None => format!("Create environment {repo} and use it for this project"),
    }
}

/// Secrets of the proposal that get a value field: new ones, and listed ones with no stored value.
pub fn value_fields(target: Option<&Environment>, proposal: &EnvironmentProposal) -> Vec<String> {
    proposal
        .secrets
        .iter()
        .flatten()
        .filter(|s| {
            !target
                .into_iter()
                .flat_map(|t| &t.secrets)
                .any(|stored| stored.name == s.name && stored.set)
        })
        .map(|s| s.name.clone())
        .collect()
}

/// The proposal's changes as titled lists, in 04's order: policy, hosts to add, secrets.
/// Injectors are shown with their full code by the view.
pub fn change_lists(proposal: &EnvironmentProposal) -> Vec<(&'static str, Vec<String>)> {
    let mut out = vec![];
    if let Some(policy) = proposal.egress_policy {
        out.push(("Egress policy", vec![policy.to_string()]));
    }
    if let Some(add) = proposal.allowlist_add.as_ref().filter(|a| !a.is_empty()) {
        out.push(("Hosts to add", add.clone()));
    }
    if let Some(secrets) = proposal.secrets.as_ref().filter(|s| !s.is_empty()) {
        out.push((
            "Secrets",
            secrets
                .iter()
                .map(|s| {
                    if s.hosts.is_empty() {
                        format!("{} · {VISIBLE_TO_AGENT}", s.name)
                    } else {
                        format!("{} · {}", s.name, hosts_text(&s.hosts))
                    }
                })
                .collect(),
        ));
    }
    out
}

pub fn has_injectors(proposal: &EnvironmentProposal) -> bool {
    proposal.injectors.as_ref().is_some_and(|i| !i.is_empty())
}

/// The text of one secret row in the editor.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SecretDraft {
    pub name: String,
    pub hosts: String,
    pub value: String,
}

/// The text of one injector row in the editor.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct InjectorDraft {
    pub name: String,
    pub hosts: String,
    pub code: String,
}

/// The editor's fields as text.
#[derive(Clone, Debug, PartialEq)]
pub struct EnvironmentDraft {
    pub name: String,
    pub policy: p::EgressPolicy,
    pub allowlist: String,
    pub secrets: Vec<SecretDraft>,
    pub injectors: Vec<InjectorDraft>,
}

impl EnvironmentDraft {
    pub fn from_environment(e: &Environment) -> Self {
        Self {
            name: e.name.clone(),
            policy: e.egress_policy,
            allowlist: e.egress_allowlist.join("\n"),
            secrets: e
                .secrets
                .iter()
                .map(|s| SecretDraft {
                    name: s.name.clone(),
                    hosts: hosts_text(&s.hosts),
                    value: String::new(),
                })
                .collect(),
            injectors: e
                .injectors
                .iter()
                .map(|i| InjectorDraft {
                    name: i.name.clone(),
                    hosts: hosts_text(&i.hosts),
                    code: i.code.clone(),
                })
                .collect(),
        }
    }

    /// Save: the whole `updateEnvironment` input, then `(name, value)` for each filled value.
    /// Rows without a name are skipped. The server checks names, patterns and limits.
    pub fn save(
        &self,
        environment_id: &str,
    ) -> Result<(p::UpdateEnvironmentIn, Vec<(String, String)>), String> {
        let name = self
            .name
            .trim()
            .parse()
            .map_err(|_| "Enter a name of 1 to 64 characters.".to_owned())?;
        let secrets: Vec<_> = self
            .secrets
            .iter()
            .filter(|s| !s.name.trim().is_empty())
            .collect();
        let update = p::UpdateEnvironmentIn {
            environment_id: environment_id.to_owned(),
            name: Some(name),
            egress_policy: Some(self.policy),
            egress_allowlist: Some(lines(&self.allowlist)),
            secrets: Some(
                secrets
                    .iter()
                    .map(|s| p::SecretBinding {
                        name: s.name.trim().to_owned(),
                        hosts: hosts(&s.hosts),
                    })
                    .collect(),
            ),
            injectors: Some(
                self.injectors
                    .iter()
                    .filter(|i| !i.name.trim().is_empty())
                    .map(|i| p::InjectorInput {
                        name: i.name.trim().to_owned(),
                        hosts: hosts(&i.hosts),
                        code: i.code.clone(),
                    })
                    .collect(),
            ),
        };
        let values = secrets
            .iter()
            .filter(|s| !s.value.is_empty())
            .map(|s| (s.name.trim().to_owned(), s.value.clone()))
            .collect();
        Ok((update, values))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn environments() -> Vec<Environment> {
        include_str!("../../../../packages/protocol/fixtures/types/Environment.jsonl")
            .lines()
            .map(|l| serde_json::from_str(l).expect("environment"))
            .collect()
    }

    fn proposals() -> Vec<EnvironmentProposal> {
        include_str!("../../../../packages/protocol/fixtures/types/EnvironmentProposal.jsonl")
            .lines()
            .map(|l| serde_json::from_str(l).expect("proposal"))
            .collect()
    }

    const PAYMENTS: &str = "01k700000000000000000000w5";
    const OPEN: &str = "01k700000000000000000000w6";

    #[test]
    fn the_workspace_override_wins_and_a_missing_id_counts_as_none() {
        let all = environments();
        assert_eq!(
            applies(&all, Some(OPEN), Some(PAYMENTS)).unwrap().name,
            "Open"
        );
        assert_eq!(
            applies(&all, None, Some(PAYMENTS)).unwrap().name,
            "Payments"
        );
        assert_eq!(
            applies(&all, Some("gone"), Some(PAYMENTS)).unwrap().name,
            "Payments"
        );
        assert!(applies(&all, Some("gone"), Some("gone")).is_none());
        assert!(applies(&all, None, None).is_none());
    }

    #[test]
    fn dialog_and_settings_copy_match_04() {
        let all = environments();
        assert_eq!(
            project_default_label(&all, Some(PAYMENTS)),
            "Project default (Payments)"
        );
        assert_eq!(
            project_default_label(&all, Some("gone")),
            "Project default (None)"
        );
        assert_eq!(
            select_entries("None".into(), &all),
            [
                (String::new(), "None".to_owned()),
                (PAYMENTS.to_owned(), "Payments".to_owned()),
                (OPEN.to_owned(), "Open".to_owned()),
            ]
        );
        assert_eq!(selected_id(""), None);
        assert_eq!(selected_id(OPEN).as_deref(), Some(OPEN));
        assert_eq!(set_by("Payments"), "Set by environment Payments");
        assert_eq!(
            delete_confirm("Payments"),
            "Delete environment Payments? Projects that use it will use none."
        );
        assert_eq!(secret_hint("DB_URL", &[]), "Visible to the agent");
        assert_eq!(
            secret_hint(
                "STRIPE_KEY",
                &["api.stripe.com".into(), "*.stripe.com".into()]
            ),
            "Use $STRIPE_KEY in the app; Tempo adds the value for api.stripe.com, *.stripe.com"
        );
        assert_eq!(target_label(all.first(), "webapp"), "Apply to Payments");
        assert_eq!(
            target_label(None, "webapp"),
            "Create environment webapp and use it for this project"
        );
    }

    #[test]
    fn only_environment_egress_fields_are_controlled_by_an_environment() {
        assert!(is_egress_setting("environment.egress_policy"));
        assert!(is_egress_setting("environment.egress_allowlist"));
        assert!(!is_egress_setting("environment.instance"));
        assert!(!is_egress_setting("environment_variables.egress_policy"));
    }

    #[test]
    fn value_fields_are_new_secrets_and_listed_ones_without_a_value() {
        let all = environments();
        let mut proposal = proposals().remove(0);
        assert!(
            value_fields(all.first(), &proposal).is_empty(),
            "STRIPE_KEY is set"
        );
        assert_eq!(value_fields(None, &proposal), ["STRIPE_KEY"]);
        proposal.secrets = Some(vec![
            p::SecretBinding {
                name: "LOCAL_DB_URL".into(),
                hosts: vec![],
            },
            p::SecretBinding {
                name: "NEW".into(),
                hosts: vec!["a.example.com".into()],
            },
        ]);
        assert_eq!(
            value_fields(all.first(), &proposal),
            ["LOCAL_DB_URL", "NEW"]
        );
    }

    #[test]
    fn change_lists_follow_04_order() {
        let [first, second] = <[_; 2]>::try_from(proposals()).unwrap();
        assert_eq!(
            change_lists(&first),
            [
                (
                    "Hosts to add",
                    vec!["pypi.org".to_owned(), "files.pythonhosted.org".into()]
                ),
                ("Secrets", vec!["STRIPE_KEY · api.stripe.com".to_owned()]),
            ]
        );
        assert!(!has_injectors(&first));
        assert_eq!(
            change_lists(&second),
            [("Egress policy", vec!["allowlist".to_owned()])]
        );
        assert!(has_injectors(&second));
    }

    #[test]
    fn text_fields_parse_one_pattern_per_line_and_comma_separated_hosts() {
        assert_eq!(
            lines(" pypi.org \n\n*.stripe.com\n"),
            ["pypi.org", "*.stripe.com"]
        );
        assert_eq!(hosts("a.com, ,b.com,"), ["a.com", "b.com"]);
        assert_eq!(
            hosts_text(&["a.com".into(), "b.com".into()]),
            "a.com, b.com"
        );
    }

    #[test]
    fn a_draft_round_trips_and_save_sends_the_whole_lists_and_filled_values() {
        let all = environments();
        let mut draft = EnvironmentDraft::from_environment(&all[0]);
        assert_eq!(draft.allowlist, "pypi.org\n*.stripe.com");
        assert_eq!(draft.secrets[0].hosts, "api.stripe.com");
        draft.secrets[1].value = "postgres://x".into();
        draft.secrets.push(SecretDraft::default());
        draft.injectors.push(InjectorDraft::default());
        let (update, values) = draft.save(PAYMENTS).expect("valid");
        let json = serde_json::to_value(&update).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "environmentId": PAYMENTS,
                "name": "Payments",
                "egressPolicy": "allowlist",
                "egressAllowlist": ["pypi.org", "*.stripe.com"],
                "secrets": [
                    {"name": "STRIPE_KEY", "hosts": ["api.stripe.com"]},
                    {"name": "LOCAL_DB_URL", "hosts": []}
                ],
                "injectors": [{
                    "name": "aws-sigv4",
                    "hosts": ["s3.amazonaws.com"],
                    "code": all[0].injectors[0].code
                }]
            })
        );
        assert_eq!(
            values,
            [("LOCAL_DB_URL".to_owned(), "postgres://x".to_owned())]
        );
        draft.name = " ".into();
        assert!(draft.save(PAYMENTS).is_err());
    }
}
