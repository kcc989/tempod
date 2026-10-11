use serde_json::Value;

/// `REDACTED` in `packages/protocol/src/redact.ts`.
pub const REDACTED: &str = "[redacted]";
pub const TRUNCATED: &str = "[truncated]";

/// The words of `SECRET_FIELD`, `/token|key|secret|password|authorization|auth_json|cookie/i`.
const SECRET_WORDS: [&str; 7] = [
    "token",
    "key",
    "secret",
    "password",
    "authorization",
    "auth_json",
    "cookie",
];

/// `SECRET_FIELD.test(name)`. A JS `/i` regex without the `u` flag folds ASCII letters only.
pub fn is_secret_field(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    SECRET_WORDS.iter().any(|w| lower.contains(w))
}

/// `redact` from `redact.ts` (05, Secrets): every field whose name matches is replaced, through
/// objects and arrays; below depth 8 an object or array becomes `[truncated]`.
pub fn redact(value: Value) -> Value {
    redact_at(value, 0)
}

fn redact_at(value: Value, depth: usize) -> Value {
    match value {
        Value::Array(_) | Value::Object(_) if depth > 8 => Value::String(TRUNCATED.into()),
        Value::Array(items) => {
            Value::Array(items.into_iter().map(|v| redact_at(v, depth + 1)).collect())
        }
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .map(|(k, v)| {
                    let v = if is_secret_field(&k) {
                        Value::String(REDACTED.into())
                    } else {
                        redact_at(v, depth + 1)
                    };
                    (k, v)
                })
                .collect(),
        ),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn each_keyword_is_redacted() {
        for name in [
            "token",
            "key",
            "secret",
            "password",
            "authorization",
            "auth_json",
            "cookie",
        ] {
            let out = redact(json!({ name: "s3cr3t", "keep": "ok" }));
            assert_eq!(out, json!({ name: REDACTED, "keep": "ok" }), "{name}");
        }
    }

    #[test]
    fn names_match_anywhere_and_in_any_case() {
        for name in [
            "accessToken",
            "API_KEY",
            "clientSecret",
            "PassWord",
            "Authorization",
            "codex_AUTH_JSON",
            "Set-Cookie",
            "monkey",
        ] {
            assert!(is_secret_field(name), "{name}");
        }
        for name in [
            "workspaceId",
            "auth",
            "authJson",
            "pass",
            "msg",
            "target",
            "ke_y",
        ] {
            assert!(!is_secret_field(name), "{name}");
        }
    }

    #[test]
    fn non_ascii_letters_do_not_fold() {
        assert!(!is_secret_field("\u{212A}ey"));
        assert!(!is_secret_field("\u{17F}ecret"));
    }

    #[test]
    fn nested_objects_and_arrays_are_redacted() {
        let out = redact(json!({
            "workspaceId": "w1",
            "headers": {"Authorization": "Bearer t", "accept": "json"},
            "logins": [{"provider": "claude", "token": "t1"}, ["x", {"apiKey": "k"}]],
            "secrets": {"a": 1},
        }));
        assert_eq!(
            out,
            json!({
                "workspaceId": "w1",
                "headers": {"Authorization": REDACTED, "accept": "json"},
                "logins": [{"provider": "claude", "token": REDACTED}, ["x", {"apiKey": REDACTED}]],
                "secrets": REDACTED,
            })
        );
    }

    #[test]
    fn values_are_not_inspected_only_names() {
        let out = redact(json!({"note": "token=abc", "list": ["password"]}));
        assert_eq!(out, json!({"note": "token=abc", "list": ["password"]}));
    }

    #[test]
    fn deep_values_are_truncated_like_redact_ts() {
        let mut v = json!({"leaf": 1});
        for _ in 0..9 {
            v = json!({ "n": v });
        }
        let mut out = redact(v);
        for _ in 0..9 {
            out = out["n"].take();
        }
        assert_eq!(out, json!(TRUNCATED));

        let mut shallow = json!("leaf");
        for _ in 0..9 {
            shallow = json!({ "n": shallow });
        }
        let mut out = redact(shallow);
        for _ in 0..9 {
            out = out["n"].take();
        }
        assert_eq!(out, json!("leaf"));
    }

    #[test]
    fn primitives_pass_through() {
        assert_eq!(redact(json!("token")), json!("token"));
        assert_eq!(redact(json!(null)), json!(null));
        assert_eq!(redact(json!(3)), json!(3));
    }
}
