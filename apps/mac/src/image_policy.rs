//! No remote images (05, 07 R14).
//!
//! Two guards, because spike S11 found that one is not enough:
//! - [`blocked_http_client`] replaces GPUI's HTTP client for the whole app. The app does its own
//!   networking on the tokio runtime (07, C6), so GPUI never needs to fetch anything.
//! - [`LocalImageCache`] is the transcript's `ImageCache`; it refuses every URI resource. GPUI only
//!   consults the cache stack in `request_layout` and `paint`, so images laid out during
//!   `prepaint` (list rows, TextView inline images) fall back to the global loader, which the
//!   first guard covers. Wrap each transcript row, not only the list, in `image_cache(..)`.
use gpui_kit::http_client::{BlockedHttpClient, HttpClient};
use gpui_kit::{
    App, AppContext as _, Context, Entity, ImageCache, ImageCacheError, RenderImage, Resource,
    RetainAllImageCache, SharedString, Window,
};
use std::sync::Arc;

pub fn blocked_http_client() -> Arc<dyn HttpClient> {
    Arc::new(BlockedHttpClient::new())
}

/// Every `Resource::Uri` goes through GPUI's HTTP client, whatever its scheme, so all are refused.
/// Paths and embedded assets load as usual; ACP images arrive as inline data, not URIs.
pub fn is_blocked(resource: &Resource) -> bool {
    matches!(resource, Resource::Uri(_))
}

pub struct LocalImageCache {
    inner: Entity<RetainAllImageCache>,
}

impl LocalImageCache {
    pub fn new(cx: &mut App) -> Entity<Self> {
        let inner = RetainAllImageCache::new(cx);
        cx.new(|_: &mut Context<Self>| Self { inner })
    }
}

impl ImageCache for LocalImageCache {
    fn load(
        &mut self,
        resource: &Resource,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Result<Arc<RenderImage>, ImageCacheError>> {
        if is_blocked(resource) {
            return Some(Err(ImageCacheError::Asset(SharedString::new_static(
                "Remote images are not loaded.",
            ))));
        }
        self.inner.update(cx, |cache, cx| cache.load(resource, window, cx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn uris_are_blocked_and_local_files_are_not() {
        for uri in ["https://x.test/p.png", "http://x.test/p.png", "data:image/png;base64,AA==", "file:///a.png"] {
            assert!(is_blocked(&Resource::Uri(uri.to_string().into())), "{uri}");
        }
        assert!(!is_blocked(&Resource::Path(Arc::from(Path::new("/tmp/a.png")))));
        assert!(!is_blocked(&Resource::Embedded("icons/x.svg".into())));
    }
}
