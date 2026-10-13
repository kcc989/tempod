//! Named environments (01, Environments): applying an agent proposal the way 04 describes it
//! (Center, Pending environment proposals). The RPC calls themselves go through [`Client::call`].
use std::future::Future;

use tempo_protocol::{
    self as p, Environment, EnvironmentProposal, InjectorInput, SecretBinding, UpdateEnvironmentIn,
    api,
};

use crate::{ApiError, Client};

/// The longest environment name (01, Environments).
pub const ENVIRONMENT_NAME_MAX: usize = 64;

/// `updateEnvironment` input for `environment` with `proposal` applied. A proposal only adds or
/// replaces: allowlist patterns are added without duplicates, and secrets and injectors are
/// upserted by name. Nothing is removed.
pub fn merge_proposal(
    environment: &Environment,
    proposal: &EnvironmentProposal,
) -> UpdateEnvironmentIn {
    let mut allowlist = environment.egress_allowlist.clone();
    for host in proposal.allowlist_add.iter().flatten() {
        if !allowlist.contains(host) {
            allowlist.push(host.clone());
        }
    }
    let mut secrets: Vec<SecretBinding> = environment
        .secrets
        .iter()
        .map(|s| SecretBinding {
            name: s.name.clone(),
            hosts: s.hosts.clone(),
        })
        .collect();
    for secret in proposal.secrets.iter().flatten() {
        match secrets.iter_mut().find(|s| s.name == secret.name) {
            Some(existing) => existing.hosts = secret.hosts.clone(),
            None => secrets.push(secret.clone()),
        }
    }
    let mut injectors: Vec<InjectorInput> = environment
        .injectors
        .iter()
        .map(|i| InjectorInput {
            name: i.name.clone(),
            hosts: i.hosts.clone(),
            code: i.code.clone(),
        })
        .collect();
    for injector in proposal.injectors.iter().flatten() {
        match injectors.iter_mut().find(|i| i.name == injector.name) {
            Some(existing) => *existing = injector.clone(),
            None => injectors.push(injector.clone()),
        }
    }
    UpdateEnvironmentIn {
        environment_id: environment.id.clone(),
        name: None,
        egress_policy: Some(proposal.egress_policy.unwrap_or(environment.egress_policy)),
        egress_allowlist: Some(allowlist),
        secrets: Some(secrets),
        injectors: Some(injectors),
    }
}

/// `base`, or `base 2`, `base 3` and so on when the name is taken. Cut to fit the name limit.
pub fn unique_name<'a>(base: &str, taken: impl IntoIterator<Item = &'a str> + Clone) -> String {
    let base = base.trim();
    let base = if base.is_empty() { "Environment" } else { base };
    (1..)
        .map(|n| {
            let suffix = if n == 1 {
                String::new()
            } else {
                format!(" {n}")
            };
            let room = ENVIRONMENT_NAME_MAX - suffix.chars().count();
            let head: String = base.chars().take(room).collect();
            format!("{}{suffix}", head.trim_end())
        })
        .find(|name| !taken.clone().into_iter().any(|t| t == name))
        .expect("an unused name")
}

/// One Apply of the proposal review dialog (04).
#[derive(Clone, Debug, PartialEq)]
pub struct ProposalApply {
    pub workspace_id: String,
    pub proposal_id: String,
    pub proposal: EnvironmentProposal,
    /// The environment that applies to the workspace, or `None` to create one for the project.
    pub target: Option<Environment>,
    pub project_id: String,
    /// The name for a new environment, usually the repo name; made unique against `taken`.
    pub new_name: String,
    /// Names of the owner's environments.
    pub taken: Vec<String>,
    /// `(secret name, value)` for each filled value field.
    pub values: Vec<(String, String)>,
}

/// What Apply changed.
#[derive(Clone, Debug, PartialEq)]
pub struct ProposalApplied {
    pub environment: Environment,
    /// The project, when Apply created an environment and selected it for the project.
    pub project: Option<p::Project>,
}

