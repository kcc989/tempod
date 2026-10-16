use super::*;
use gpui_kit::{AnyWindowHandle, TestAppContext};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

struct Server {
    url: String,
    requests: Arc<Mutex<Vec<(String, Value)>>>,
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

fn deployment(id: &str, status: &str, conclusion: Value) -> Value {
    json!({"id":id,"projectId":"project-1","number":4,"target":"production","stage":"production","branch":"main","sha":"abcdef0123456789abcdef0123456789abcdef01","revision":2,"trigger":"manual","status":status,"conclusion":conclusion,"exitCode":null,"summary":null,"workspaceId":null,"createdAt":1,"startedAt":1,"completedAt":null,"rollout":null,"url":format!("/repositories?project=project-1&tab=deploys&deployment={id}")})
}

fn config(revision: u32, source: &Value) -> Value {
    json!({"projectId":"project-1","revision":revision,"source":source,"enabled":true,"tool":"alchemy","root":"","permissions":["workers"],"timeoutMinutes":20,"egressAllowlist":[],"autoFix":false,"targets":[
        {"key":"production","stage":"production","branch":"main","auto":true,"agent":false,"rollout":"full","workers":[],"smoke":[]},
        {"key":"preview","stage":"preview","branch":null,"auto":false,"agent":true,"rollout":"full","workers":[],"smoke":[]}
    ],"updatedAt":1})
}

fn rolled_out(id: &str, rollout: Value) -> Value {
    let mut value = deployment(id, "completed", json!("success"));
    value["rollout"] = rollout;
    value
}

fn rollout(phase: &str, previous: &[Option<&str>]) -> Value {
    let workers = previous
        .iter()
        .enumerate()
        .map(|(index, previous)| json!({"name":format!("worker-{index}"),"versionId":format!("v-{index}-new"),"previousVersionId":previous,"percentage":100,"cloudflareDeploymentId":null}))
        .collect::<Vec<_>>();
    json!({"phase":phase,"canaryUntil":null,"rolledBackAt":null,"workers":workers})
}

fn production_error(id: &str, fix: Value, fixed: Value) -> Value {
    json!({"id":id,"projectId":"project-1","worker":"web","versionId":"v-2","deploymentId":"d-5","deploymentNumber":5,"title":"TypeError: x is undefined","text":"at handler","occurrences":3,"firstSeenAt":1,"lastSeenAt":1,"fixWorkspaceId":fix,"fixedAt":fixed})
}

fn parse(value: Value) -> p::Deployment {
    serde_json::from_value(value).unwrap()
}

impl Server {
    fn new() -> Self {
        Self::with(deployment("d-1", "running", Value::Null))
    }

