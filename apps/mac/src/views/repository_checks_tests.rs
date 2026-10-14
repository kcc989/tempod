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

fn run(status: &str, conclusion: Value) -> Value {
    json!({"id":"run-1","projectId":"project-1","number":7,"branch":"feature","sha":"abcdef0123456789abcdef0123456789abcdef01","revision":2,"attempt":1,"trigger":"push","status":status,"conclusion":conclusion,"createdAt":1,"startedAt":1,"completedAt":null,"url":"https://tempo.test/repositories?project=project-1&tab=checks&run=run-1"})
}

impl Server {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let log = requests.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let worker = std::thread::spawn(move || {
            let mut current = run("running", Value::Null);
            let mut saves = 0;
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
                    "listCiRuns" => (200, json!([current])),
                    "getCiRun" => (
                        200,
                        json!({"run":current,"jobs":[
                            {"key":"lint","name":"Lint","needs":[],"status":"completed","conclusion":"failure","exitCode":2,"summary":null,"startedAt":1000,"completedAt":66000},
                            {"key":"test","name":"Tests","needs":["lint"],"status":"completed","conclusion":"skipped","exitCode":null,"summary":null,"startedAt":null,"completedAt":66000}
                        ]}),
                    ),
                    "getCiJobLog" => (
                        200,
                        json!({"text":format!("log of {}", input["job"].as_str().unwrap()),"truncated":false}),
                    ),
                    "cancelCiRun" => {
                        current = run("completed", json!("cancelled"));
                        (200, current.clone())
                    }
                    "startCiRun" => {
                        current = run("queued", Value::Null);
                        current["branch"] = input["branch"].clone();
                        current["trigger"] = json!("manual");
                        (200, current.clone())
                    }
                    "getCiPipeline" => (
                        200,
                        json!({"projectId":"project-1","revision":2,"source":"version: 1\n","enabled":true,"jobs":[],"required":["lint"],"egressAllowlist":[],"updatedAt":1}),
                    ),
                    "updateCiPipeline" => {
                        saves += 1;
                        match saves {
                            1 => (
                                400,
                                json!({"code":"CI_PIPELINE_INVALID","message":"The CI pipeline is not valid.","detail":"jobs: required map"}),
                            ),
                            2 => (
                                409,
                                json!({"code":"CI_PIPELINE_CHANGED","message":"The CI pipeline changed. Reload it and try again."}),
                            ),
                            _ => (
                                200,
                                json!({"projectId":"project-1","revision":3,"source":input["source"],"enabled":true,"jobs":[],"required":[],"egressAllowlist":[],"updatedAt":2}),
                            ),
                        }
                    }
                    _ => panic!("unexpected checks RPC: {name}"),
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
) -> (AnyWindowHandle, Entity<ChecksView>) {
    let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
        .unwrap()
        .client(tempo_client::Token::new("native-test-token"));
    cx.background_executor.allow_parking();
    cx.update(|cx| {
        gpui_kit::init(cx);
        gpui_kit::open_window(Default::default(), cx, |window, cx| {
            cx.new(|cx| ChecksView::new(client, "project-1".into(), window, cx))
        })
        .unwrap()
    })
}

fn wait(cx: &mut TestAppContext, view: &Entity<ChecksView>, done: impl Fn(&ChecksView) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        if view.read_with(cx, |view, _| done(view)) {
            return;
        }
        assert!(Instant::now() < deadline, "checks RPC did not finish");
        std::thread::yield_now();
    }
}

#[gpui_kit::test]
fn checks_list_run_detail_logs_cancel_and_start_use_typed_rpcs(cx: &mut TestAppContext) {
    let server = Server::new();
    let runtime = tempo_client::Runtime::start().unwrap();
    let (window, view) = mount(cx, &server, &runtime);
    wait(cx, &view, |view| {
        !view.loading && view.pipeline.is_some() && view.runs.len() == 1
    });
    view.update(cx, |view, cx| view.open_run("run-1".into(), cx));
    wait(cx, &view, |view| {
        view.log
            .as_ref()
            .is_some_and(|log| log.text == "log of lint")
    });
    view.update(cx, |view, cx| {
        view.job = Some("test".into());
        view.load_log(cx);
    });
    wait(cx, &view, |view| {
        view.log
            .as_ref()
            .is_some_and(|log| log.text == "log of test")
    });
    view.update(cx, |view, cx| view.cancel_run(cx));
    wait(cx, &view, |view| {
        view.run
            .as_ref()
            .is_some_and(|detail| detail.run.status == p::CiRunStatus::Completed)
    });
    assert_eq!(
        server.calls("cancelCiRun"),
        vec![json!({"projectId":"project-1","runId":"run-1"})]
    );
    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| {
            view.branch
                .update(cx, |input, cx| input.set_value("main", window, cx));
            view.start_run(cx);
        })
    })
    .unwrap();
    wait(cx, &view, |view| {
        !view.pending
            && view
                .run
                .as_ref()
                .is_some_and(|detail| detail.run.branch == "main")
    });
    assert_eq!(
        server.calls("startCiRun"),
        vec![json!({"projectId":"project-1","branch":"main"})]
    );
}

#[gpui_kit::test]
fn pipeline_save_shows_detail_then_offers_reload_then_saves(cx: &mut TestAppContext) {
    let server = Server::new();
    let runtime = tempo_client::Runtime::start().unwrap();
    let (window, view) = mount(cx, &server, &runtime);
    wait(cx, &view, |view| view.pipeline.is_some());
    let save = |cx: &mut TestAppContext| {
        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| {
                view.source.update(cx, |input, cx| {
                    input.set_value("version: 1\njobs: {}\n", window, cx)
                });
                view.save_pipeline(window, cx);
            })
        })
        .unwrap();
        wait(cx, &view, |view| !view.pending);
    };
    save(cx);
    assert_eq!(
        view.read_with(cx, |view, _| view.problem.clone()),
        Some(("jobs: required map".into(), false))
    );
    save(cx);
    assert!(view.read_with(cx, |view, _| view.problem.as_ref().is_some_and(|p| p.1)));
    save(cx);
    view.read_with(cx, |view, _| {
        assert!(view.problem.is_none());
        assert_eq!(view.pipeline.as_ref().unwrap().revision, 3.);
    });
    assert_eq!(
        server.calls("updateCiPipeline")[0],
        json!({"projectId":"project-1","source":"version: 1\njobs: {}\n","revision":2.0})
    );
}
