//! Project roles, project cards and the copy of 04, Public projects, stars and organizations, for
//! the native views. No GPUI, so it is unit tested on any platform.

use tempo_protocol as p;

/// What the viewer may do in a repository view (11, Function access).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Access {
    /// The membership role; `None` for a public visitor.
    pub role: Option<p::ProjectRole>,
}

const fn rank(role: p::ProjectRole) -> u8 {
    match role {
        p::ProjectRole::Read => 1,
        p::ProjectRole::Write => 2,
        p::ProjectRole::Admin => 3,
    }
}

impl Access {
    /// A project from `listProjects`: the caller has `write` or higher there. Projects from
    /// before roles have no `role`, and only their owner listed them.
    pub fn of_project(project: &p::Project) -> Self {
        Self {
            role: Some(project.role.unwrap_or(p::ProjectRole::Admin)),
        }
    }

    pub fn of_summary(summary: &p::ProjectSummary) -> Self {
        Self { role: summary.role }
    }

    fn at_least(self, need: p::ProjectRole) -> bool {
        self.role.is_some_and(|role| rank(role) >= rank(need))
    }

    /// CI runs and logs need a membership role, never a public grant.
    pub fn is_member(self) -> bool {
        self.role.is_some()
    }

    pub fn can_write(self) -> bool {
        self.at_least(p::ProjectRole::Write)
    }

    pub fn can_admin(self) -> bool {
        self.at_least(p::ProjectRole::Admin)
    }

    /// Comment edit and delete: the author with `write`, or an admin (11, policy `author`).
    pub fn can_edit_comment(self, author_id: &str, user_id: Option<&str>) -> bool {
        self.can_admin() || (self.can_write() && user_id == Some(author_id))
    }
}

/// `namespace/slug`, or `owner/name` for a project from before namespaces (04).
pub fn project_label(project: &p::Project) -> String {
    match (&project.namespace, &project.slug) {
        (Some(namespace), Some(slug)) => format!("{namespace}/{slug}"),
        _ => format!("{}/{}", project.owner, project.name),
    }
}

/// A browsing result as a `Project`, so the repository view shows it like a linked project.
pub fn project_from_summary(summary: &p::ProjectSummary) -> p::Project {
    p::Project {
        artifact_repo_id: None,
        clone_url: None,
        default_branch: summary.default_branch.clone(),
        environment_id: None,
        id: summary.id.clone(),
        installation_id: None,
        name: summary.name.clone(),
        namespace: Some(summary.namespace.clone()),
        organization_id: summary.organization_id.clone(),
        owner: summary.owner.clone(),
        provider: Some(match summary.provider {
            p::ProjectSummaryProvider::Artifacts => p::ProjectProvider::Artifacts,
            p::ProjectSummaryProvider::Github => p::ProjectProvider::Github,
        }),
        repo_id: None,
        role: summary.role,
        settings: p::SettingsLayer::default(),
        slug: Some(summary.slug.clone()),
        sort_order: 0.,
        visibility: Some(summary.visibility),
    }
}

/// One line of a project card (04): `namespace/slug · Private · Artifacts · ★ 3`.
pub fn card_label(summary: &p::ProjectSummary) -> String {
    let mut parts = vec![format!("{}/{}", summary.namespace, summary.slug)];
    if summary.visibility == p::ProjectVisibility::Private {
        parts.push("Private".into());
    }
    parts.push(
        match summary.provider {
            p::ProjectSummaryProvider::Artifacts => "Artifacts",
            p::ProjectSummaryProvider::Github => "GitHub",
        }
        .into(),
    );
    parts.push(format!("★ {}", summary.stars));
    parts.join(" · ")
}

/// The star button (04): `Star 3` or `Starred 4`.
pub fn star_label(state: &p::StarState) -> String {
    format!(
        "{} {}",
        if state.starred { "Starred" } else { "Star" },
        state.stars
    )
}

pub const EXPLORE_EMPTY: &str = "No public projects yet.";
pub const STARS_EMPTY: &str = "Star a project to keep it here.";
pub const MAKE_PUBLIC: &str =
    "Anyone, signed in or not, can read this repository, its issues and its pull requests.";
pub const ORGANIZATION_ROLES_NOTE: &str = "Organization owners and admins have admin on every project of the organization; members can read.";
pub const ASK_ADMIN_FOR_GITHUB: &str = "Ask the Tempo admin to link GitHub repositories.";

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(role: Option<p::ProjectRole>) -> p::ProjectSummary {
        serde_json::from_value(serde_json::json!({
            "id": "p1", "namespace": "acme", "slug": "site", "organizationId": null,
            "visibility": "private", "provider": "artifacts", "owner": "tempo", "name": "site",
            "defaultBranch": "main", "stars": 3, "starred": false, "role": role, "updatedAt": 1
        }))
        .unwrap()
    }

    #[test]
    fn roles_gate_writes_admin_pages_and_member_reads() {
        let visitor = Access { role: None };
        assert!(!visitor.is_member() && !visitor.can_write());
        let reader = Access {
            role: Some(p::ProjectRole::Read),
        };
        assert!(reader.is_member() && !reader.can_write());
        let writer = Access {
            role: Some(p::ProjectRole::Write),
        };
        assert!(writer.can_write() && !writer.can_admin());
        assert!(writer.can_edit_comment("me", Some("me")));
        assert!(!writer.can_edit_comment("other", Some("me")));
        let admin = Access {
            role: Some(p::ProjectRole::Admin),
        };
        assert!(admin.can_edit_comment("other", Some("me")));
    }

    #[test]
    fn summaries_open_as_projects_with_their_role() {
        let project = project_from_summary(&summary(None));
        assert_eq!(project_label(&project), "acme/site");
        assert_eq!(project.provider, Some(p::ProjectProvider::Artifacts));
        assert_eq!(Access::of_summary(&summary(None)), Access { role: None });
        let mut legacy = project.clone();
        legacy.role = None;
        legacy.namespace = None;
        assert_eq!(
            Access::of_project(&legacy).role,
            Some(p::ProjectRole::Admin)
        );
        assert_eq!(project_label(&legacy), "tempo/site");
    }

    #[test]
    fn cards_and_star_buttons_use_the_web_copy() {
        assert_eq!(
            card_label(&summary(None)),
            "acme/site · Private · Artifacts · ★ 3"
        );
        assert_eq!(
            star_label(&p::StarState {
                stars: 4.,
                starred: true
            }),
            "Starred 4"
        );
    }
}
