use tempo_protocol as p;

#[derive(Clone, Debug, PartialEq)]
pub struct SlashEntry {
    pub name: String,
    pub description: String,
    pub plan: bool,
}

/// The draft review comments chip (04, Composer), as the web `reviewChipLabel`.
pub fn review_chip_label(n: usize) -> String {
    if n == 1 {
        "1 review comment".into()
    } else {
        format!("{n} review comments")
    }
}

/// The intent check toggle's label and tooltip (04, Composer), as the web `IntentCheckToggle`.
pub fn intent_check_text(on: bool) -> (&'static str, &'static str) {
    if on {
        (
            "Intent check: On",
            "The agent states its plan first; risky plans wait for you. Click to turn off for this chat.",
        )
    } else {
        (
            "Intent check: Off",
            "The agent starts work at once. Click to turn on for this chat.",
        )
    }
}

pub fn slash_query(text: &str, caret: usize) -> Option<&str> {
    let query = text.get(..caret)?.strip_prefix('/')?;
    (!query.chars().any(|c| c.is_whitespace() || c == '/')).then_some(query)
}

pub fn mention_query(text: &str, caret: usize) -> Option<(usize, &str)> {
    let before = text.get(..caret)?;
    let start = before.rfind('@')?;
    if start > 0 && !before[..start].chars().next_back()?.is_whitespace() {
        return None;
    }
    let query = &before[start + 1..];
    (!query.chars().any(|c| c.is_whitespace() || c == '@')).then_some((start, query))
}

pub fn file_matches(paths: &[String], query: &str) -> Vec<String> {
    let mut rows: Vec<_> = paths
        .iter()
        .filter_map(|path| {
            Some((
                path,
                if query.is_empty() {
                    0.
                } else {
                    fuzzy_score(query, path)?
                },
            ))
        })
        .collect();
    rows.sort_by(|a, b| b.1.total_cmp(&a.1));
    rows.into_iter()
        .take(30)
        .map(|(path, _)| path.clone())
        .collect()
}

fn fuzzy_score(query: &str, target: &str) -> Option<f64> {
    let chars: Vec<_> = target.to_lowercase().chars().collect();
    let name_start = chars.iter().rposition(|c| *c == '/').map_or(0, |at| at + 1);
    let mut offset = 0;
    let mut previous = None;
    let mut score = 0.;
    for ch in query.to_lowercase().chars().filter(|c| !c.is_whitespace()) {
        let found = offset + chars.get(offset..)?.iter().position(|c| *c == ch)?;
        score += 1.;
        if found >= name_start {
            score += 2.;
        }
        if previous.is_some_and(|p| p + 1 == found) {
            score += 4.;
        }
        if found == 0 || matches!(chars[found - 1], '/' | '-' | '_' | '.' | ' ') {
            score += 3.;
        }
        previous = Some(found);
        offset = found + 1;
    }
    Some(score - chars.len() as f64 * 0.01)
}

pub fn slash_entries(commands: &[p::AvailableCommand], plan: bool, query: &str) -> Vec<SlashEntry> {
    let all = plan
        .then(|| SlashEntry {
            name: "plan".into(),
            description: "Toggle plan mode".into(),
            plan: true,
        })
        .into_iter()
        .chain(commands.iter().map(|c| SlashEntry {
            name: c.name.clone(),
            description: c.description.clone().unwrap_or_default(),
            plan: false,
        }));
    let mut rows: Vec<_> = all
        .filter_map(|entry| {
            let score = if query.is_empty() {
                0.
            } else {
                fuzzy_score(query, &entry.name)?
            };
            Some((entry, score))
        })
        .collect();
    rows.sort_by(|a, b| b.1.total_cmp(&a.1));
    rows.into_iter().take(50).map(|(entry, _)| entry).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn review_chip_matches_the_web_copy() {
        assert_eq!(review_chip_label(1), "1 review comment");
        assert_eq!(review_chip_label(3), "3 review comments");
    }
    #[test]
    fn intent_check_text_matches_the_web_copy() {
        assert_eq!(
            intent_check_text(true),
            (
                "Intent check: On",
                "The agent states its plan first; risky plans wait for you. Click to turn off for this chat."
            )
        );
        assert_eq!(
            intent_check_text(false),
            (
                "Intent check: Off",
                "The agent starts work at once. Click to turn on for this chat."
            )
        );
    }
    #[test]
    fn mentions_follow_whitespace_and_utf8_boundaries() {
        assert_eq!(mention_query("Ask é @src later", 11), Some((7, "src")));
        for text in ["a@src", "@@src", "@src "] {
            assert!(mention_query(text, text.len()).is_none());
        }
        assert!(mention_query("é @src", 1).is_none());
        assert_eq!(mention_query("@", 1), Some((0, "")));
    }
    #[test]
    fn file_matching_prefers_file_names_and_limits_results() {
        let paths = vec![
            "src/main.rs".into(),
            "lib/src.md".into(),
            "unrelated.txt".into(),
        ];
        assert_eq!(file_matches(&paths, "sr")[0], "lib/src.md");
        assert_eq!(file_matches(&paths, "mnrs"), vec!["src/main.rs"]);
        assert!(file_matches(&paths, "xyz").is_empty());
        assert_eq!(
            file_matches(
                &(0..100).map(|n| format!("file{n}")).collect::<Vec<_>>(),
                ""
            )
            .len(),
            30
        );
    }
    #[test]
    fn slash_trigger_respects_caret_whitespace_and_utf8() {
        assert_eq!(slash_query("/pl later", 3), Some("pl"));
        for (text, caret) in [("hi /pl", 6), ("/pl ", 4), ("//", 2), ("/é", 2)] {
            assert_eq!(slash_query(text, caret), None);
        }
        assert_eq!(slash_query("/é", 3), Some("é"));
    }
    #[test]
    fn commands_keep_agent_identity_and_plan_is_capability_gated() {
        let commands = vec![
            p::AvailableCommand {
                name: "plan".into(),
                description: Some("Agent plan".into()),
                input: None,
            },
            p::AvailableCommand {
                name: "compact".into(),
                description: None,
                input: None,
            },
        ];
        let rows = slash_entries(&commands, true, "pl");
        assert_eq!(rows.len(), 2);
        assert!(rows[0].plan);
        assert!(!rows[1].plan);
        assert_eq!(slash_entries(&commands, false, "cpt")[0].name, "compact");
        assert!(slash_entries(&commands, false, "unknown").is_empty());
    }
}
