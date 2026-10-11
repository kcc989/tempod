//! Updates (07, Build, signing, distribution and updates): on launch and every 24 h, compare the
//! app with `minMacClient` and `latestMacClient` from `GET /api/v1/meta`; Download fetches
//! `GET /downloads/mac/<version>`, checks its SHA-256 and saves `~/Downloads/Tempo-<version>.dmg`.
//!
//! `ApiMeta` has no hash yet (IMPLEMENTATION_NOTES MQ-1), so the expected SHA-256 is a parameter.
use sha2::{Digest as _, Sha256};
use std::cmp::Ordering;
use std::fmt;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::{Duration, SystemTime};

pub const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
pub const DOWNLOAD_LABEL: &str = "Download";

/// A SemVer 2.0.0 version. Build metadata is kept for display but ignored when comparing.
#[derive(Clone, Debug)]
pub struct Version {
    major: u64,
    minor: u64,
    patch: u64,
    pre: Vec<Ident>,
    build: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Ident {
    Num(u64),
    Alpha(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VersionError(pub String);

impl fmt::Display for VersionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "not a version: {:?}", self.0)
    }
}

impl std::error::Error for VersionError {}

fn numeric(part: &str) -> Option<u64> {
    let ok = !part.is_empty()
        && part.bytes().all(|b| b.is_ascii_digit())
        && (part == "0" || !part.starts_with('0'));
    ok.then(|| part.parse().ok()).flatten()
}

fn ident_ok(part: &str) -> bool {
    !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

impl FromStr for Version {
    type Err = VersionError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let err = || VersionError(text.to_string());
        let (rest, build) = match text.split_once('+') {
            Some((rest, build)) => {
                if !build.split('.').all(ident_ok) {
                    return Err(err());
                }
                (rest, Some(build.to_string()))
            }
            None => (text, None),
        };
        let (core, pre) = match rest.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (rest, None),
        };
        let mut nums = core.split('.').map(numeric);
        let (Some(Some(major)), Some(Some(minor)), Some(Some(patch)), None) =
            (nums.next(), nums.next(), nums.next(), nums.next())
        else {
            return Err(err());
        };
        let pre = match pre {
            None => Vec::new(),
            Some(pre) => pre
                .split('.')
                .map(|p| {
                    if !ident_ok(p) {
                        None
                    } else if p.bytes().all(|b| b.is_ascii_digit()) {
                        numeric(p).map(Ident::Num)
                    } else {
                        Some(Ident::Alpha(p.to_string()))
                    }
                })
                .collect::<Option<Vec<_>>>()
                .ok_or_else(err)?,
        };
        Ok(Self {
            major,
            minor,
            patch,
            pre,
            build,
        })
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        for (i, p) in self.pre.iter().enumerate() {
            f.write_str(if i == 0 { "-" } else { "." })?;
            match p {
                Ident::Num(n) => write!(f, "{n}")?,
                Ident::Alpha(s) => f.write_str(s)?,
            }
        }
        if let Some(build) = &self.build {
            write!(f, "+{build}")?;
        }
        Ok(())
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(|| match (self.pre.is_empty(), other.pre.is_empty()) {
                (true, true) => Ordering::Equal,
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (false, false) => {
                    for (a, b) in self.pre.iter().zip(&other.pre) {
                        let o = match (a, b) {
                            (Ident::Num(a), Ident::Num(b)) => a.cmp(b),
                            (Ident::Num(_), Ident::Alpha(_)) => Ordering::Less,
                            (Ident::Alpha(_), Ident::Num(_)) => Ordering::Greater,
                            (Ident::Alpha(a), Ident::Alpha(b)) => a.cmp(b),
                        };
                        if o != Ordering::Equal {
                            return o;
                        }
                    }
                    self.pre.len().cmp(&other.pre.len())
                }
            })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for Version {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Version {}

/// What the app shows after reading `meta`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UpdateCheck {
    UpToDate,
    /// `Tempo <version> is available.` with **Download**.
    Available(Version),
    /// The app is older than `minMacClient`: it shows only the update screen. `latest` is the
    /// version Download fetches, when the server has one newer than the app.
    Required {
        min: Version,
        latest: Option<Version>,
    },
}

pub fn check(
    current: &str,
    min_mac_client: &str,
    latest_mac_client: Option<&str>,
) -> Result<UpdateCheck, VersionError> {
    let current: Version = current.parse()?;
    let min: Version = min_mac_client.parse()?;
    let latest = latest_mac_client
        .map(str::parse::<Version>)
        .transpose()?
        .filter(|l| *l > current);
    Ok(if current < min {
        UpdateCheck::Required { min, latest }
    } else if let Some(latest) = latest {
        UpdateCheck::Available(latest)
    } else {
        UpdateCheck::UpToDate
    })
}

/// [`check`] for this build.
pub fn check_this_app(
    min_mac_client: &str,
    latest_mac_client: Option<&str>,
) -> Result<UpdateCheck, VersionError> {
    check(crate::VERSION, min_mac_client, latest_mac_client)
}

/// The update check runs on launch and every 24 h. Wall-clock time, so time asleep counts.
#[derive(Clone, Copy, Debug, Default)]
pub struct Schedule {
    last: Option<SystemTime>,
}

impl Schedule {
    pub fn is_due(&self, now: SystemTime) -> bool {
        match self.last {
            None => true,
            Some(last) => now
                .duration_since(last)
                .map_or(true, |elapsed| elapsed >= CHECK_INTERVAL),
        }
    }

    pub fn checked(&mut self, now: SystemTime) {
        self.last = Some(now);
    }

    /// How long to wait before the next check.
    pub fn wait(&self, now: SystemTime) -> Duration {
        match self.last {
            Some(last) if !self.is_due(now) => {
                CHECK_INTERVAL.saturating_sub(now.duration_since(last).unwrap_or_default())
            }
            _ => Duration::ZERO,
        }
    }
}

pub fn available_text(version: &Version) -> String {
    format!("Tempo {version} is available.")
}

/// `GET /downloads/mac/<version>` on the Tempo at `server_url`.
pub fn download_url(server_url: &str, version: &Version) -> String {
    format!(
        "{}/downloads/mac/{version}",
        server_url.trim_end_matches('/')
    )
}

pub fn dmg_file_name(version: &Version) -> String {
    format!("Tempo-{version}.dmg")
}

pub fn downloads_dir() -> Option<PathBuf> {
    Some(crate::storage::home()?.join("Downloads"))
}

pub fn dmg_path(downloads: &Path, version: &Version) -> PathBuf {
    downloads.join(dmg_file_name(version))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[derive(Debug)]
pub enum DownloadError {
    /// The expected hash is not 64 hex digits.
    BadExpectedHash,
    HashMismatch,
    Write(std::io::Error),
}

impl fmt::Display for DownloadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadExpectedHash => f.write_str("the expected SHA-256 is not valid"),
            Self::HashMismatch => f.write_str("the download does not match its SHA-256"),
            Self::Write(e) => write!(f, "the download could not be saved: {}", e.kind()),
        }
    }
}