    fn with(initial: Value) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let log = requests.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let worker = std::thread::spawn(move || {
            let mut current = initial;
            let mut reads = 0;
            let mut errors = vec![production_error("e-1", Value::Null, Value::Null)];
            let mut secret_set = false;
            let mut saves = 0;
            let mut grants = json!([
                {"permission":"workers","grantedAt":null},
                {"permission":"d1","grantedAt":2},
                {"permission":"r2","grantedAt":3}
            ]);
            while !stopping.load(Ordering::Relaxed) {
                let Ok((mut stream, _)) = listener.accept() else {
                    std::thread::yield_now();
                    continue;
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = vec![];
                let head_end = loop {
                    let mut chunk = [0; 4096];
                    let count = stream.read(&mut chunk).unwrap();
                    assert!(count > 0, "RPC closed without request headers");
                    bytes.extend_from_slice(&chunk[..count]);
                    if let Some(index) = bytes.windows(4).position(|chunk| chunk == b"\r\n\r\n") {
                        break index + 4;
                    }
                };
                let header = String::from_utf8_lossy(&bytes[..head_end]);
                let path = header.split_whitespace().nth(1).unwrap().to_string();
                let length = header
                    .lines()
                    .filter_map(|line| line.split_once(':'))
                    .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                    .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                    .unwrap();
                while bytes.len() < head_end + length {
                    let mut chunk = [0; 4096];
                    let count = stream.read(&mut chunk).unwrap();
                    assert!(count > 0, "RPC closed without request body");
                    bytes.extend_from_slice(&chunk[..count]);
                }
                let input: Value =
                    serde_json::from_slice(&bytes[head_end..head_end + length]).unwrap();
                let name = path.rsplit('/').next().unwrap().to_string();
                log.lock().unwrap().push((name.clone(), input.clone()));
                let (status, result) = match name.as_str() {
                    "listDeployments" => (200, json!([current])),
                    "getDeployment" => {
                        reads += 1;
                        if current["id"] == "d-1" && reads >= 2 {
                            current = deployment("d-1", "completed", json!("failure"));
                            current["exitCode"] = json!(1);
                            current["completedAt"] = json!(66001);
                        }
                        (200, current.clone())
                    }
                    "getDeploymentLog" => (
                        200,
                        json!({"text":format!("log of {} {}", input["deploymentId"].as_str().unwrap(), current["status"].as_str().unwrap()),"truncated":false}),
                    ),
                    "startDeployment" => {
                        current = deployment("d-2", "queued", Value::Null);
                        current["target"] = input["target"].clone();
                        current["branch"] = input["branch"].clone();
                        (200, current.clone())
                    }
                    "redeploy" => {
                        current = deployment("d-3", "queued", Value::Null);
                        current["trigger"] = json!("redeploy");
                        (200, current.clone())
                    }
                    "listProductionErrors" => (200, json!(errors)),
                    "startErrorFix" => {
                        errors[0]["fixWorkspaceId"] = json!("w-fix");
                        (200, json!({"workspaceId":"w-fix"}))
                    }
                    "getIssuesWebhook" => (
                        200,
                        json!({"url":"https://tempo.test/api/hooks/cloudflare-issues/project-1","secretSet":secret_set}),
                    ),
                    "rotateIssuesWebhook" => {
                        secret_set = true;
                        (
                            200,
                            json!({"url":"https://tempo.test/api/hooks/cloudflare-issues/project-1","secret":"s3cr3t"}),
                        )
                    }
                    "rollbackDeployment" => {
                        current["rollout"]["phase"] = json!("rolled_back");
                        current["rollout"]["rolledBackAt"] = json!(2);
                        (200, current.clone())
                    }
                    "cancelDeployment" => {
                        current["status"] = json!("completed");
                        current["conclusion"] = json!("cancelled");
                        (200, current.clone())
                    }
                    "listCloudflareGrants" => (200, grants.clone()),
                    "removeCloudflareGrant" => {
                        grants
                            .as_array_mut()
                            .unwrap()
                            .retain(|g| g["permission"] != input["permission"]);
                        (200, grants.clone())
                    }
                    "getDeployConfig" => (200, config(2, &json!("version: 1\n"))),
                    "updateDeployConfig" => {
                        saves += 1;
                        match saves {
                            1 => (
                                400,
                                json!({"code":"DEPLOY_CONFIG_INVALID","message":"The deploy configuration is not valid.","detail":"targets.production.auto: needs branch"}),
                            ),
                            2 => (
                                409,
                                json!({"code":"DEPLOY_CONFIG_CHANGED","message":"The deploy configuration changed. Reload it and try again."}),
                            ),
                            _ => (200, config(3, &input["source"])),
                        }
                    }
                    _ => panic!("unexpected deploys RPC: {name}"),
                };
                let body = serde_json::to_vec(&result).unwrap();
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(&body);
            }
        });
        Self {
            url,
            requests,
            stop,
            worker: Some(worker),
        }
    }

    fn calls(&self, name: &str) -> Vec<Value> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(call, _)| call == name)
            .map(|(_, input)| input.clone())
            .collect()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.worker.take().unwrap().join().unwrap();
    }
}

fn mount(
    cx: &mut TestAppContext,
    server: &Server,
    runtime: &tempo_client::Runtime,
) -> (AnyWindowHandle, Entity<DeploysView>) {
    let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
        .unwrap()
        .client(tempo_client::Token::new("native-test-token"));
    cx.background_executor.allow_parking();
    cx.update(|cx| {
        gpui_kit::init(cx);
        gpui_kit::open_window(Default::default(), cx, |window, cx| {
            cx.new(|cx| DeploysView::new(client, "project-1".into(), window, cx))
        })
        .unwrap()
    })
}

fn wait(cx: &mut TestAppContext, view: &Entity<DeploysView>, done: impl Fn(&DeploysView) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        if view.read_with(cx, |view, _| done(view)) {
            return;
        }
        assert!(Instant::now() < deadline, "deploys RPC did not finish");
        std::thread::yield_now();
    }
}

