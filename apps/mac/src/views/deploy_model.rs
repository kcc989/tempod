//! Labels and rules for app deploys (12, Clients). Unfinished deployments are never "Succeeded".

use super::ci_model::CiTone;
use tempo_protocol as p;

pub const PAGE: usize = 50;

/// 12, Access requests and grants: the help text of the repository's Cloudflare access list.
pub const GRANTS_HELP: &str = "Agents ask for access in a chat, and you approve it there. Deploys and agents use only what is listed here.";

pub fn state(deployment: &p::Deployment) -> (&'static str, CiTone) {
    match (deployment.status, deployment.conclusion) {
        (p::DeployStatus::Queued, _) => ("Queued", CiTone::Muted),
        (p::DeployStatus::Running, _) => match &deployment.rollout {
            Some(rollout) if rollout.phase == p::DeployRolloutPhase::Canary => {
                ("Canary", CiTone::Warning)
            }
            _ => ("Running", CiTone::Warning),
        },
        (_, Some(p::DeployConclusion::Success)) => ("Succeeded", CiTone::Success),
        (_, Some(p::DeployConclusion::Failure)) => ("Failed", CiTone::Danger),
        (_, Some(p::DeployConclusion::TimedOut)) => ("Timed out", CiTone::Danger),
        (_, Some(p::DeployConclusion::Cancelled)) => ("Cancelled", CiTone::Muted),
        (_, None) => ("Completed", CiTone::Muted),
    }
}

pub fn trigger(trigger: p::DeployTrigger) -> &'static str {
    match trigger {
        p::DeployTrigger::Manual => "Manual",
        p::DeployTrigger::Agent => "Agent",
        p::DeployTrigger::Auto => "Auto",
        p::DeployTrigger::Redeploy => "Redeploy",
    }
}

pub fn is_live(deployment: &p::Deployment) -> bool {
    deployment.status != p::DeployStatus::Completed
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Cancel,
    Redeploy,
}

pub fn action(deployment: &p::Deployment) -> Action {
    if is_live(deployment) {
        Action::Cancel
    } else {
        Action::Redeploy
    }
}

/// Whether to offer Roll back. The server also checks that it is the target's newest success.
pub fn can_roll_back(deployment: &p::Deployment) -> bool {
    deployment.status == p::DeployStatus::Completed
        && deployment.conclusion == Some(p::DeployConclusion::Success)
        && deployment.rollout.as_ref().is_some_and(|rollout| {
            rollout.rolled_back_at.is_none()
                && !rollout.workers.is_empty()
                && rollout
                    .workers
                    .iter()
                    .all(|w| w.previous_version_id.is_some())
        })
}

pub fn rollout_phase(phase: p::DeployRolloutPhase) -> &'static str {
    match phase {
        p::DeployRolloutPhase::Canary => "Canary at 10%",
        p::DeployRolloutPhase::Promoted => "Promoted to 100%",
        p::DeployRolloutPhase::Full => "Deployed at 100%",
        p::DeployRolloutPhase::RolledBack => "Rolled back",
    }
}

/// The phase, when a canary moves to 100% (UTC), and when it was rolled back.
pub fn rollout_heading(rollout: &p::DeployRollout, now: f64) -> String {
    let mut heading = rollout_phase(rollout.phase).to_string();
    if let (p::DeployRolloutPhase::Canary, Some(until)) = (rollout.phase, rollout.canary_until) {
        heading.push_str(&format!(" · moves to 100% at {}", clock_utc(until)));
    }
    if let Some(at) = rollout.rolled_back_at {
        heading.push_str(&format!(
            " · {}",
            super::indicators::format_relative(at, now)
        ));
    }
    heading
}

/// A Worker's share, then its version, previous version and Cloudflare deployment.
pub fn rollout_worker(worker: &p::DeployRolloutWorker) -> (String, String) {
    (
        format!("{} · {}%", worker.name, worker.percentage),
        format!(
            "version {} · previous {} · Cloudflare deployment {}",
            worker.version_id,
            worker.previous_version_id.as_deref().unwrap_or("none"),
            worker.cloudflare_deployment_id.as_deref().unwrap_or("none")
        ),
    )
}

fn clock_utc(at: f64) -> String {
    let minutes = (at / 60_000.).floor() as i64;
    format!(
        "{:02}:{:02} UTC",
        minutes.div_euclid(60).rem_euclid(24),
        minutes.rem_euclid(60)
    )
}

/// Worker, version, occurrences and last seen of a production error; fixed errors say so.
pub fn production_error_facts(error: &p::ProductionError, now: f64) -> String {
    let occurrences = error.occurrences;
    format!(
        "{} · version {} · {occurrences} {} · last {}{}",
        error.worker.as_deref().unwrap_or("Unknown Worker"),
        error.version_id.as_deref().unwrap_or("unknown"),
        if occurrences == 1. { "time" } else { "times" },
        super::indicators::format_relative(error.last_seen_at, now),
        if error.fixed_at.is_some() {
            " · Fixed"
        } else {
            ""
        }
    )
}

