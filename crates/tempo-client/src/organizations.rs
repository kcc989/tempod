//! Organizations through the Better Auth plugin endpoints (11, Organizations; 04 and 07). They are
//! not Tempo server functions, so their types live here and not in tempo-protocol.

use std::future::Future;

use reqwest::header::CONTENT_TYPE;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tempo_protocol::{ErrorBody, ErrorCode};

use crate::error::{ApiError, decode_error, network_error};
use crate::server::{Client, with_bearer};

/// The text 04 shows for Better Auth's `NAMESPACE_TAKEN`.
pub const NAMESPACE_TAKEN_MESSAGE: &str = "That name is already taken.";

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Organization {
    pub id: String,
    pub name: String,
    pub slug: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInvitation {
    pub id: String,
    pub organization_name: String,
    pub role: String,
    pub status: String,
}

#[derive(Deserialize)]
struct SessionUser {
    id: String,
}

#[derive(Deserialize)]
struct SessionBody {
    user: SessionUser,
}

#[derive(Serialize)]
struct CreateBody<'a> {
    name: &'a str,
    slug: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InvitationBody<'a> {
    invitation_id: &'a str,
}

#[derive(Deserialize)]
struct AuthError {
    code: Option<String>,
    message: Option<String>,
}

/// A Better Auth refusal as a Tempo error body, so views show it like any other error: 401 keeps
/// its sign-out meaning, 403 is FORBIDDEN, 404 NOT_FOUND, and the rest VALIDATION_FAILED with
/// Better Auth's code as the detail.
fn auth_error(status: u16, bytes: &[u8]) -> ApiError {
    if status == 401 {
        return ApiError::Http { status };
    }
    let body = serde_json::from_slice::<AuthError>(bytes).ok();
    let code = body.as_ref().and_then(|b| b.code.clone());
    let message = if code.as_deref() == Some("NAMESPACE_TAKEN") {
        Some(NAMESPACE_TAKEN_MESSAGE.to_string())
    } else {
        body.and_then(|b| b.message)
    };
    let (code_enum, fallback) = match status {
        403 => (ErrorCode::Forbidden, "You don't have access to this."),
        404 => (ErrorCode::NotFound, "Not found."),
        _ => (ErrorCode::ValidationFailed, "Check the highlighted fields."),
    };
    ApiError::Server {
        status,
        error: ErrorBody {
            code: code_enum,
            message: message.unwrap_or_else(|| fallback.to_string()),
            detail: code,
        },
    }
}

async fn read<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, ApiError> {
    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| ApiError::Network(network_error(e)))?;
    if status == 200 {
        return serde_json::from_slice(&bytes).map_err(|e| ApiError::Decode(decode_error(&e)));
    }
    Err(auth_error(status, &bytes))
}

impl Client {
    fn auth_get<T: DeserializeOwned + Send + 'static>(
        &self,
        endpoint: &str,
    ) -> impl Future<Output = Result<T, ApiError>> + Send + 'static {
        let request = with_bearer(
            self.server().http().get(
                self.server()
                    .url(&["api", "auth", "organization", endpoint]),
            ),
            self.token(),
        );
        self.send(async move {
            let response = request
                .send()
                .await
                .map_err(|e| ApiError::Network(network_error(e)))?;
            read(response).await
        })
    }

    fn auth_post<T: DeserializeOwned + Send + 'static>(
        &self,
        endpoint: &str,
        body: serde_json::Result<Vec<u8>>,
    ) -> impl Future<Output = Result<T, ApiError>> + Send + 'static {
        let request = with_bearer(
            self.server().http().post(self.server().url(&[
                "api",
                "auth",
                "organization",
                endpoint,
            ])),
            self.token(),
        )
        .header(CONTENT_TYPE, "application/json");
        self.send(async move {
            let body = body.map_err(|e| ApiError::Decode(decode_error(&e)))?;
            let response = request
                .body(body)
                .send()
                .await
                .map_err(|e| ApiError::Network(network_error(e)))?;
            read(response).await
        })
    }

    /// The signed-in user's id from `GET /api/auth/get-session`, for author checks (11).
    pub fn session_user_id(
        &self,
    ) -> impl Future<Output = Result<String, ApiError>> + Send + 'static {
        let request = with_bearer(
            self.server()
                .http()
                .get(self.server().url(&["api", "auth", "get-session"])),
            self.token(),
        );
        self.send(async move {
            let response = request
                .send()
                .await
                .map_err(|e| ApiError::Network(network_error(e)))?;
            match read::<Option<SessionBody>>(response).await? {
                Some(session) => Ok(session.user.id),
                None => Err(ApiError::Http { status: 401 }),
            }
        })
    }

    /// `GET /api/auth/organization/list`: the caller's organizations.
    pub fn organizations(
        &self,
    ) -> impl Future<Output = Result<Vec<Organization>, ApiError>> + Send + 'static {
        self.auth_get("list")
    }

    /// `GET /api/auth/organization/list-user-invitations`, pending ones only.
    pub fn user_invitations(
        &self,
    ) -> impl Future<Output = Result<Vec<UserInvitation>, ApiError>> + Send + 'static {
        let request = self.auth_get::<Vec<UserInvitation>>("list-user-invitations");
        async move {
            Ok(request
                .await?
                .into_iter()
                .filter(|i| i.status == "pending")
                .collect())
        }
    }

    /// `POST /api/auth/organization/create`; the caller becomes its owner.
    pub fn create_organization(
        &self,
        name: &str,
        slug: &str,
    ) -> impl Future<Output = Result<Organization, ApiError>> + Send + 'static {
        self.auth_post("create", serde_json::to_vec(&CreateBody { name, slug }))
    }

    /// `POST /api/auth/organization/accept-invitation` or `reject-invitation`.
    pub fn answer_invitation(
        &self,
        invitation_id: &str,
        accept: bool,
    ) -> impl Future<Output = Result<(), ApiError>> + Send + 'static {
        let endpoint = if accept {
            "accept-invitation"
        } else {
            "reject-invitation"
        };
        let request = self.auth_post::<serde_json::Value>(
            endpoint,
            serde_json::to_vec(&InvitationBody { invitation_id }),
        );
        async move { request.await.map(|_| ()) }
    }
}

/// The slug suggested for a name, as on the web (04): lower case, other characters as `-`, at
/// most 39 characters.
pub fn slug_from_name(name: &str) -> String {
    let mut slug = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let mut slug: String = slug.trim_end_matches('-').chars().take(39).collect();
    while slug.ends_with('-') {
        slug.pop();
    }
    slug
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_matches_the_web_rule() {
        assert_eq!(slug_from_name("Acme Labs!"), "acme-labs");
        assert_eq!(slug_from_name("  --Ünïcode  Team--"), "n-code-team");
        assert_eq!(slug_from_name(&"a".repeat(50)), "a".repeat(39));
        assert_eq!(
            slug_from_name(&format!("{}-b", "a".repeat(38))),
            "a".repeat(38)
        );
    }

    #[test]
    fn better_auth_errors_become_error_bodies() {
        let taken = auth_error(400, br#"{"code":"NAMESPACE_TAKEN","message":"x"}"#);
        assert_eq!(taken.code(), Some(ErrorCode::ValidationFailed));
        assert_eq!(taken.to_string(), NAMESPACE_TAKEN_MESSAGE);
        let forbidden = auth_error(403, b"not json");
        assert_eq!(forbidden.code(), Some(ErrorCode::Forbidden));
        assert!(auth_error(401, b"{}").is_unauthorized());
    }
}