#[gpui_kit::test]
fn running_deployment_refreshes_until_completed_then_redeploys(cx: &mut TestAppContext) {
    let server = Server::new();
    let runtime = tempo_client::Runtime::start().unwrap();
    let (_, view) = mount(cx, &server, &runtime);
    wait(cx, &view, |view| {
        !view.loading && view.config.is_some() && view.deployments.len() == 1
    });
    view.update(cx, |view, cx| {
        view.page.filter(Some("production".into()));
        view.load_deployments(cx);
    });
    wait(cx, &view, |view| !view.loading);
    assert_eq!(
        server.calls("listDeployments"),
        vec![
            json!({"projectId":"project-1","offset":0.0}),
            json!({"projectId":"project-1","target":"production","offset":0.0}),
        ]
    );
    view.update(cx, |view, cx| view.open_deployment("d-1".into(), cx));
    wait(cx, &view, |view| {
        view.log
            .as_ref()
            .is_some_and(|log| log.text == "log of d-1 running")
    });
    cx.background_executor
        .advance_clock(LIVE - Duration::from_millis(1));
    cx.run_until_parked();
    assert_eq!(server.calls("getDeployment").len(), 1);
    cx.background_executor
        .advance_clock(Duration::from_millis(1));
    wait(cx, &view, |view| {
        view.log
            .as_ref()
            .is_some_and(|log| log.text == "log of d-1 completed")
    });
    view.read_with(cx, |view, _| {
        let deployment = view.deployment.as_ref().unwrap();
        assert_eq!(model::state(deployment).0, "Failed");
        assert_eq!(model::action(deployment), Action::Redeploy);
    });
    cx.background_executor.advance_clock(LIVE);
    cx.run_until_parked();
    assert_eq!(server.calls("getDeployment").len(), 2);
    view.update(cx, |view, cx| view.redeploy(cx));
    wait(cx, &view, |view| {
        !view.pending
            && view
                .deployment
                .as_ref()
                .is_some_and(|d| d.trigger == p::DeployTrigger::Redeploy)
    });
    assert_eq!(
        server.calls("redeploy"),
        vec![json!({"projectId":"project-1","deploymentId":"d-1"})]
    );
}

#[gpui_kit::test]
fn deploy_sends_branch_only_for_a_target_without_one_then_cancels(cx: &mut TestAppContext) {
    let server = Server::new();
    let runtime = tempo_client::Runtime::start().unwrap();
    let (window, view) = mount(cx, &server, &runtime);
    wait(cx, &view, |view| view.config.is_some());
    assert_eq!(
        view.read_with(cx, |view, _| view.target.clone()),
        Some("production".into())
    );
    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| {
            view.target = Some("preview".into());
            view.start(cx);
            assert!(!view.pending, "a target without branch needs one");
            view.branch
                .update(cx, |input, cx| input.set_value("feature", window, cx));
            view.start(cx);
        })
    })
    .unwrap();
    wait(cx, &view, |view| {
        !view.pending && view.deployment.as_ref().is_some_and(|d| d.id == "d-2")
    });
    assert_eq!(
        server.calls("startDeployment"),
        vec![json!({"projectId":"project-1","target":"preview","branch":"feature"})]
    );
    view.update(cx, |view, cx| {
        assert_eq!(
            model::action(view.deployment.as_ref().unwrap()),
            Action::Cancel
        );
        view.cancel(cx);
    });
    wait(cx, &view, |view| {
        view.deployment
            .as_ref()
            .is_some_and(|d| d.conclusion == Some(p::DeployConclusion::Cancelled))
    });
    assert_eq!(
        server.calls("cancelDeployment"),
        vec![json!({"projectId":"project-1","deploymentId":"d-2"})]
    );
}

