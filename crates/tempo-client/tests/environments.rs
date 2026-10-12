//! 07 Testing, Client row: the environment calls (02, Environments) and Apply of an agent proposal
//! (04, Pending environment proposals) against a fake server.

mod common;

use std::path::Path;

use common::{APP_VERSION, TOKEN, fake_http};
use serde_json::{Value, json};
use tempo_client::{ProposalApply, RuntimeHandle, Server, Token};
use tempo_protocol::{self as p, Function, api};

fn fixtures(name: &str) -> Vec<String> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/protocol/fixtures/types")
        .join(format!("{name}.jsonl"));
    std::fs::read_to_string(path)
        .expect("fixture")
        .lines()
        .map(str::to_owned)
        .collect()
}

fn fixture(name: &str) -> String {
    fixtures(name).swap_remove(0)
}

fn client(rt: &RuntimeHandle, base: &str) -> tempo_client::Client {
    Server::new(rt, base, APP_VERSION)
        .expect("server")
        .client(Token::new(TOKEN))
}

/// Posts every sample of `<input>` to `/api/v1/rpc/<F::NAME>` and decodes `reply` as the output.
async fn round_trip<F: Function>(input: &str, reply: String) -> Vec<F::Output> {
    let server = fake_http(move |_, _| (200, reply.clone())).await;
    let rt = RuntimeHandle::current();
    let c = client(&rt, &server.base);
    let mut outputs = vec![];
    for sample in fixtures(input) {
        let value: F::Input = serde_json::from_str(&sample).expect("input");
        outputs.push(c.call::<F>(value).await.expect("call succeeds"));
        let r = server.requests().pop().expect("a request");
        assert_eq!(r.method, "POST");
        assert_eq!(r.path, format!("/api/v1/rpc/{}", F::NAME));
        assert_eq!(r.header("authorization"), Some("Bearer test-session-token"));
        assert_eq!(
            r.json(),
            serde_json::from_str::<Value>(&sample).expect("json")
        );
    }
    outputs
}

#[tokio::test(start_paused = true)]
async fn each_environment_call_posts_its_input_and_decodes_its_output() {
    let environments = format!("[{}]", fixtures("Environment").join(","));
    let listed = round_trip::<api::ListEnvironments>("Empty", environments).await;
    assert_eq!(listed[0].len(), 2);
    assert_eq!(listed[0][0].name, "Payments");
    assert!(listed[0][0].secrets[0].set);

    let created =
        round_trip::<api::CreateEnvironment>("CreateEnvironmentIn", fixture("Environment")).await;
    assert_eq!(created[0].egress_policy, p::EgressPolicy::Allowlist);

    let updated =
        round_trip::<api::UpdateEnvironment>("UpdateEnvironmentIn", fixture("Environment")).await;
    assert_eq!(updated.len(), 2);

    round_trip::<api::DeleteEnvironment>("DeleteEnvironmentIn", "{}".into()).await;
    round_trip::<api::SetEnvironmentSecret>("SetEnvironmentSecretIn", "{}".into()).await;
    round_trip::<api::DeleteEnvironmentSecret>("DeleteEnvironmentSecretIn", "{}".into()).await;
    round_trip::<api::SetWorkspaceEnvironment>("SetWorkspaceEnvironmentIn", "{}".into()).await;
    round_trip::<api::ResolveEnvironmentProposal>("ResolveEnvironmentProposalIn", "{}".into())
        .await;

    let project = fixtures("Project").swap_remove(2);
    let projects =
        round_trip::<api::SetProjectEnvironment>("SetProjectEnvironmentIn", project).await;
    assert_eq!(
        projects[0].environment_id.as_deref(),
        Some("01k700000000000000000000w5")
    );
}

#[test]
fn an_environment_name_outside_1_to_64_characters_does_not_decode() {
    for name in [String::new(), "a".repeat(65)] {
        assert!(serde_json::from_value::<p::CreateEnvironmentIn>(json!({ "name": name })).is_err());
    }
}

fn proposal() -> p::EnvironmentProposal {
    serde_json::from_str(&fixture("EnvironmentProposal")).expect("proposal")
}

