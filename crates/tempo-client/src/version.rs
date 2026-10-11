use std::cmp::Ordering;

use tempo_protocol::ApiMeta;

/// `x.y.z`, digits only (the form of `minMacClient`, `latestMacClient` and the app version).
pub fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let mut parts = s.trim().split('.');
    let mut next = || -> Option<u64> {
        let p = parts.next()?;
        if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        p.parse().ok()
    };
    let v = (next()?, next()?, next()?);
    parts.next().is_none().then_some(v)
}

pub fn compare_versions(a: &str, b: &str) -> Option<Ordering> {
    Some(parse_version(a)?.cmp(&parse_version(b)?))
}

/// 07 Updates: `latestMacClient` when it is newer than the app.
pub fn newer_version_available<'a>(meta: &'a ApiMeta, app_version: &str) -> Option<&'a str> {
    let latest = meta.latest_mac_client.as_deref()?;
    (compare_versions(latest, app_version)? == Ordering::Greater).then_some(latest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_numerically() {
        assert_eq!(parse_version("0.10.2"), Some((0, 10, 2)));
        assert_eq!(compare_versions("0.9.0", "0.10.0"), Some(Ordering::Less));
        assert_eq!(compare_versions("1.0.0", "1.0.0"), Some(Ordering::Equal));
        for bad in ["", "1", "1.2", "1.2.3.4", "1.2.x", "v1.2.3", "1..2"] {
            assert_eq!(parse_version(bad), None, "{bad}");
        }
    }
}
