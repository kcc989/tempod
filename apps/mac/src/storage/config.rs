use serde::{Deserialize, Serialize};

/// Settings → Appearance (04): system, light or dark.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

/// Settings → Appearance → Transcript detail (04, Center: Detail).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptDetail {
    #[default]
    Default,
    Detailed,
}

/// `config.toml` (07, Local storage): the Tempo URL, the theme, transcript detail, and
/// notifications and sound on or off. Keys the app does not know are ignored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub theme: Theme,
    pub transcript_detail: TranscriptDetail,
    pub notifications: bool,
    pub sound: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            url: None,
            theme: Theme::System,
            transcript_detail: TranscriptDetail::Default,
            notifications: false,
            sound: true,
        }
    }
}

impl Config {
    pub fn parse(text: &str) -> Result<Self, toml::de::Error> {
        toml::from_str(text)
    }

    pub fn to_toml(&self) -> String {
        toml::to_string(self).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::file::{LoadOutcome, load_or_recover, tests::temp_dir, write_atomic};

    #[test]
    fn defaults() {
        let c = Config::default();
        assert_eq!(c.url, None);
        assert_eq!(c.theme, Theme::System);
        assert_eq!(c.transcript_detail, TranscriptDetail::Default);
        assert!(!c.notifications);
        assert!(c.sound);
        assert_eq!(Config::parse("").unwrap(), c);
    }

    #[test]
    fn writes_the_five_flat_keys() {
        let c = Config {
            url: Some("https://tempo.example.com".into()),
            theme: Theme::Dark,
            transcript_detail: TranscriptDetail::Detailed,
            notifications: true,
            sound: false,
        };
        assert_eq!(
            c.to_toml(),
            "url = \"https://tempo.example.com\"\ntheme = \"dark\"\ntranscript_detail = \"detailed\"\nnotifications = true\nsound = false\n"
        );
        assert!(
            Config::default()
                .to_toml()
                .contains("transcript_detail = \"default\"\n")
        );
        assert!(!Config::default().to_toml().contains("url"));
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = temp_dir("config");
        let path = dir.join("config.toml");
        let c = Config {
            url: Some("https://t.example.com/\"quoted\"".into()),
            theme: Theme::Light,
            transcript_detail: TranscriptDetail::Detailed,
            notifications: true,
            sound: true,
        };
        write_atomic(&path, c.to_toml().as_bytes()).unwrap();
        let loaded = load_or_recover(&path, Config::parse);
        assert_eq!(loaded.outcome, LoadOutcome::Loaded);
        assert_eq!(loaded.value, c);
    }

    #[test]
    fn missing_keys_take_defaults_and_unknown_keys_are_ignored() {
        let c = Config::parse("# hand edited\ntheme = 'light'\nlater = 1\n").unwrap();
        assert_eq!(
            c,
            Config {
                theme: Theme::Light,
                ..Config::default()
            }
        );
    }

    #[test]
    fn transcript_detail_parses_both_values() {
        assert_eq!(
            Config::parse("transcript_detail = \"detailed\"")
                .unwrap()
                .transcript_detail,
            TranscriptDetail::Detailed
        );
        assert_eq!(
            Config::parse("transcript_detail = \"default\"")
                .unwrap()
                .transcript_detail,
            TranscriptDetail::Default
        );
    }

    #[test]
    fn a_wrong_value_does_not_parse() {
        assert!(Config::parse("theme = \"blue\"").is_err());
        assert!(Config::parse("transcript_detail = \"compact\"").is_err());
        assert!(Config::parse("notifications = \"yes\"").is_err());
        assert!(Config::parse("url = ").is_err());
    }

    #[test]
    fn a_config_that_does_not_parse_becomes_dot_bad() {
        let dir = temp_dir("config-bad");
        let path = dir.join("config.toml");
        std::fs::write(&path, "theme = [").unwrap();
        let loaded = load_or_recover(&path, Config::parse);
        assert_eq!(loaded.value, Config::default());
        assert_eq!(loaded.outcome, LoadOutcome::Bad { renamed: true });
        assert!(dir.join("config.toml.bad").exists());
    }
}
