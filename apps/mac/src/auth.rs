use crate::platform::TokenStore;
use tempo_client::{Client, Server, SignInError, Token};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AuthState {
    Connect {
        url: Option<String>,
        error: Option<String>,
    },
    Connecting,
    ClearingSession,
    AwaitingApproval {
        user_code: String,
        verification_uri_complete: String,
    },
    SignedIn,
    UpdateRequired,
}

pub struct Session {
    pub client: Client,
    server: Server,
    token: Token,
}

impl Session {
    pub fn new(server: Server, token: Token) -> Self {
        Self {
            client: server.client(token.clone()),
            server,
            token,
        }
    }

    pub fn sign_out(&self) -> impl Future<Output = Result<(), SignInError>> + Send + 'static {
        self.server.sign_out(&self.token)
    }

    pub fn validate(
        &self,
    ) -> std::pin::Pin<
        Box<dyn Future<Output = Result<tempo_client::TokenStatus, SignInError>> + Send + 'static>,
    > {
        Box::pin(self.server.get_session(&self.token))
    }
    pub fn meta(
        &self,
    ) -> std::pin::Pin<
        Box<
            dyn Future<Output = Result<tempo_protocol::ApiMeta, tempo_client::ApiError>>
                + Send
                + 'static,
        >,
    > {
        Box::pin(self.server.meta())
    }
    pub fn host(&self) -> &str {
        self.server.host()
    }
    pub fn forget(&self, tokens: &dyn TokenStore) {
        self.client.close_channels();
        tokens.delete(self.server.host());
    }
}

pub fn error_state(url: Option<String>, error: &SignInError) -> AuthState {
    if matches!(error, SignInError::UpdateRequired { .. }) {
        AuthState::UpdateRequired
    } else {
        let message = match error {
            SignInError::NotTempo => tempo_client::NOT_TEMPO_MESSAGE,
            SignInError::Denied => tempo_client::DENIED_MESSAGE,
            _ => "Could not sign in. Try again.",
        };
        AuthState::Connect {
            url,
            error: Some(message.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::MemoryTokenStore;

    #[test]
    fn errors_show_spec_copy_and_never_payloads() {
        let url = Some("https://tempo.test".into());
        for (error, message) in [
            (SignInError::NotTempo, tempo_client::NOT_TEMPO_MESSAGE),
            (SignInError::Denied, tempo_client::DENIED_MESSAGE),
            (
                SignInError::Network("secret response".into()),
                "Could not sign in. Try again.",
            ),
        ] {
            assert_eq!(
                error_state(url.clone(), &error),
                AuthState::Connect {
                    url: url.clone(),
                    error: Some(message.into())
                }
            );
        }
        assert_eq!(
            error_state(
                url,
                &SignInError::UpdateRequired {
                    min_mac_client: "9.0.0".into(),
                    latest_mac_client: None
                }
            ),
            AuthState::UpdateRequired
        );
    }

    #[test]
    fn sign_out_forgets_the_same_host_used_to_save_the_token() {
        let runtime = tempo_client::Runtime::start().unwrap();
        let server = Server::new(
            &runtime.handle(),
            "https://tempo.test:8443/path",
            crate::VERSION,
        )
        .unwrap();
        let tokens = MemoryTokenStore::default();
        tokens.set(server.host(), "secret").unwrap();
        let session = Session::new(server, Token::new("secret"));
        session.forget(&tokens);
        assert!(tokens.get("tempo.test").is_none());
    }
}
