//! Public profile (11) rules shared by the sidebar and the repository header (07, Scope).
use tempo_protocol as p;

/// 04, Dialogs: the confirmation before a repository becomes public.
pub const MAKE_PUBLIC_CONFIRM: &str = "Anyone can read this repository's code, commits and branches without signing in, including commit author emails. Issues, pull requests and checks stay private.";

/// Rows from before 11 have no visibility; they are private.
pub fn visibility(project: &p::Project) -> p::ProjectVisibility {
    project.visibility.unwrap_or(p::ProjectVisibility::Private)
}

pub fn is_pinned(project: &p::Project) -> bool {
    project.pinned.unwrap_or(false)
}

/// The owner's username from `listProjects` (07, Scope); null until their next sign-in.
pub fn owner_username(projects: &[p::Project]) -> Option<String> {
    projects.iter().find_map(|project| project.username.clone())
}

/// Percent-encodes one URL path segment; unreserved characters stay as they are.
fn segment(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                char::from(b).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// `<Tempo URL>/<username>` (04, Public profile).
pub fn profile_url(origin: &str, username: &str) -> String {
    format!("{}/{}", origin.trim_end_matches('/'), segment(username))
}

/// `<Tempo URL>/<username>/<slug>`, only while the project is public.
pub fn public_page_url(origin: &str, project: &p::Project) -> Option<String> {
    if visibility(project) != p::ProjectVisibility::Public {
        return None;
    }
    let username = project.username.as_deref()?;
    let slug = project.slug.as_deref()?;
    Some(format!(
        "{}/{}",
        profile_url(origin, username),
        segment(slug)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(visibility: Option<p::ProjectVisibility>, username: Option<&str>) -> p::Project {
        let mut project: p::Project = serde_json::from_value(serde_json::json!({
            "id": "p1",
            "installationId": null,
            "repoId": null,
            "owner": "tempo",
            "name": "demo",
            "defaultBranch": "main",
            "settings": {},
            "sortOrder": 0,
            "slug": "my demo",
        }))
        .unwrap();
        project.visibility = visibility;
        project.username = username.map(String::from);
        project
    }

    #[test]
    fn older_rows_are_private_and_unpinned() {
        let old = project(None, None);
        assert_eq!(visibility(&old), p::ProjectVisibility::Private);
        assert!(!is_pinned(&old));
    }

    #[test]
    fn public_page_needs_public_visibility_and_a_username() {
        let origin = "https://tempo.example/";
        let public = project(Some(p::ProjectVisibility::Public), Some("octo"));
        assert_eq!(
            public_page_url(origin, &public).as_deref(),
            Some("https://tempo.example/octo/my%20demo")
        );
        assert_eq!(
            public_page_url(
                origin,
                &project(Some(p::ProjectVisibility::Private), Some("octo"))
            ),
            None
        );
        assert_eq!(
            public_page_url(origin, &project(Some(p::ProjectVisibility::Public), None)),
            None
        );
    }

    #[test]
    fn owner_username_comes_from_any_project() {
        let projects = [project(None, None), project(None, Some("octo"))];
        assert_eq!(owner_username(&projects).as_deref(), Some("octo"));
        assert_eq!(owner_username(&projects[..1]), None);
    }
}