/// Exit code, duration and summary, joined; empty parts are left out.
pub fn facts(deployment: &p::Deployment, now: f64) -> String {
    [
        deployment
            .exit_code
            .map(|code| format!("exit {}", code as i64)),
        Some(super::ci_model::duration(
            deployment.started_at,
            deployment.completed_at,
            now,
        )),
        deployment.summary.clone(),
    ]
    .into_iter()
    .flatten()
    .filter(|fact| !fact.is_empty())
    .collect::<Vec<_>>()
    .join(" · ")
}

/// The list's target filter and offset. Changing the filter returns to the newest page.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Page {
    pub target: Option<String>,
    pub offset: usize,
}

impl Page {
    pub fn filter(&mut self, target: Option<String>) {
        self.target = target;
        self.offset = 0;
    }

    pub fn older(&mut self) {
        self.offset += PAGE;
    }

    pub fn newer(&mut self) {
        self.offset = self.offset.saturating_sub(PAGE);
    }

    pub fn has_newer(&self) -> bool {
        self.offset > 0
    }

    pub fn has_older(&self, shown: usize) -> bool {
        shown == PAGE
    }

    pub fn input(&self, project_id: &str) -> p::ListDeploymentsIn {
        p::ListDeploymentsIn {
            project_id: project_id.into(),
            target: self.target.as_deref().and_then(|t| t.parse().ok()),
            offset: Some(self.offset as f64),
        }
    }
}

/// A target with `branch` deploys only that branch; any other target needs one.
pub fn needs_branch(target: &p::DeployTarget) -> bool {
    target.branch.is_none()
}

pub fn start_input(
    project_id: &str,
    target: &p::DeployTarget,
    branch: &str,
) -> Option<p::StartDeploymentIn> {
    let branch = branch.trim();
    let branch = if needs_branch(target) {
        Some(branch.parse().ok()?)
    } else {
        None
    };
    Some(p::StartDeploymentIn {
        project_id: project_id.into(),
        target: target.key.parse().ok()?,
        branch,
    })
}

pub fn target_label(target: &p::DeployTarget) -> String {
    match &target.branch {
        Some(branch) => format!("{} ({branch})", target.key),
        None => target.key.clone(),
    }
}

