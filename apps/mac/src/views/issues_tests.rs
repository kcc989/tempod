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
    fail_comment: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl Server {
    fn new() -> Self {
        Self::configured(false)
    }

    fn configured(paged: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let log = requests.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let fail_comment = Arc::new(AtomicBool::new(false));
        let failure = fail_comment.clone();
        let worker = std::thread::spawn(move || {
            let mut labels: Vec<Value> = vec![];
            let mut issue: Option<Value> = None;
            let mut comments: Vec<Value> = vec![];
            if paged {
                issue = Some(
                    json!({"id":"issue-51","projectId":"project-1","number":51,"title":"Paged issue","body":"","state":"open","authorId":"owner","createdAt":1,"updatedAt":1,"closedAt":null,"url":"https://tempo.test/issues/51","labels":[],"commentCount":51}),
                );
                comments = (0..51).map(|index| json!({"id":format!("paged-{index}"),"issueId":"issue-51","authorId":"owner","body":format!("Comment {index}"),"createdAt":index + 1,"updatedAt":index + 1})).collect();
            }
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
                let mut status = 200;
                let result = match name.as_str() {
                    "listRepositoryLabels" => json!(labels),
                    "createRepositoryLabel" => {
                        let label = json!({"id":"label-1","projectId":"project-1","name":input["name"],"color":input["color"],"description":input["description"],"createdAt":1,"updatedAt":1});
                        labels.push(label.clone());
                        label
                    }
                    "updateRepositoryLabel" => {
                        let label = labels
                            .iter_mut()
                            .find(|label| label["id"] == input["labelId"])
                            .unwrap();
                        for field in ["name", "color", "description"] {
                            if let Some(value) = input.get(field) {
                                label[field] = value.clone();
                            }
                        }
                        label.clone()
                    }
                    "deleteRepositoryLabel" => {
                        labels.retain(|label| label["id"] != input["labelId"]);
                        if let Some(issue) = &mut issue {
                            issue["labels"]
                                .as_array_mut()
                                .unwrap()
                                .retain(|label| label["id"] != input["labelId"]);
                        }
                        json!({})
                    }
                    "listRepositoryIssues" => {
                        let matches = issue.as_ref().filter(|issue| {
                            let state = input["state"].as_str().unwrap_or("open");
                            (state == "all" || issue["state"] == state)
                                && input
                                    .get("query")
                                    .and_then(Value::as_str)
                                    .is_none_or(|query| {
                                        issue["title"]
                                            .as_str()
                                            .unwrap()
                                            .to_lowercase()
                                            .contains(&query.to_lowercase())
                                    })
                                && input.get("labelId").is_none_or(|id| {
                                    issue["labels"]
                                        .as_array()
                                        .unwrap()
                                        .iter()
                                        .any(|label| &label["id"] == id)
                                })
                        });
                        if paged {
                            let offset = input["offset"].as_f64().unwrap_or(0.) as usize;
                            json!(
                                matches
                                    .into_iter()
                                    .flat_map(|issue| (1..=51).rev().skip(offset).take(50).map(
                                        move |number| {
                                            let mut issue = issue.clone();
                                            issue["id"] = json!(format!("issue-{number}"));
                                            issue["number"] = json!(number);
                                            issue
                                        }
                                    ))
                                    .collect::<Vec<_>>()
                            )
                        } else {
                            json!(matches.into_iter().collect::<Vec<_>>())
                        }
                    }
                    "createRepositoryIssue" => {
                        let selected: Vec<_> = labels
                            .iter()
                            .filter(|label| {
                                input["labelIds"].as_array().unwrap().contains(&label["id"])
                            })
                            .cloned()
                            .collect();
                        let created = json!({"id":"issue-1","projectId":"project-1","number":1,"title":input["title"],"body":input["body"],"state":"open","authorId":"owner","createdAt":1,"updatedAt":1,"closedAt":null,"url":"https://tempo.test/repositories?project=project-1&tab=issues&issue=1","labels":selected,"commentCount":0});
                        issue = Some(created.clone());
                        created
                    }
                    "updateRepositoryIssue" => {
                        let current = issue.as_mut().unwrap();
                        for field in ["title", "body", "state"] {
                            if let Some(value) = input.get(field) {
                                current[field] = value.clone();
                            }
                        }
                        if let Some(ids) = input.get("labelIds") {
                            current["labels"] = json!(
                                labels
                                    .iter()
                                    .filter(|label| ids.as_array().unwrap().contains(&label["id"]))
                                    .collect::<Vec<_>>()
                            );
                        }
                        current["closedAt"] = if current["state"] == "closed" {
                            json!(2)
                        } else {
                            Value::Null
                        };
                        current.clone()
                    }
                    "getRepositoryIssue" => issue.clone().unwrap(),
                    "listRepositoryIssueComments" => json!(
                        comments
                            .iter()
                            .skip(input["offset"].as_f64().unwrap_or(0.) as usize)
                            .take(50)
                            .collect::<Vec<_>>()
                    ),
                    "createRepositoryIssueComment" if failure.swap(false, Ordering::Relaxed) => {
                        status = 400;
                        json!({"code":"VALIDATION_FAILED","message":"Comment was rejected."})
                    }
                    "createRepositoryIssueComment" => {
                        let comment = json!({"id":"comment-1","issueId":issue.as_ref().unwrap()["id"],"authorId":"owner","body":input["body"],"createdAt":100,"updatedAt":100});
                        comments.push(comment.clone());
                        issue.as_mut().unwrap()["commentCount"] = json!(comments.len());
                        comment
                    }
                    "updateRepositoryIssueComment" => {
                        let comment = comments
                            .iter_mut()
                            .find(|comment| comment["id"] == input["commentId"])
                            .unwrap();
                        comment["body"] = input["body"].clone();
                        comment.clone()
                    }
                    "deleteRepositoryIssueComment" => {
                        comments.retain(|comment| comment["id"] != input["commentId"]);
                        issue.as_mut().unwrap()["commentCount"] = json!(comments.len());
                        json!({})
                    }
                    _ => panic!("unexpected issues RPC: {name}"),
                };
                let body = serde_json::to_vec(&result).unwrap();
                write!(stream, "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                stream.write_all(&body).unwrap();
            }
        });
        Self {
            url,
            requests,
            fail_comment,
            stop,
            worker: Some(worker),
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.worker.take().unwrap().join().unwrap();
    }
}

fn mount(cx: &mut TestAppContext, client: Client) -> (AnyWindowHandle, Entity<IssuesView>) {
    cx.background_executor.allow_parking();
    cx.update(|cx| {
        gpui_kit::init(cx);
        gpui_kit::open_window(Default::default(), cx, |window, cx| {
            cx.new(|cx| IssuesView::new(client, "project-1".into(), window, cx))
        })
        .unwrap()
    })
}

fn settle(cx: &mut TestAppContext, view: &Entity<IssuesView>) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        if view.read_with(cx, |view, _| {
            !view.loading && !view.comments_loading && !view.labels_loading && !view.pending
        }) {
            return;
        }
        assert!(Instant::now() < deadline, "issue RPC did not finish");
        std::thread::yield_now();
    }
}

