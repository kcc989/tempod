//! The owner's model list (01, Model list; 04, Settings → Models). Pure, so it is unit-tested.
use tempo_protocol::{AgentId, AgentModelOptions, ModelPick};

/// `(agent, model value, model name)` for one picker entry.
pub type Offered = (AgentId, String, String);

fn reported(models: &[AgentModelOptions]) -> Vec<Offered> {
    models
        .iter()
        .flat_map(|entry| {
            entry
                .options
                .iter()
                .map(|o| (entry.agent, o.value.clone(), o.name.clone()))
        })
        .collect()
}

/// The picks that are reported, in list order; every reported model when none is.
pub fn offered_models(models: &[AgentModelOptions], picks: &[ModelPick]) -> Vec<Offered> {
    let all = reported(models);
    let offered: Vec<Offered> = picks
        .iter()
        .filter_map(|pick| {
            all.iter()
                .find(|(agent, value, _)| *agent == pick.agent && *value == pick.model)
                .cloned()
        })
        .collect();
    if offered.is_empty() { all } else { offered }
}

/// The preferred agent, else the first offered; then its current model, else its first offered.
pub fn initial_model(
    models: &[AgentModelOptions],
    picks: &[ModelPick],
    preferred: Option<AgentId>,
) -> Option<(AgentId, String)> {
    let offered = offered_models(models, picks);
    let agent = offered
        .iter()
        .map(|o| o.0)
        .find(|a| Some(*a) == preferred)
        .or_else(|| offered.first().map(|o| o.0))?;
    let current = models
        .iter()
        .find(|m| m.agent == agent)
        .map(|m| m.current_value.as_str());
    offered
        .iter()
        .find(|o| o.0 == agent && Some(o.1.as_str()) == current)
        .or_else(|| offered.iter().find(|o| o.0 == agent))
        .map(|o| (o.0, o.1.clone()))
}

/// Checking appends to the end of the list; unchecking removes the pick.
pub fn toggle_pick(picks: &[ModelPick], agent: AgentId, model: &str) -> Vec<ModelPick> {
    if picks.iter().any(|p| p.agent == agent && p.model == model) {
        picks
            .iter()
            .filter(|p| !(p.agent == agent && p.model == model))
            .cloned()
            .collect()
    } else {
        let mut next = picks.to_vec();
        next.push(ModelPick {
            agent,
            model: model.to_string(),
        });
        next
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ModelRow {
    pub model: String,
    pub name: String,
    pub reported: bool,
    pub picked: bool,
}

/// One column per agent with a login: reported models, then picks the agent no longer reports.
pub fn model_columns(
    available: &[AgentId],
    models: &[AgentModelOptions],
    picks: &[ModelPick],
) -> Vec<(AgentId, Vec<ModelRow>)> {
    available
        .iter()
        .map(|&agent| {
            let options = models
                .iter()
                .find(|m| m.agent == agent)
                .map(|m| m.options.as_slice())
                .unwrap_or_default();
            let picked = |model: &str| picks.iter().any(|p| p.agent == agent && p.model == model);
            let mut rows: Vec<ModelRow> = options
                .iter()
                .map(|o| ModelRow {
                    model: o.value.clone(),
                    name: o.name.clone(),
                    reported: true,
                    picked: picked(&o.value),
                })
                .collect();
            rows.extend(
                picks
                    .iter()
                    .filter(|p| p.agent == agent && !options.iter().any(|o| o.value == p.model))
                    .map(|p| ModelRow {
                        model: p.model.clone(),
                        name: p.model.clone(),
                        reported: false,
                        picked: true,
                    }),
            );
            (agent, rows)
        })
        .collect()
}

/// A pick's reported name, else its model id.
pub fn pick_name(pick: &ModelPick, models: &[AgentModelOptions]) -> String {
    models
        .iter()
        .find(|m| m.agent == pick.agent)
        .and_then(|m| m.options.iter().find(|o| o.value == pick.model))
        .map(|o| o.name.clone())
        .unwrap_or_else(|| pick.model.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn models() -> Vec<AgentModelOptions> {
        serde_json::from_value(serde_json::json!([
            {"agent":"claude","currentValue":"a","options":[{"value":"a","name":"A"},{"value":"b","name":"B"}]},
            {"agent":"codex","currentValue":"c","options":[{"value":"c","name":"C"}]}
        ]))
        .unwrap()
    }

    fn pick(agent: AgentId, model: &str) -> ModelPick {
        ModelPick {
            agent,
            model: model.into(),
        }
    }

    #[test]
    fn offers_picks_in_list_order_else_every_reported_model() {
        let keys = |o: Vec<Offered>| o.into_iter().map(|o| o.1).collect::<Vec<_>>();
        assert_eq!(keys(offered_models(&models(), &[])), ["a", "b", "c"]);
        let picks = [
            pick(AgentId::Codex, "c"),
            pick(AgentId::Claude, "gone"),
            pick(AgentId::Claude, "b"),
        ];
        assert_eq!(keys(offered_models(&models(), &picks)), ["c", "b"]);
        assert_eq!(
            keys(offered_models(&models(), &[pick(AgentId::Pi, "x")])),
            ["a", "b", "c"]
        );
        assert_eq!(
            initial_model(&models(), &picks, Some(AgentId::Claude)),
            Some((AgentId::Claude, "b".into()))
        );
        assert_eq!(
            initial_model(&models(), &[], Some(AgentId::Claude)),
            Some((AgentId::Claude, "a".into()))
        );
        assert_eq!(
            initial_model(&models(), &picks, None),
            Some((AgentId::Codex, "c".into()))
        );
    }

    #[test]
    fn toggles_picks_and_keeps_models_an_agent_no_longer_reports() {
        let picks = toggle_pick(
            &toggle_pick(&[], AgentId::Claude, "b"),
            AgentId::Claude,
            "gone",
        );
        assert_eq!(
            picks,
            [pick(AgentId::Claude, "b"), pick(AgentId::Claude, "gone")]
        );
        assert_eq!(
            toggle_pick(&picks, AgentId::Claude, "b"),
            [pick(AgentId::Claude, "gone")]
        );
        let columns = model_columns(&[AgentId::Claude, AgentId::Pi], &models(), &picks);
        let claude: Vec<_> = columns[0]
            .1
            .iter()
            .map(|r| (r.model.as_str(), r.reported, r.picked))
            .collect();
        assert_eq!(
            claude,
            [("a", true, false), ("b", true, true), ("gone", false, true)]
        );
        assert!(columns[1].1.is_empty());
        assert_eq!(pick_name(&picks[0], &models()), "B");
        assert_eq!(pick_name(&picks[1], &models()), "gone");
    }
}
