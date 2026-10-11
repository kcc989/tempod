use tempo_protocol as p;

#[derive(Clone, Debug, PartialEq)]
pub struct SlashEntry {
    pub name: String,
    pub description: String,
    pub plan: bool,
}

pub fn slash_query(text: &str, caret: usize) -> Option<&str> {
    let query = text.get(..caret)?.strip_prefix('/')?;
    (!query.chars().any(|c| c.is_whitespace() || c == '/')).then_some(query)
}

fn fuzzy_score(query: &str, target: &str) -> Option<f64> {
    let chars: Vec<_> = target.to_lowercase().chars().collect();
    let mut offset = 0;
    let mut previous = None;
    let mut score = 0.;
    for ch in query.to_lowercase().chars().filter(|c| !c.is_whitespace()) {
        let found = offset + chars.get(offset..)?.iter().position(|c| *c == ch)?;
        score += 3.;
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