fn apply(target: Option<p::Environment>, values: &[(&str, &str)]) -> ProposalApply {
    ProposalApply {
        workspace_id: "01k7000000000000000000000b".into(),
        proposal_id: "01k700000000000000000000w7".into(),
        proposal: proposal(),
        target,
        project_id: "01k70000000000000000000001".into(),
        new_name: "webapp".into(),
        taken: vec!["webapp".into(), "Payments".into()],
        values: values
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect(),
    }
}

#[tokio::test(start_paused = true)]
async fn apply_without_an_environment_creates_one_selects_it_updates_sets_values_and_resolves() {
    let environment = fixtures("Environment").swap_remove(1);
    let project = fixtures("Project").swap_remove(2);
    let server = fake_http(move |req, _| match req.path.as_str() {
        "/api/v1/rpc/setProjectEnvironment" => (200, project.clone()),
        "/api/v1/rpc/createEnvironment" | "/api/v1/rpc/updateEnvironment" => {
            (200, environment.clone())
        }
        _ => (200, "{}".into()),
    })
    .await;
    let rt = RuntimeHandle::current();
    let out = client(&rt, &server.base)
        .apply_environment_proposal(apply(None, &[("STRIPE_KEY", "sk_test"), ("OTHER", "")]))
        .await
        .expect("applies");
    assert_eq!(out.environment.id, "01k700000000000000000000w6");
    assert!(out.project.is_some());

    let reqs = server.requests();
    let paths: Vec<_> = reqs
        .iter()
        .map(|r| r.path.trim_start_matches("/api/v1/rpc/"))
        .collect();
    assert_eq!(
        paths,
        [
            "createEnvironment",
            "setProjectEnvironment",
            "updateEnvironment",
            "setEnvironmentSecret",
            "resolveEnvironmentProposal",
        ]
    );
    assert_eq!(reqs[0].json(), json!({"name": "webapp 2"}));
    assert_eq!(
        reqs[1].json(),
        json!({"projectId": "01k70000000000000000000001", "environmentId": "01k700000000000000000000w6"})
    );
    assert_eq!(
        reqs[2].json(),
        json!({
            "environmentId": "01k700000000000000000000w6",
            "egressPolicy": "open",
            "egressAllowlist": ["pypi.org", "files.pythonhosted.org"],
            "secrets": [{"name": "STRIPE_KEY", "hosts": ["api.stripe.com"]}],
            "injectors": []
        })
    );
    assert_eq!(
        reqs[3].json(),
        json!({"environmentId": "01k700000000000000000000w6", "name": "STRIPE_KEY", "value": "sk_test"})
    );
    assert_eq!(
        reqs[4].json(),
        json!({
            "workspaceId": "01k7000000000000000000000b",
            "proposalId": "01k700000000000000000000w7",
            "status": "applied"
        })
    );
}

#[tokio::test(start_paused = true)]
async fn apply_to_an_environment_updates_it_and_stops_at_the_first_error() {
    let environment = fixture("Environment");
    let target: p::Environment = serde_json::from_str(&environment).expect("environment");
    let server = fake_http(move |req, _| match req.path.as_str() {
        "/api/v1/rpc/updateEnvironment" => (
            400,
            json!({"code": "VALIDATION_FAILED", "message": "Check the highlighted fields."})
                .to_string(),
        ),
        _ => (200, environment.clone()),
    })
    .await;
    let rt = RuntimeHandle::current();
    let err = client(&rt, &server.base)
        .apply_environment_proposal(apply(Some(target), &[("STRIPE_KEY", "sk")]))
        .await
        .expect_err("update fails");
    assert_eq!(err.code(), Some(p::ErrorCode::ValidationFailed));
    let reqs = server.requests();
    assert_eq!(reqs.len(), 1, "nothing after the failed update");
    assert_eq!(reqs[0].path, "/api/v1/rpc/updateEnvironment");
    assert_eq!(
        reqs[0].json()["egressAllowlist"],
        json!(["pypi.org", "*.stripe.com", "files.pythonhosted.org"])
    );
    assert_eq!(reqs[0].json()["secrets"].as_array().map(Vec::len), Some(2));
    assert_eq!(reqs[0].json()["injectors"][0]["name"], "aws-sigv4");
}