impl std::error::Error for DownloadError {}

pub fn verify_sha256(bytes: &[u8], expected_hex: &str) -> Result<(), DownloadError> {
    let expected = expected_hex.trim();
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(DownloadError::BadExpectedHash);
    }
    if sha256_hex(bytes).eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(DownloadError::HashMismatch)
    }
}

/// Checks the bytes, then writes `<downloads>/Tempo-<version>.dmg` atomically. Run it off the
/// main thread; the caller then opens the file in Finder.
pub fn save_dmg(
    downloads: &Path,
    version: &Version,
    bytes: &[u8],
    expected_sha256: &str,
) -> Result<PathBuf, DownloadError> {
    verify_sha256(bytes, expected_sha256)?;
    let path = dmg_path(downloads, version);
    crate::storage::write_atomic(&path, bytes).map_err(DownloadError::Write)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        s.parse().unwrap()
    }

    #[test]
    fn parses_semver() {
        assert_eq!(v("1.2.3").to_string(), "1.2.3");
        assert_eq!(
            v("0.1.0-beta.2+build.7").to_string(),
            "0.1.0-beta.2+build.7"
        );
        for bad in [
            "",
            "1",
            "1.2",
            "1.2.3.4",
            "01.2.3",
            "1.02.3",
            "1.2.3-",
            "1.2.3-01",
            "1.2.3-a..b",
            "1.2.3+",
            "v1.2.3",
            "1.2.3 ",
            "1.2.x",
            "1.2.3-ä",
        ] {
            assert!(bad.parse::<Version>().is_err(), "{bad:?}");
        }
    }

    #[test]
    fn compares_by_semver_precedence() {
        let ordered = [
            "1.0.0-alpha",
            "1.0.0-alpha.1",
            "1.0.0-alpha.beta",
            "1.0.0-beta",
            "1.0.0-beta.2",
            "1.0.0-beta.11",
            "1.0.0-rc.1",
            "1.0.0",
            "1.0.1",
            "1.1.0",
            "1.10.0",
            "2.0.0",
        ];
        for pair in ordered.windows(2) {
            assert!(v(pair[0]) < v(pair[1]), "{} < {}", pair[0], pair[1]);
        }
        assert_eq!(v("1.0.0+a"), v("1.0.0+b"));
        assert!(v("0.10.0") > v("0.9.9"));
    }

    #[test]
    fn check_reports_required_available_or_up_to_date() {
        assert_eq!(
            check("0.1.0", "0.1.0", Some("0.1.0")).unwrap(),
            UpdateCheck::UpToDate
        );
        assert_eq!(
            check("0.1.0", "0.0.1", None).unwrap(),
            UpdateCheck::UpToDate
        );
        assert_eq!(
            check("0.1.0", "0.1.0", Some("0.2.0")).unwrap(),
            UpdateCheck::Available(v("0.2.0"))
        );
        assert_eq!(
            check("0.2.0", "0.1.0", Some("0.1.5")).unwrap(),
            UpdateCheck::UpToDate
        );
        assert_eq!(
            check("0.1.0", "0.3.0", Some("0.3.1")).unwrap(),
            UpdateCheck::Required {
                min: v("0.3.0"),
                latest: Some(v("0.3.1"))
            }
        );
        assert_eq!(
            check("0.1.0", "0.3.0", None).unwrap(),
            UpdateCheck::Required {
                min: v("0.3.0"),
                latest: None
            }
        );
        assert!(check("0.1.0", "next", None).is_err());
        assert!(check("0.1.0", "0.1.0", Some("")).is_err());
    }

    #[test]
    fn this_app_version_parses() {
        assert!(crate::VERSION.parse::<Version>().is_ok());
        assert_eq!(
            check_this_app(crate::VERSION, None).unwrap(),
            UpdateCheck::UpToDate
        );
    }

    #[test]
    fn checks_on_launch_and_every_24_hours() {
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_760_000_000);
        let mut s = Schedule::default();
        assert!(s.is_due(t0));
        assert_eq!(s.wait(t0), Duration::ZERO);
        s.checked(t0);
        assert!(!s.is_due(t0 + Duration::from_secs(3600)));
        assert_eq!(
            s.wait(t0 + Duration::from_secs(3600)),
            CHECK_INTERVAL - Duration::from_secs(3600)
        );
        assert!(!s.is_due(t0 + CHECK_INTERVAL - Duration::from_secs(1)));
        assert!(s.is_due(t0 + CHECK_INTERVAL));
        assert!(s.is_due(t0 - Duration::from_secs(1)));
    }

    #[test]
    fn copy_url_and_path() {
        let ver = v("0.4.0");
        assert_eq!(available_text(&ver), "Tempo 0.4.0 is available.");
        assert_eq!(
            download_url("https://tempo.example.com/", &ver),
            "https://tempo.example.com/downloads/mac/0.4.0"
        );
        assert_eq!(
            dmg_path(Path::new("/Users/me/Downloads"), &ver),
            Path::new("/Users/me/Downloads/Tempo-0.4.0.dmg")
        );
    }

    #[test]
    fn sha256_matches_known_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn verify_accepts_the_right_hash_in_any_case_and_refuses_others() {
        let good = "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD";
        assert!(verify_sha256(b"abc", good).is_ok());
        assert!(matches!(
            verify_sha256(b"abd", good),
            Err(DownloadError::HashMismatch)
        ));
        assert!(matches!(
            verify_sha256(b"abc", "ba7816"),
            Err(DownloadError::BadExpectedHash)
        ));
        assert!(matches!(
            verify_sha256(b"abc", &"z".repeat(64)),
            Err(DownloadError::BadExpectedHash)
        ));
    }

    #[test]
    fn save_dmg_writes_only_verified_bytes() {
        let dir = std::env::temp_dir().join(format!("tempo-mac-update-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let ver = v("0.4.0");
        let hash = sha256_hex(b"dmg bytes");
        assert!(save_dmg(&dir, &ver, b"tampered", &hash).is_err());
        assert!(!dmg_path(&dir, &ver).exists());
        let path = save_dmg(&dir, &ver, b"dmg bytes", &hash).unwrap();
        assert_eq!(path, dir.join("Tempo-0.4.0.dmg"));
        assert_eq!(std::fs::read(path).unwrap(), b"dmg bytes");
    }
}
