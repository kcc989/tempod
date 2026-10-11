//! AppState (07, Architecture): server URL, auth state, the HubStore and the open workspaces.
use crate::actions::*;
use crate::client::ClientRuntime;
use crate::platform::{self, TokenStore};
use crate::stores::hub::HubStore;
use crate::stores::workspace::{self, WorkspaceStore};
use gpui_kit::{App, AppContext as _, Context, Entity, Global, SharedString};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AuthState {
    /// **Connect to Tempo**, with the URL filled in when known (07, Sign-in and first run).
    Connect {
        url: Option<String>,
        error: Option<SharedString>,
    },
    /// The device code is shown and the app polls `/api/auth/device/token`.
    AwaitingApproval {
        user_code: String,
        verification_uri_complete: String,
    },
    SignedIn,
    /// The app is older than `minMacClient`: only the update screen shows.
    UpdateRequired,
}

pub struct AppState {
    pub server_url: Option<String>,
    pub auth: AuthState,
    pub hub: Entity<HubStore>,
    /// Open workspace stores, the one shown most recently first.
    pub workspaces: Vec<Entity<WorkspaceStore>>,
    pub active_workspace: Option<String>,
    pub tokens: Box<dyn TokenStore>,
    runtime: ClientRuntime,
}

struct GlobalAppState(Entity<AppState>);

impl Global for GlobalAppState {}

impl AppState {
    pub fn new(runtime: ClientRuntime, cx: &mut App) -> Self {
        Self {
            server_url: None,
            auth: AuthState::Connect {
                url: None,
                error: None,
            },
            hub: cx.new(|_| HubStore::new()),
            workspaces: Vec::new(),
            active_workspace: None,
            tokens: platform::token_store(),
            runtime,
        }
    }

    pub fn global(cx: &App) -> Entity<AppState> {
        cx.global::<GlobalAppState>().0.clone()
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

    /// Sign out, or any 401: forget the token and show **Connect to Tempo**. Drafts and layout
    /// stay (07, Sign-in).
    pub fn sign_out(&mut self, cx: &mut Context<Self>) {
        if let Some(host) = self.server_url.as_deref().and_then(host_of) {
            self.tokens.delete(host);
        }
        self.workspaces.clear();
        self.active_workspace = None;
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

/// The Keychain account for a Tempo URL: its host (07, Local storage).
pub fn host_of(url: &str) -> Option<&str> {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let host = rest.split(['/', '?', '#']).next()?;
    (!host.is_empty()).then_some(host)
}

/// Sets up the AppState global, the app-level actions and `tempo://` handling.
pub fn init(runtime: ClientRuntime, urls: async_channel::Receiver<Vec<String>>, cx: &mut App) {
    let state = cx.new(|cx| AppState::new(runtime, cx));
    cx.set_global(GlobalAppState(state));

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

    #[test]
    fn keychain_account_is_the_host() {
        assert_eq!(
            host_of("https://tempo.example.com"),
            Some("tempo.example.com")
        );
        assert_eq!(
            host_of("https://tempo.example.com:8443/x?y"),
            Some("tempo.example.com:8443")
        );
        assert_eq!(host_of("https://"), None);
    }
}
