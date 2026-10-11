//! AppState (07, Architecture): server URL, auth state, the HubStore and the open workspaces.
use crate::actions::*;
use crate::client::ClientRuntime;
use crate::platform::{self, TokenStore};
use crate::stores::hub::HubStore;
use crate::stores::workspace::{self, WorkspaceStore};
use gpui_kit::{App, AppContext as _, Context, Entity, Global, Task};

pub use crate::auth::AuthState;
use crate::auth::{Session, error_state};
use tempo_client::{Server, Token, TokenStatus};

pub struct AppState {
    pub server_url: Option<String>,
    pub auth: AuthState,
    pub hub: Entity<HubStore>,
    /// Open workspace stores, the one shown most recently first.
    pub workspaces: Vec<Entity<WorkspaceStore>>,
    pub active_workspace: Option<String>,
    pub tokens: Box<dyn TokenStore>,
    runtime: ClientRuntime,
    session: Option<Session>,
    auth_task: Option<Task<()>>,
}

struct GlobalAppState(Entity<AppState>);

impl Global for GlobalAppState {}

impl AppState {
    pub fn new(runtime: ClientRuntime, cx: &mut App) -> Self {
        let url = cx.global::<crate::storage::Local>().config().url.clone();
        Self {
            server_url: url.clone(),
            auth: AuthState::Connect { url, error: None },
            hub: cx.new(|_| HubStore::new()),
            workspaces: Vec::new(),
            active_workspace: None,
            tokens: platform::token_store(),
            runtime,
            session: None,
            auth_task: None,
        }
    }

    pub fn global(cx: &App) -> Entity<AppState> {
        cx.global::<GlobalAppState>().0.clone()
    }

    pub fn try_global(cx: &App) -> Option<Entity<AppState>> {
        cx.try_global::<GlobalAppState>()
            .map(|state| state.0.clone())
    }

    pub fn runtime(&self) -> &ClientRuntime {
        &self.runtime
    }

    /// Shows a workspace: reuses its store or opens one, and evicts the store shown least
    /// recently beyond `workspace::MAX_OPEN`. Dropping a store closes its socket.
    pub fn show_workspace(&mut self, id: &str, cx: &mut Context<Self>) -> Entity<WorkspaceStore> {
        let mut order: Vec<String> = self
            .workspaces
            .iter()
            .map(|w| w.read(cx).workspace_id.clone())
            .collect();
        let evicted = touch_lru(&mut order, id, workspace::MAX_OPEN);
        let store = match self
            .workspaces
            .iter()
            .position(|w| w.read(cx).workspace_id == id)
        {
            Some(ix) => self.workspaces.remove(ix),
            None => cx.new(|_| WorkspaceStore::new(id)),
        };
        if let Some(evicted) = evicted {
            self.workspaces
                .retain(|w| w.read(cx).workspace_id != evicted);
        }
        for other in &self.workspaces {
            other.update(cx, |w, _| {
                w.hidden_since.get_or_insert_with(std::time::Instant::now);
            });
        }
        store.update(cx, |w, _| w.hidden_since = None);
        self.workspaces.insert(0, store.clone());
        self.active_workspace = Some(id.to_string());
        cx.notify();
        store
    }

