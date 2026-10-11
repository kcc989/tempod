use std::sync::Arc;

use rustls::ClientConfig;
use rustls_platform_verifier::BuilderVerifierExt;

/// rustls on `ring`, verifying with the platform's trust store (the Keychain on macOS). `alpn`
/// is set per use: `http/1.1` for reqwest, none for WebSocket upgrades.
pub(crate) fn client_config(alpn: &[&[u8]]) -> Result<ClientConfig, rustls::Error> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .with_platform_verifier()?
        .with_no_client_auth();
    config.alpn_protocols = alpn.iter().map(|p| p.to_vec()).collect();
    Ok(config)
}