pub fn config_summary(config: &p::DeployConfig) -> String {
    if config.revision == 0. {
        return "Not saved yet".into();
    }
    if !config.enabled {
        return format!("Revision {} · Off", config.revision);
    }
    let tool = config.tool.map(|tool| tool.to_string()).unwrap_or_default();
    let targets = config
        .targets
        .iter()
        .map(|t| t.key.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    format!("Revision {} · {tool} · {targets}", config.revision)
}

/// A configuration save error: the validation detail in place, or the message; `true` offers
/// a reload.
pub fn config_problem(error: &tempo_client::ApiError) -> (String, bool) {
    match error {
        tempo_client::ApiError::Server { error, .. } => match error.code {
            p::ErrorCode::DeployConfigInvalid => (
                error
                    .detail
                    .clone()
                    .unwrap_or_else(|| error.message.clone()),
                false,
            ),
            p::ErrorCode::DeployConfigChanged => (error.message.clone(), true),
            _ => (error.message.clone(), false),
        },
        other => (other.to_string(), false),
    }
}

/// The Cloudflare settings input when both fields follow 12, Owner settings.
pub fn settings_input(account_id: &str, token: &str) -> Option<p::UpdateDeploySettingsIn> {
    let account_id = account_id.trim();
    let token = token.trim();
    let hex = account_id.len() == 32
        && account_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !hex || token.is_empty() || token.chars().count() > 512 {
        return None;
    }
    Some(p::UpdateDeploySettingsIn {
        account_id: account_id.parse().ok()?,
        token: token.parse().ok()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn deployment(value: serde_json::Value) -> p::Deployment {
        let mut base = json!({"id":"d-1","projectId":"project-1","number":3,"target":"production","stage":"production","branch":"main","sha":"abcdef0123456789","revision":1,"trigger":"manual","status":"queued","conclusion":null,"exitCode":null,"summary":null,"workspaceId":null,"createdAt":1,"startedAt":null,"completedAt":null,"rollout":null,"url":"/repositories?project=project-1&tab=deploys&deployment=d-1"});
        base.as_object_mut()
            .unwrap()
            .extend(value.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }

    fn target(key: &str, branch: Option<&str>) -> p::DeployTarget {
        serde_json::from_value(
            json!({"key":key,"stage":key,"branch":branch,"auto":false,"agent":false,"rollout":"full","workers":[],"smoke":[]}),
        )
        .unwrap()
    }

    #[test]
    fn unfinished_deployments_are_never_succeeded_and_offer_cancel() {
        let running = deployment(json!({"status":"running","conclusion":"success"}));
        assert_eq!(state(&running), ("Running", CiTone::Warning));
        assert_eq!(action(&running), Action::Cancel);
        assert!(is_live(&running));
        let timed_out = deployment(json!({"status":"completed","conclusion":"timed_out"}));
        assert_eq!(state(&timed_out), ("Timed out", CiTone::Danger));
        assert_eq!(action(&timed_out), Action::Redeploy);
        assert_eq!(
            state(&deployment(
                json!({"status":"completed","conclusion":"success"})
            )),
            ("Succeeded", CiTone::Success)
        );
        assert_eq!(trigger(p::DeployTrigger::Redeploy), "Redeploy");
    }

    #[test]
    fn facts_join_exit_code_duration_and_summary() {
        let failed = deployment(
            json!({"status":"completed","conclusion":"failure","exitCode":2,"startedAt":1000,"completedAt":66000,"summary":"alchemy.run.ts was not found in apps/web."}),
        );
        assert_eq!(
            facts(&failed, 0.),
            "exit 2 · 1m 05s · alchemy.run.ts was not found in apps/web."
        );
        assert_eq!(facts(&deployment(json!({})), 0.), "");
    }

    #[test]
    fn filter_resets_paging_and_pages_by_fifty() {
        let mut page = Page::default();
        assert!(!page.has_newer());
        assert!(page.has_older(PAGE));
        assert!(!page.has_older(PAGE - 1));
        page.older();
        page.older();
        assert_eq!(page.offset, 100);
        page.newer();
        assert_eq!(page.offset, 50);
        page.filter(Some("preview".into()));
        assert_eq!(page.offset, 0);
        assert_eq!(
            serde_json::to_value(page.input("project-1")).unwrap(),
            json!({"projectId":"project-1","target":"preview","offset":0.0})
        );
        page.filter(None);
        assert_eq!(
            serde_json::to_value(page.input("project-1")).unwrap(),
            json!({"projectId":"project-1","offset":0.0})
        );
    }

    #[test]
    fn branch_is_sent_only_for_targets_without_one() {
        let production = target("production", Some("main"));
        let preview = target("preview", None);
        assert!(!needs_branch(&production));
        assert_eq!(
            serde_json::to_value(start_input("project-1", &production, "ignored")).unwrap(),
            json!({"projectId":"project-1","target":"production"})
        );
        assert_eq!(
            serde_json::to_value(start_input("project-1", &preview, " feature ")).unwrap(),
            json!({"projectId":"project-1","target":"preview","branch":"feature"})
        );
        assert!(start_input("project-1", &preview, "  ").is_none());
        assert_eq!(target_label(&production), "production (main)");
    }

    #[test]
    fn config_summary_shows_revision_state_and_targets() {
        let config = |value: serde_json::Value| -> p::DeployConfig {
            let mut base = json!({"projectId":"project-1","revision":0,"source":"","enabled":false,"tool":null,"root":"","permissions":[],"timeoutMinutes":20,"egressAllowlist":[],"autoFix":false,"targets":[],"updatedAt":null});
            base.as_object_mut()
                .unwrap()
                .extend(value.as_object().unwrap().clone());
            serde_json::from_value(base).unwrap()
        };
        assert_eq!(config_summary(&config(json!({}))), "Not saved yet");
        assert_eq!(
            config_summary(&config(json!({"revision":4}))),
            "Revision 4 · Off"
        );
        assert_eq!(
            config_summary(&config(
                json!({"revision":2,"enabled":true,"tool":"alchemy","targets":[
                    {"key":"production","stage":"production","branch":"main","auto":true,"agent":false,"rollout":"full","workers":[],"smoke":[]},
                    {"key":"preview","stage":"preview","branch":null,"auto":false,"agent":true,"rollout":"full","workers":[],"smoke":[]}
                ]})
            )),
            "Revision 2 · alchemy · production, preview"
        );
    }

    #[test]
    fn config_errors_show_detail_or_reload() {
        let server = |code: &str, detail: Option<&str>| {
            tempo_client::ApiError::Server {
            status: 400,
            error: serde_json::from_value(
                json!({"code":code,"message":"The deploy configuration is not valid.","detail":detail}),
            )
            .unwrap(),
        }
        };
        assert_eq!(
            config_problem(&server(
                "DEPLOY_CONFIG_INVALID",
                Some("targets.production.auto: needs branch")
            )),
            ("targets.production.auto: needs branch".into(), false)
        );
        assert!(config_problem(&server("DEPLOY_CONFIG_CHANGED", None)).1);
        assert!(!config_problem(&server("DEPLOY_NOT_CONFIGURED", None)).1);
    }

    #[test]
    fn settings_need_a_hex_account_id_and_a_bounded_token() {
        let account = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            serde_json::to_value(settings_input(&format!(" {account} "), " secret ")).unwrap(),
            json!({"accountId":account,"token":"secret"})
        );
        assert!(settings_input(&account.to_uppercase(), "secret").is_none());
        assert!(settings_input(&account[1..], "secret").is_none());
        assert!(settings_input(account, "   ").is_none());
        assert!(settings_input(account, &"x".repeat(513)).is_none());
        assert!(settings_input(account, &"x".repeat(512)).is_some());
    }
}