    pub fn connect(&mut self, url: &str, restore: bool, cx: &mut Context<Self>) {
        self.auth_task.take();
        let server = match Server::new(&self.runtime.handle(), url, crate::VERSION) {
            Ok(server) => server,
            Err(error) => {
                self.auth = error_state(Some(url.to_string()), &error);
                cx.notify();
                return;
            }
        };
        self.server_url = Some(server.origin());
        let saved = restore
            .then(|| self.tokens.get(server.host()))
            .flatten()
            .map(Token::new);
        self.auth = AuthState::Connecting;
        cx.notify();
        self.auth_task = Some(cx.spawn(async move |this, cx| {
            let result = async {
                server.check_server().await?;
                if let Some(token) = saved {
                    match server.get_session(&token).await? {
                        TokenStatus::Valid => return Ok(token),
                        TokenStatus::Revoked => {
                            let _ = this.update(cx, |state, cx| {
                                state.tokens.delete(server.host());
                                state.reset_auth(cx);
                            });
                            return Err(tempo_client::SignInError::Cancelled);
                        }
                    }
                }
                let authorization = server.start_device_flow().await?;
                let uri = authorization.verification_uri_complete.clone();
                if this
                    .update(cx, |state, cx| {
                        state.auth = AuthState::AwaitingApproval {
                            user_code: authorization.user_code.clone(),
                            verification_uri_complete: uri.clone(),
                        };
                        cx.open_url(&uri);
                        cx.notify();
                    })
                    .is_err()
                {
                    return Err(tempo_client::SignInError::Cancelled);
                }
                server.poll_token(&authorization).await
            }
            .await;
            let _ = this.update(cx, |state, cx| match result {
                Ok(token) => {
                    if state.tokens.set(server.host(), token.expose()).is_err() {
                        state.auth = AuthState::Connect {
                            url: state.server_url.clone(),
                            error: Some(
                                "Could not save the sign-in token in Keychain. Try again.".into(),
                            ),
                        };
                    } else {
                        let origin = server.origin();
                        cx.global_mut::<crate::storage::Local>()
                            .update_config(|config| config.url = Some(origin));
                        let session = Session::new(server, token);
                        state
                            .hub
                            .update(cx, |hub, cx| hub.connect(&session.client, cx));
                        state.session = Some(session);
                        state.auth = AuthState::SignedIn;
                    }
                    cx.notify();
                }
                Err(tempo_client::SignInError::Cancelled) => {}
                Err(error) => {
                    state.auth = error_state(state.server_url.clone(), &error);
                    cx.notify();
                }
            });
        }));
    }

    pub fn sign_out(&mut self, cx: &mut Context<Self>) {
        if let Some(session) = &self.session {
            let request = session.sign_out();
            cx.spawn(async move |_, _| {
                let _ = request.await;
            })
            .detach();
        }
        self.reset_auth(cx);
    }

    pub fn reset_auth(&mut self, cx: &mut Context<Self>) {
        self.auth_task.take();
        if let Some(session) = self.session.take() {
            session.forget(self.tokens.as_ref());
        }
        crate::platform::set_badge_count(0);
        self.workspaces.clear();
        self.active_workspace = None;
        self.hub.update(cx, |hub, cx| {
            *hub = HubStore::new();
            cx.notify();
        });
        self.auth = AuthState::Connect {
            url: self.server_url.clone(),
            error: None,
        };
        cx.notify();
    }
}

/// Moves `id` to the front of `order` and returns the id pushed out beyond `cap`, if any.
pub fn touch_lru(order: &mut Vec<String>, id: &str, cap: usize) -> Option<String> {
    order.retain(|x| x != id);
    order.insert(0, id.to_string());
    (order.len() > cap).then(|| order.pop()).flatten()
}

/// Sets up the AppState global, the app-level actions and `tempo://` handling.
pub fn init(runtime: ClientRuntime, urls: async_channel::Receiver<Vec<String>>, cx: &mut App) {
    let signals = runtime.handle().signals();
    let state = cx.new(|cx| AppState::new(runtime, cx));
    cx.set_global(GlobalAppState(state.clone()));
    if let Some(url) = state.read(cx).server_url.clone() {
        state.update(cx, |state, cx| state.connect(&url, true, cx));
    }

    cx.on_action(|_: &Quit, cx| cx.quit());
    cx.on_action(|_: &HideApp, cx| cx.hide());
    cx.on_action(|_: &OpenSettings, cx| crate::views::settings::open(cx));
    cx.on_action(|_: &SignOut, cx| {
        AppState::global(cx).update(cx, |state, cx| state.sign_out(cx));
    });
    cx.on_action(|_: &OpenTempoInBrowser, cx| {
        if let Some(url) = AppState::global(cx).read(cx).server_url.clone() {
            cx.open_url(&url);
        }
    });

    cx.spawn(async move |cx| {
        while let Ok(signal) = signals.recv().await {
            cx.update(|cx| {
                AppState::global(cx).update(cx, |state, cx| match signal {
                    tempo_client::Signal::Unauthorized => {
                        if state
                            .session
                            .as_ref()
                            .is_some_and(|session| session.client.is_unauthorized())
                        {
                            state.reset_auth(cx);
                        }
                    }
                    tempo_client::Signal::UpdateRequired => {
                        state.reset_auth(cx);
                        state.auth = AuthState::UpdateRequired;
                        cx.notify();
                    }
                });
            });
        }
    })
    .detach();

    cx.spawn(async move |cx| {
        while let Ok(batch) = urls.recv().await {
            cx.update(|cx| open_urls(&batch, cx));
        }
    })
    .detach();
}

