//! `tempo://workspace/<workspaceId>` opens that workspace; any other path is ignored
//! (07, URL scheme). GPUI delivers the URLs through `App::on_open_urls`.

pub const SCHEME: &str = "tempo";

/// The workspace id from a `tempo://` URL. The id is checked for shape only; an unknown id
/// opens the workspace view, which shows `Not found.` as for close code 4404.
pub fn workspace_id(url: &str) -> Option<&str> {
    let (scheme, rest) = url.split_once("://")?;
    if !scheme.eq_ignore_ascii_case(SCHEME) {
        return None;
    }
    let id = rest.strip_prefix("workspace/")?;
    let valid = !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric());
    valid.then_some(id)
}

#[cfg(test)]
mod tests {
    use super::workspace_id;

    #[test]
    fn opens_a_workspace() {
        assert_eq!(
            workspace_id("tempo://workspace/01j9z3k8m2n4p6q8r0s2t4v6w8"),
            Some("01j9z3k8m2n4p6q8r0s2t4v6w8")
        );
    }

    #[test]
    fn ignores_every_other_path() {
        for url in [
            "tempo://workspace/",
            "tempo://workspace/a/b",
            "tempo://workspace/a?x=1",
            "tempo://settings",
            "tempo://workspace",
            "https://workspace/abc",
            "tempo:workspace/abc",
            "tempo://workspace/../x",
        ] {
            assert_eq!(workspace_id(url), None, "{url}");
        }
    }
}
