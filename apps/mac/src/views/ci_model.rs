//! Labels for project CI (10, Clients). Shared rules with the web model: unfinished work is never
//! "Passed".

use tempo_protocol as p;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CiTone {
    Success,
    Danger,
    Muted,
    Warning,
}

pub fn run_state(run: &p::CiRun) -> (&'static str, CiTone) {
    match (run.status, run.conclusion) {
        (p::CiRunStatus::Queued, _) => ("Queued", CiTone::Muted),
        (p::CiRunStatus::Running, _) => ("Running", CiTone::Warning),
        (_, Some(p::CiRunConclusion::Success)) => ("Passed", CiTone::Success),
        (_, Some(p::CiRunConclusion::Failure)) => ("Failed", CiTone::Danger),
        (_, Some(p::CiRunConclusion::Cancelled)) => ("Cancelled", CiTone::Muted),
        (_, None) => ("Completed", CiTone::Muted),
    }
}

pub fn job_state(job: &p::CiJob) -> (&'static str, CiTone) {
    match (job.status, job.conclusion) {
        (p::CiJobStatus::Queued, _) => ("Queued", CiTone::Muted),
        (p::CiJobStatus::Running, _) => ("Running", CiTone::Warning),
        (_, Some(p::CiJobConclusion::Success)) => ("Passed", CiTone::Success),
        (_, Some(p::CiJobConclusion::Failure)) => ("Failed", CiTone::Danger),
        (_, Some(p::CiJobConclusion::TimedOut)) => ("Timed out", CiTone::Danger),
        (_, Some(p::CiJobConclusion::Cancelled)) => ("Cancelled", CiTone::Muted),
        (_, Some(p::CiJobConclusion::Skipped)) => ("Skipped", CiTone::Muted),
        (_, None) => ("Completed", CiTone::Muted),
    }
}

/// "1m 05s" from start to end (or `now`); empty before start. Times are Unix milliseconds.
pub fn duration(started_at: Option<f64>, completed_at: Option<f64>, now: f64) -> String {
    let Some(start) = started_at else {
        return String::new();
    };
    let seconds = ((completed_at.unwrap_or(now) - start) / 1000.)
        .round()
        .max(0.) as u64;
    if seconds >= 60 {
        format!("{}m {:02}s", seconds / 60, seconds % 60)
    } else {
        format!("{seconds}s")
    }
}

/// The job whose log to show: the selected one, else the first that started.
pub fn selected_job<'a>(jobs: &'a [p::CiJob], key: Option<&str>) -> Option<&'a p::CiJob> {
    jobs.iter()
        .find(|job| Some(job.key.as_str()) == key)
        .or_else(|| jobs.iter().find(|job| job.started_at.is_some()))
        .or_else(|| jobs.first())
}

pub fn short_sha(sha: &str) -> &str {
    sha.get(..7).unwrap_or(sha)
}

/// A pipeline save error: the validation detail in place, or the error message.
pub fn pipeline_problem(error: &tempo_client::ApiError) -> (String, bool) {
    match error {
        tempo_client::ApiError::Server { error, .. } => match error.code {
            p::ErrorCode::CiPipelineInvalid => (
                error
                    .detail
                    .clone()
                    .unwrap_or_else(|| error.message.clone()),
                false,
            ),
            p::ErrorCode::CiPipelineChanged => (error.message.clone(), true),
            _ => (error.message.clone(), false),
        },
        other => (other.to_string(), false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn job(value: serde_json::Value) -> p::CiJob {
        let mut base = json!({"key":"test","name":"test","needs":[],"status":"queued","conclusion":null,"exitCode":null,"summary":null,"startedAt":null,"completedAt":null});
        base.as_object_mut()
            .unwrap()
            .extend(value.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }

    #[test]
    fn unfinished_work_is_never_passed_and_durations_format() {
        assert_eq!(
            job_state(&job(json!({"status":"running","conclusion":"success"}))),
            ("Running", CiTone::Warning)
        );
        assert_eq!(
            job_state(&job(json!({"status":"completed","conclusion":"timed_out"}))),
            ("Timed out", CiTone::Danger)
        );
        assert_eq!(job_state(&job(json!({}))), ("Queued", CiTone::Muted));
        assert_eq!(duration(None, None, 0.), "");
        assert_eq!(duration(Some(1_000.), Some(6_000.), 0.), "5s");
        assert_eq!(duration(Some(0.), None, 125_000.), "2m 05s");
        assert_eq!(short_sha("abcdef0123"), "abcdef0");
        assert_eq!(short_sha("abc"), "abc");
    }

    #[test]
    fn selects_requested_job_else_first_started() {
        let jobs = vec![
            job(json!({"key":"a"})),
            job(json!({"key":"b","startedAt":5})),
            job(json!({"key":"c","startedAt":6})),
        ];
        assert_eq!(selected_job(&jobs, Some("c")).unwrap().key, "c");
        assert_eq!(selected_job(&jobs, Some("missing")).unwrap().key, "b");
        assert_eq!(selected_job(&jobs[..1], None).unwrap().key, "a");
        assert!(selected_job(&[], None).is_none());
    }

    #[test]
    fn pipeline_errors_show_detail_or_reload() {
        let server = |code: &str, detail: Option<&str>| tempo_client::ApiError::Server {
            status: 400,
            error: serde_json::from_value(
                json!({"code":code,"message":"The CI pipeline is not valid.","detail":detail}),
            )
            .unwrap(),
        };
        assert_eq!(
            pipeline_problem(&server("CI_PIPELINE_INVALID", Some("jobs: required map"))),
            ("jobs: required map".into(), false)
        );
        assert!(pipeline_problem(&server("CI_PIPELINE_CHANGED", None)).1);
    }
}