#[gpui_kit::test]
fn config_save_shows_detail_then_offers_reload_then_saves(cx: &mut TestAppContext) {
    let server = Server::new();
    let runtime = tempo_client::Runtime::start().unwrap();
    let (window, view) = mount(cx, &server, &runtime);
    wait(cx, &view, |view| view.config.is_some());
    let save = |cx: &mut TestAppContext| {
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| {
                view.source.update(cx, |input, cx| {
                    input.set_value("version: 1\ntool: alchemy\n", window, cx)
                });
                view.save_config(window, cx);
            })
        })
        .unwrap();
        wait(cx, &view, |view| !view.pending);
    };
    save(cx);
    assert_eq!(
        view.read_with(cx, |view, _| view.problem.clone()),
        Some(("targets.production.auto: needs branch".into(), false))
    );
    save(cx);
    assert!(view.read_with(cx, |view, _| view.problem.as_ref().is_some_and(|p| p.1)));
    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| view.load_config(window, cx))
    })
    .unwrap();
    wait(cx, &view, |view| view.problem.is_none());
    assert_eq!(server.calls("getDeployConfig").len(), 2);
    save(cx);
    view.read_with(cx, |view, _| {
        assert!(view.problem.is_none());
        assert_eq!(view.config.as_ref().unwrap().revision, 3.);
    });
    assert_eq!(
        server.calls("updateDeployConfig")[0],
        json!({"projectId":"project-1","source":"version: 1\ntool: alchemy\n","revision":2.0})
    );
}

#[test]
fn roll_back_is_offered_only_for_an_unrolled_success_with_previous_versions() {
    let ready = rolled_out("d-5", rollout("promoted", &[Some("v-a"), Some("v-b")]));
    assert!(model::can_roll_back(&parse(ready.clone())));
    let mut rolled_back = ready.clone();
    rolled_back["rollout"]["rolledBackAt"] = json!(2);
    let mut failed = ready.clone();
    failed["conclusion"] = json!("failure");
    let mut running = ready;
    running["status"] = json!("running");
    running["conclusion"] = Value::Null;
    for value in [
        rolled_back,
        failed,
        running,
        rolled_out("d-5", rollout("full", &[Some("v-a"), None])),
        rolled_out("d-5", rollout("promoted", &[])),
        deployment("d-5", "completed", json!("success")),
    ] {
        assert!(!model::can_roll_back(&parse(value)));
    }
}

#[test]
fn running_canary_is_labelled_canary_with_its_rollout_facts() {
    let mut canary = deployment("d-5", "running", Value::Null);
    canary["rollout"] = rollout("canary", &[Some("v-a"), None]);
    canary["rollout"]["canaryUntil"] = json!(3_723_000);
    canary["rollout"]["workers"][0]["percentage"] = json!(10);
    canary["rollout"]["workers"][0]["cloudflareDeploymentId"] = json!("cf-1");
    let canary = parse(canary);
    assert_eq!(model::state(&canary).0, "Canary");
    let rollout = canary.rollout.as_ref().unwrap();
    assert_eq!(
        model::rollout_heading(rollout, 0.),
        "Canary at 10% · moves to 100% at 01:02 UTC"
    );
    assert_eq!(
        model::rollout_worker(&rollout.workers[0]),
        (
            "worker-0 · 10%".to_string(),
            "version v-0-new · previous v-a · Cloudflare deployment cf-1".to_string()
        )
    );
    assert_eq!(
        model::rollout_worker(&rollout.workers[1]).1,
        "version v-1-new · previous none · Cloudflare deployment none"
    );
    assert_eq!(
        model::state(&parse(deployment("d-1", "running", Value::Null))).0,
        "Running"
    );
}

#[gpui_kit::test]
fn roll_back_sends_rollback_deployment_then_shows_the_rolled_back_deployment(
    cx: &mut TestAppContext,
) {
    let server = Server::with(rolled_out("d-5", rollout("promoted", &[Some("v-a")])));
    let runtime = tempo_client::Runtime::start().unwrap();
    let (_, view) = mount(cx, &server, &runtime);
    view.update(cx, |view, cx| view.open_deployment("d-5".into(), cx));
    wait(cx, &view, |view| {
        view.deployment.as_ref().is_some_and(model::can_roll_back)
    });
    view.update(cx, |view, cx| view.rollback(cx));
    wait(cx, &view, |view| {
        !view.pending
            && view
                .deployment
                .as_ref()
                .and_then(|d| d.rollout.as_ref())
                .is_some_and(|r| r.rolled_back_at.is_some())
    });
    assert_eq!(
        server.calls("rollbackDeployment"),
        vec![json!({"projectId":"project-1","deploymentId":"d-5"})]
    );
    view.read_with(cx, |view, _| {
        let deployment = view.deployment.as_ref().unwrap();
        assert!(!model::can_roll_back(deployment));
        assert_eq!(
            model::rollout_heading(deployment.rollout.as_ref().unwrap(), 2.),
            "Rolled back · just now"
        );
    });
}