fn open_urls(urls: &[String], cx: &mut App) {
    if let Some(id) = urls.iter().find_map(|u| crate::url_scheme::workspace_id(u)) {
        let id = id.to_string();
        AppState::global(cx).update(cx, |state, cx| {
            state.show_workspace(&id, cx);
        });
        cx.activate(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lru_keeps_five_and_evicts_the_least_recently_shown() {
        let mut order = Vec::new();
        for id in ["a", "b", "c", "d", "e"] {
            assert_eq!(touch_lru(&mut order, id, 5), None);
        }
        assert_eq!(touch_lru(&mut order, "b", 5), None);
        assert_eq!(order, ["b", "e", "d", "c", "a"]);
        assert_eq!(touch_lru(&mut order, "f", 5), Some("a".to_string()));
        assert_eq!(order, ["f", "b", "e", "d", "c"]);
    }
}

#[cfg(test)]
mod auth_tests {
    use super::*;
    use gpui_kit::TestAppContext;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    };
    use std::time::{Duration, Instant};

    struct FakeServer {
        url: String,
        paths: Arc<Mutex<Vec<String>>>,
        stop: Arc<AtomicBool>,
        worker: Option<std::thread::JoinHandle<()>>,
    }

    impl FakeServer {
        fn new(mode: &'static str) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let stop = Arc::new(AtomicBool::new(false));
            let stopped = stop.clone();
            let paths = Arc::new(Mutex::new(Vec::new()));
            let requests = paths.clone();
            let worker = std::thread::spawn(move || {
                while !stopped.load(Ordering::Relaxed) {
                    let Ok((mut stream, _)) = listener.accept() else {
                        std::thread::sleep(Duration::from_millis(2));
                        continue;
                    };
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut head = Vec::new();
                    loop {
                        let mut bytes = [0; 4096];
                        let Ok(n) = stream.read(&mut bytes) else {
                            break;
                        };
                        if n == 0 {
                            break;
                        }
                        head.extend_from_slice(&bytes[..n]);
                        if head.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    let head = String::from_utf8_lossy(&head);
                    let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                    requests.lock().unwrap().push(path.clone());
                    let (status, body) = match path.as_str() {
                        "/api/v1/meta" => (
                            200,
                            if mode == "update" {
                                r#"{"protocol":1,"serverVersion":"0.1.0","minMacClient":"9.0.0","latestMacClient":null}"#
                            } else {
                                r#"{"protocol":1,"serverVersion":"0.1.0","minMacClient":"0.1.0","latestMacClient":null}"#
                            },
                        ),
                        "/api/auth/get-session" => (
                            200,
                            if mode == "revoked" {
                                "null"
                            } else {
                                r#"{"session":{"id":"s"}}"#
                            },
                        ),
                        "/api/auth/device/code" => (
                            200,
                            r#"{"device_code":"secret-code","user_code":"ABCD1234","verification_uri":"https://tempo.test/device","verification_uri_complete":"https://tempo.test/device?user_code=ABCD1234","expires_in":900,"interval":1}"#,
                        ),
                        "/api/auth/device/token" => {
                            if mode == "denied" {
                                (400, r#"{"error":"access_denied"}"#)
                            } else {
                                (200, r#"{"access_token":"test-token"}"#)
                            }
                        }
                        "/api/auth/sign-out" => (500, "{}"),
                        "/api/v1/rpc/listProjects" => {
                            if mode == "unauthorized" {
                                (401, "{}")
                            } else {
                                (200, "[]")
                            }
                        }
                        _ => (404, "{}"),
                    };
                    let reply = format!(
                        "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(reply.as_bytes());
                }
            });
            Self {
                url,
                paths,
                stop,
                worker: Some(worker),
            }
        }
    }
    impl Drop for FakeServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            self.worker.take().unwrap().join().unwrap();
        }
    }

    fn state(cx: &mut TestAppContext) -> Entity<AppState> {
        cx.background_executor.allow_parking();
        cx.update(|cx| {
            cx.set_global(crate::storage::Local::load(None));
            let runtime = ClientRuntime::start().unwrap();
            cx.new(|cx| {
                let mut state = AppState::new(runtime, cx);
                state.tokens = Box::<platform::MemoryTokenStore>::default();
                state
            })
        })
    }

    fn until(
        cx: &mut TestAppContext,
        state: &Entity<AppState>,
        predicate: impl Fn(&AuthState) -> bool,
    ) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            cx.run_until_parked();
            if state.read_with(cx, |state, _| predicate(&state.auth)) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "auth state did not change: {:?}",
                state.read_with(cx, |state, _| state.auth.clone())
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[gpui_kit::test]
    fn later_launch_validates_the_saved_token(cx: &mut TestAppContext) {
        let server = FakeServer::new("valid");
        let state = state(cx);
        state.update(cx, |state, cx| {
            state.tokens.set("127.0.0.1", "test-token").unwrap();
            state.connect(&server.url, true, cx);
        });
        until(cx, &state, |auth| *auth == AuthState::SignedIn);
        assert!(
            server
                .paths
                .lock()
                .unwrap()
                .iter()
                .any(|p| p == "/api/auth/get-session")
        );
        assert!(
            !server
                .paths
                .lock()
                .unwrap()
                .iter()
                .any(|p| p == "/api/auth/device/code")
        );
        state.update(cx, |state, cx| state.reset_auth(cx));
    }

    #[gpui_kit::test]
    fn revoked_session_returns_to_connect_with_saved_url(cx: &mut TestAppContext) {
        let server = FakeServer::new("revoked");
        let state = state(cx);
        state.update(cx, |state, cx| {
            state.tokens.set("127.0.0.1", "test-token").unwrap();
            state.connect(&server.url, true, cx);
        });
        until(cx, &state, |auth| matches!(auth, AuthState::Connect { .. }));
        state.read_with(cx, |state, _| {
            assert!(state.tokens.get("127.0.0.1").is_none());
            assert_eq!(
                state.auth,
                AuthState::Connect {
                    url: Some(server.url.clone()),
                    error: None
                }
            );
        });
    }

    #[gpui_kit::test]
    fn incompatible_app_stops_before_device_authorization(cx: &mut TestAppContext) {
        let server = FakeServer::new("update");
        let state = state(cx);
        state.update(cx, |state, cx| state.connect(&server.url, false, cx));
        until(cx, &state, |auth| *auth == AuthState::UpdateRequired);
        assert_eq!(*server.paths.lock().unwrap(), ["/api/v1/meta"]);
    }

    #[gpui_kit::test]
    fn approved_device_saves_token_and_sign_out_clears_it_even_on_server_error(
        cx: &mut TestAppContext,
    ) {
        let server = FakeServer::new("valid");
        let state = state(cx);
        state.update(cx, |state, cx| state.connect(&server.url, false, cx));
        until(cx, &state, |auth| {
            matches!(auth, AuthState::AwaitingApproval { .. })
        });
        state.read_with(cx, |state, _| assert!(matches!(&state.auth, AuthState::AwaitingApproval { user_code, .. } if user_code == "ABCD1234")));
        until(cx, &state, |auth| *auth == AuthState::SignedIn);
        state.read_with(cx, |state, cx| {
            assert_eq!(state.tokens.get("127.0.0.1").as_deref(), Some("test-token"));
            assert_eq!(
                cx.global::<crate::storage::Local>().config().url.as_deref(),
                Some(server.url.as_str())
            );
        });
        state.update(cx, |state, cx| state.sign_out(cx));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !server
            .paths
            .lock()
            .unwrap()
            .iter()
            .any(|p| p == "/api/auth/sign-out")
        {
            cx.run_until_parked();
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        state.read_with(cx, |state, _| {
            assert!(state.tokens.get("127.0.0.1").is_none());
            assert!(state.session.is_none());
            assert!(matches!(state.auth, AuthState::Connect { .. }));
        });
    }

    #[gpui_kit::test]
    fn denied_device_shows_spec_error(cx: &mut TestAppContext) {
        let server = FakeServer::new("denied");
        let state = state(cx);
        state.update(cx, |state, cx| state.connect(&server.url, false, cx));
        until(cx, &state, |auth| {
            matches!(auth, AuthState::Connect { error: Some(_), .. })
        });
        state.read_with(cx, |state, _| {
            assert_eq!(
                state.auth,
                error_state(Some(server.url.clone()), &tempo_client::SignInError::Denied)
            )
        });
    }

    #[gpui_kit::test]
    fn sign_out_cancels_pending_device_poll(cx: &mut TestAppContext) {
        let server = FakeServer::new("valid");
        let state = state(cx);
        state.update(cx, |state, cx| state.connect(&server.url, false, cx));
        until(cx, &state, |auth| {
            matches!(auth, AuthState::AwaitingApproval { .. })
        });
        state.update(cx, |state, cx| state.sign_out(cx));
        cx.run_until_parked();
        std::thread::sleep(Duration::from_millis(1100));
        cx.run_until_parked();
        assert!(
            !server
                .paths
                .lock()
                .unwrap()
                .iter()
                .any(|p| p == "/api/auth/device/token")
        );
        state.read_with(cx, |state, _| {
            assert!(matches!(state.auth, AuthState::Connect { .. }))
        });
    }
    #[gpui_kit::test]
    fn connect_form_uses_saved_url_and_enter_submits(cx: &mut TestAppContext) {
        use gpui_kit::test::TestWindowExt as _;
        let state = state(cx);
        state.update(cx, |state, _| {
            state.server_url = Some("invalid-tempo-url".into())
        });
        let (window, _) = cx.update(|cx| {
            gpui_kit::init(cx);
            cx.set_global(GlobalAppState(state.clone()));
            crate::views::main_window::open(Default::default(), cx).unwrap()
        });
        cx.update_window(window, |_, window, cx| {
            window.render_frame(cx);
            assert_eq!(window.find("tempo-url").value(), Some("invalid-tempo-url"));
            window.click("tempo-url", cx);
            window.press("enter", cx);
        })
        .unwrap();
        cx.run_until_parked();
        state.read_with(cx, |state, _| {
            assert_eq!(
                state.auth,
                error_state(
                    Some("invalid-tempo-url".into()),
                    &tempo_client::SignInError::NotTempo
                )
            )
        });
    }
    #[gpui_kit::test]
    fn unauthorized_rpc_returns_to_connect_and_forgets_token(cx: &mut TestAppContext) {
        cx.background_executor.allow_parking();
        let server = FakeServer::new("unauthorized");
        let state = cx.update(|cx| {
            cx.set_global(crate::storage::Local::load(None));
            let (_, urls) = async_channel::unbounded();
            init(ClientRuntime::start().unwrap(), urls, cx);
            AppState::global(cx)
        });
        state.update(cx, |state, cx| {
            state.tokens = Box::<platform::MemoryTokenStore>::default();
            state.tokens.set("127.0.0.1", "test-token").unwrap();
            state.connect(&server.url, true, cx);
        });
        until(cx, &state, |auth| matches!(auth, AuthState::Connect { .. }));
        assert!(
            server
                .paths
                .lock()
                .unwrap()
                .iter()
                .any(|p| p == "/api/v1/rpc/listProjects")
        );
        state.read_with(cx, |state, cx| {
            assert!(state.tokens.get("127.0.0.1").is_none());
            assert!(state.session.is_none());
            assert!(!state.hub.read(cx).state.ready);
        });
    }
}
