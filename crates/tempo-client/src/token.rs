use std::fmt;

/// A Better Auth session token (07, Sign-in). Its `Debug` never shows the value, and it has no
/// `Display`, so it cannot reach a log line or an error message by accident.
#[derive(Clone, PartialEq, Eq)]
pub struct Token(String);

impl Token {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The raw value, for the Keychain and the `Authorization` header only.
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub(crate) fn bearer(&self) -> String {
        format!("Bearer {}", self.0)
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token(<redacted>)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_hides_the_value() {
        let t = Token::new("s3cr3t-session-token");
        assert_eq!(format!("{t:?}"), "Token(<redacted>)");
        assert!(!format!("{:?}", Some(&t)).contains("s3cr3t"));
    }
}