#[gpui_kit::test]
fn issue_discussion_and_labels_edit_the_server_records_and_filter_closed_items(
    cx: &mut TestAppContext,
) {
    let server = Server::new();
    let runtime = tempo_client::Runtime::start().unwrap();
    let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
        .unwrap()
        .client(tempo_client::Token::new("native-test-token"));
    let (window, view) = mount(cx, client);
    settle(cx, &view);
    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| {
            view.edit_label(None, window, cx);
            view.inputs
                .label_name
                .update(cx, |input, cx| input.set_value("bug", window, cx));
            view.save_label(cx);
        })
    })
    .unwrap();
    settle(cx, &view);
    assert_eq!(
        view.read_with(cx, |view, _| view.labels[0].name.clone()),
        "bug"
    );
    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| {
            view.edit_issue(false, window, cx);
            view.inputs
                .title
                .update(cx, |input, cx| input.set_value("Native issue", window, cx));
            view.inputs.body.update(cx, |input, cx| {
                input.set_value("<script>plain text</script>", window, cx)
            });
            view.selected_labels.push("label-1".into());
            view.save_issue(cx);
        })
    })
    .unwrap();
    settle(cx, &view);
    view.read_with(cx, |view, _| {
        assert_eq!(view.issue.as_ref().unwrap().title, "Native issue");
        assert_eq!(view.issue.as_ref().unwrap().labels[0].name, "bug");
    });
    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| {
            view.edit_issue(true, window, cx);
            view.inputs.title.update(cx, |input, cx| {
                input.set_value("Regression title", window, cx)
            });
            view.save_issue(cx);
        })
    })
    .unwrap();
    settle(cx, &view);
    view.read_with(cx, |view, _| {
        assert_eq!(view.issue.as_ref().unwrap().title, "Regression title")
    });
    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| {
            view.inputs
                .search
                .update(cx, |input, cx| input.set_value("missing title", window, cx));
            view.load_issues(false, cx);
        })
    })
    .unwrap();
    settle(cx, &view);
    view.read_with(cx, |view, _| assert!(view.issues.is_empty()));
    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| {
            view.inputs
                .search
                .update(cx, |input, cx| input.set_value("Regression", window, cx));
            view.label_filter = Some("label-1".into());
            view.load_issues(false, cx);
        })
    })
    .unwrap();
    settle(cx, &view);
    view.read_with(cx, |view, _| assert_eq!(view.issues.len(), 1));
    server.fail_comment.store(true, Ordering::Relaxed);
    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| {
            view.inputs.comment.update(cx, |input, cx| {
                input.set_value("Keep this draft", window, cx)
            });
            view.save_comment(window, cx);
        })
    })
    .unwrap();
    settle(cx, &view);
    view.read_with(cx, |view, cx| {
        assert_eq!(view.inputs.comment.read(cx).value(), "Keep this draft");
        assert!(
            view.error
                .as_ref()
                .unwrap()
                .contains("Comment was rejected")
        );
        assert!(view.comments.is_empty());
    });
    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| view.save_comment(window, cx))
    })
    .unwrap();
    settle(cx, &view);
    view.read_with(cx, |view, cx| {
        assert_eq!(view.comments[0].body, "Keep this draft");
        assert!(view.inputs.comment.read(cx).value().is_empty());
        assert_eq!(view.issue.as_ref().unwrap().comment_count, 1.);
    });
    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| {
            let comment = view.comments[0].clone();
            view.edit_comment(comment, window, cx);
            view.inputs
                .comment
                .update(cx, |input, cx| input.set_value("Edited reply", window, cx));
            view.save_comment(window, cx);
        })
    })
    .unwrap();
    settle(cx, &view);
    view.update(cx, |view, cx| {
        assert_eq!(view.comments[0].body, "Edited reply");
        view.confirm_delete_comment("comment-1".into(), cx);
    });
    settle(cx, &view);
    view.read_with(cx, |view, _| {
        assert!(view.comments.is_empty());
        assert_eq!(view.issue.as_ref().unwrap().comment_count, 0.);
    });
    view.update(cx, |view, cx| view.toggle_state(cx));
    settle(cx, &view);
    view.read_with(cx, |view, _| {
        assert_eq!(view.issue.as_ref().unwrap().state, p::IssueState::Closed);
        assert!(view.issues.is_empty());
    });
    view.update(cx, |view, cx| {
        view.filter = IssueFilter::Closed;
        view.load_issues(false, cx);
    });
    settle(cx, &view);
    view.read_with(cx, |view, _| assert_eq!(view.issues.len(), 1));
    view.update(cx, |view, cx| view.toggle_state(cx));
    settle(cx, &view);
    view.read_with(cx, |view, _| {
        assert_eq!(view.issue.as_ref().unwrap().state, p::IssueState::Open);
        assert!(view.issues.is_empty());
    });
    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| {
            let label = view.labels[0].clone();
            view.edit_label(Some(label), window, cx);
            view.inputs
                .label_name
                .update(cx, |input, cx| input.set_value("regression", window, cx));
            view.save_label(cx);
        })
    })
    .unwrap();
    settle(cx, &view);
    view.read_with(cx, |view, _| {
        assert_eq!(view.issue.as_ref().unwrap().labels[0].name, "regression")
    });
    view.update(cx, |view, cx| {
        view.confirm_delete_label("label-1".into(), cx)
    });
    settle(cx, &view);
    view.read_with(cx, |view, _| {
        assert!(view.labels.is_empty());
        assert!(view.issue.as_ref().unwrap().labels.is_empty());
    });
    let requests = server.requests.lock().unwrap();
    assert!(
        requests
            .iter()
            .all(|(_, input)| input["projectId"] == "project-1")
    );
    assert!(
        requests
            .iter()
            .any(|(name, input)| name == "createRepositoryIssue"
                && input["labelIds"] == json!(["label-1"]))
    );
}