impl Client {
    /// Apply in 04's order: `createEnvironment` and `setProjectEnvironment` when no environment
    /// applies, `updateEnvironment`, `setEnvironmentSecret` for each filled value, then
    /// `resolveEnvironmentProposal` with `applied`. Stops at the first error.
    pub fn apply_environment_proposal(
        &self,
        apply: ProposalApply,
    ) -> impl Future<Output = Result<ProposalApplied, ApiError>> + Send + 'static {
        let client = self.clone();
        async move {
            let mut project = None;
            let target = match apply.target {
                Some(environment) => environment,
                None => {
                    let name = unique_name(&apply.new_name, apply.taken.iter().map(String::as_str));
                    let name = name
                        .as_str()
                        .try_into()
                        .map_err(|e: p::error::ConversionError| ApiError::Decode(e.to_string()))?;
                    let created = client
                        .call::<api::CreateEnvironment>(p::CreateEnvironmentIn { name })
                        .await?;
                    project = Some(
                        client
                            .call::<api::SetProjectEnvironment>(p::SetProjectEnvironmentIn {
                                project_id: apply.project_id.clone(),
                                environment_id: Some(created.id.clone()),
                            })
                            .await?,
                    );
                    created
                }
            };
            let environment = client
                .call::<api::UpdateEnvironment>(merge_proposal(&target, &apply.proposal))
                .await?;
            for (name, value) in apply.values {
                if value.is_empty() {
                    continue;
                }
                client
                    .call::<api::SetEnvironmentSecret>(p::SetEnvironmentSecretIn {
                        environment_id: environment.id.clone(),
                        name,
                        value,
                    })
                    .await?;
            }
            client
                .call::<api::ResolveEnvironmentProposal>(p::ResolveEnvironmentProposalIn {
                    workspace_id: apply.workspace_id,
                    proposal_id: apply.proposal_id,
                    status: p::ResolveEnvironmentProposalInStatus::Applied,
                })
                .await?;
            Ok(ProposalApplied {
                environment,
                project,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p::{EgressPolicy, EnvironmentSecret, Injector};

    fn environment() -> Environment {
        Environment {
            id: "env1".into(),
            name: "Payments".into(),
            egress_policy: EgressPolicy::Allowlist,
            egress_allowlist: vec!["pypi.org".into()],
            secrets: vec![
                EnvironmentSecret {
                    name: "STRIPE_KEY".into(),
                    hosts: vec!["api.stripe.com".into()],
                    set: true,
                },
                EnvironmentSecret {
                    name: "DB_URL".into(),
                    hosts: vec![],
                    set: false,
                },
            ],
            injectors: vec![Injector {
                name: "sign".into(),
                hosts: vec!["s3.amazonaws.com".into()],
                code: "old".into(),
                sha256: "aa".into(),
            }],
            created_at: 0.,
            updated_at: 0.,
        }
    }

    fn proposal(json: serde_json::Value) -> EnvironmentProposal {
        serde_json::from_value(json).expect("proposal")
    }

    #[test]
    fn merge_adds_hosts_once_and_upserts_by_name_without_removing() {
        let update = merge_proposal(
            &environment(),
            &proposal(serde_json::json!({
                "note": "n",
                "egressPolicy": "open",
                "allowlistAdd": ["pypi.org", "files.pythonhosted.org"],
                "secrets": [
                    {"name": "STRIPE_KEY", "hosts": ["api.stripe.com", "files.stripe.com"]},
                    {"name": "NEW_KEY", "hosts": []}
                ],
                "injectors": [
                    {"name": "sign", "hosts": ["s3.amazonaws.com"], "code": "new"},
                    {"name": "hmac", "hosts": ["api.example.com"], "code": "x"}
                ]
            })),
        );
        assert_eq!(update.environment_id, "env1");
        assert_eq!(update.name, None);
        assert_eq!(update.egress_policy, Some(EgressPolicy::Open));
        assert_eq!(
            update.egress_allowlist.unwrap(),
            ["pypi.org", "files.pythonhosted.org"]
        );
        let secrets = update.secrets.unwrap();
        assert_eq!(
            secrets
                .iter()
                .map(|s| (s.name.as_str(), s.hosts.len()))
                .collect::<Vec<_>>(),
            [("STRIPE_KEY", 2), ("DB_URL", 0), ("NEW_KEY", 0)]
        );
        let injectors = update.injectors.unwrap();
        assert_eq!(injectors.len(), 2);
        assert_eq!(injectors[0].code, "new");
        assert_eq!(injectors[1].name, "hmac");
    }

    #[test]
    fn merge_without_changes_keeps_everything() {
        let update = merge_proposal(&environment(), &proposal(serde_json::json!({"note": "n"})));
        assert_eq!(update.egress_policy, Some(EgressPolicy::Allowlist));
        assert_eq!(update.egress_allowlist.unwrap(), ["pypi.org"]);
        assert_eq!(update.secrets.unwrap().len(), 2);
        assert_eq!(update.injectors.unwrap()[0].code, "old");
    }

    #[test]
    fn unique_name_appends_a_number_when_taken() {
        assert_eq!(unique_name("webapp", ["docs"]), "webapp");
        assert_eq!(unique_name("webapp", ["webapp"]), "webapp 2");
        assert_eq!(unique_name("webapp", ["webapp", "webapp 2"]), "webapp 3");
        assert_eq!(unique_name("  ", []), "Environment");
        let long = "a".repeat(70);
        let first = unique_name(&long, []);
        assert_eq!(first.chars().count(), ENVIRONMENT_NAME_MAX);
        let second = unique_name(&long, [first.as_str()]);
        assert_eq!(second.chars().count(), ENVIRONMENT_NAME_MAX);
        assert!(second.ends_with(" 2"));
    }
}