#[test]
fn production_error_facts_name_worker_version_count_and_fixed() {
    let parse_error =
        |value: Value| -> p::ProductionError { serde_json::from_value(value).unwrap() };
    let open = parse_error(production_error("e-1", Value::Null, Value::Null));
    assert_eq!(
        model::production_error_facts(&open, 1.),
        "web · version v-2 · 3 times · last just now"
    );
    let mut unknown = production_error("e-2", json!("w-fix"), json!(2));
    unknown["worker"] = Value::Null;
    unknown["versionId"] = Value::Null;
    unknown["occurrences"] = json!(1);
    assert_eq!(
        model::production_error_facts(&parse_error(unknown), 1.),
        "Unknown Worker · version unknown · 1 time · last just now · Fixed"
    );
}

#[gpui_kit::test]
fn start_fix_opens_the_fix_workspace_and_new_secret_is_shown_once(cx: &mut TestAppContext) {
    let server = Server::new();
    let runtime = tempo_client::Runtime::start().unwrap();
    let (_, view) = mount(cx, &server, &runtime);
    let opened = Arc::new(Mutex::new(Vec::new()));
    let seen = opened.clone();
    cx.update(|cx| {
        cx.subscribe(&view, move |_, event: &DeploysEvent, _| {
            let DeploysEvent::OpenWorkspace(id) = event;
            seen.lock().unwrap().push(id.clone());
        })
        .detach()
    });
    wait(cx, &view, |view| {
        view.errors.len() == 1 && view.webhook.as_ref().is_some_and(|w| !w.secret_set)
    });
    view.update(cx, |view, cx| view.start_fix("e-1".into(), cx));
    wait(cx, &view, |view| {
        view.errors[0].fix_workspace_id.as_deref() == Some("w-fix")
    });
    assert_eq!(
        server.calls("startErrorFix"),
        vec![json!({"projectId":"project-1","errorId":"e-1"})]
    );
    assert_eq!(*opened.lock().unwrap(), vec!["w-fix".to_string()]);
    view.update(cx, |view, cx| view.rotate_secret(cx));
    wait(cx, &view, |view| view.secret.is_some());
    assert_eq!(
        server.calls("rotateIssuesWebhook"),
        vec![json!({"projectId":"project-1"})]
    );
    view.read_with(cx, |view, _| {
        assert_eq!(view.secret.as_deref(), Some("s3cr3t"));
        assert!(view.webhook.as_ref().unwrap().secret_set);
    });
}

#[gpui_kit::test]
fn cloudflare_access_lists_the_grant_and_remove_shows_the_returned_list(cx: &mut TestAppContext) {
    let server = Server::new();
    let runtime = tempo_client::Runtime::start().unwrap();
    let (_, view) = mount(cx, &server, &runtime);
    let permissions = |view: &DeploysView| -> Vec<p::DeployPermission> {
        view.grants
            .iter()
            .flatten()
            .map(|grant| grant.permission)
            .collect()
    };
    wait(cx, &view, |view| view.grants.is_some());
    assert_eq!(
        server.calls("listCloudflareGrants"),
        vec![json!({"projectId":"project-1"})]
    );
    assert_eq!(
        view.read_with(cx, |view, _| permissions(view)),
        [
            p::DeployPermission::Workers,
            p::DeployPermission::D1,
            p::DeployPermission::R2
        ]
    );
    view.update(cx, |view, cx| {
        view.remove_grant(p::DeployPermission::Workers, cx);
        assert!(!view.pending, "workers cannot be removed");
        view.remove_grant(p::DeployPermission::D1, cx);
    });
    wait(cx, &view, |view| !view.pending);
    assert_eq!(
        server.calls("removeCloudflareGrant"),
        vec![json!({"projectId":"project-1","permission":"d1"})]
    );
    assert_eq!(
        view.read_with(cx, |view, _| permissions(view)),
        [p::DeployPermission::Workers, p::DeployPermission::R2]
    );
    assert_eq!(server.calls("listCloudflareGrants").len(), 1);
}