#[gpui_kit::test]
fn paging_retains_the_applied_search_and_deduplicates_a_new_reply(cx: &mut TestAppContext) {
    let server = Server::configured(true);
    let runtime = tempo_client::Runtime::start().unwrap();
    let client = tempo_client::Server::new(&runtime.handle(), &server.url, crate::VERSION)
        .unwrap()
        .client(tempo_client::Token::new("native-test-token"));
    let (window, view) = mount(cx, client);
    settle(cx, &view);
    view.read_with(cx, |view, _| {
        assert_eq!(view.issues.len(), 50);
        assert!(view.more_issues);
    });
    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| {
            view.inputs.search.update(cx, |input, cx| {
                input.set_value("Unapplied search draft", window, cx)
            });
            view.load_issues(true, cx);
        })
    })
    .unwrap();
    settle(cx, &view);
    view.read_with(cx, |view, _| {
        assert_eq!(view.issues.len(), 51);
        assert!(!view.more_issues);
        assert_eq!(view.issues.last().unwrap().number, 1.);
    });
    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| view.open_issue(51., window, cx))
    })
    .unwrap();
    settle(cx, &view);
    view.read_with(cx, |view, _| {
        assert_eq!(view.comments.len(), 50);
        assert!(view.more_comments);
    });
    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| {
            view.inputs
                .comment
                .update(cx, |input, cx| input.set_value("Late reply", window, cx));
            view.save_comment(window, cx);
        })
    })
    .unwrap();
    settle(cx, &view);
    view.update(cx, |view, cx| view.load_comments(true, cx));
    settle(cx, &view);
    view.read_with(cx, |view, _| {
        assert_eq!(view.comments.len(), 52);
        assert_eq!(
            view.comments
                .iter()
                .filter(|comment| comment.id == "comment-1")
                .count(),
            1
        );
        assert_eq!(view.comments.last().unwrap().body, "Late reply");
        assert!(!view.more_comments);
    });
}
