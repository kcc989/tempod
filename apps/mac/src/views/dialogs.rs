//! New workspace (04, 07): prompt first, new branch by default, and models from listModels.
use tempo_protocol::{AgentId, CreateWorkspaceIn, NewSource};

/// Draft for the native composer. Branch and repeated-creation options live in its menu.
#[derive(Clone, Debug)]
pub struct NewWorkspaceDraft {
    pub project_id: String,
    pub source: NewSource,
    pub agent: AgentId,
    pub model: String,
    pub prompt: String,
}

impl NewWorkspaceDraft {
    pub fn new(project_id: String, base_branch: String, agent: AgentId) -> Self {
        Self {
            project_id,
            source: NewSource::New { base_branch },
            agent,
            model: String::new(),
            prompt: String::new(),
        }
    }

    pub fn input(&self) -> Result<CreateWorkspaceIn, serde_json::Error> {
        let mut input = serde_json::json!({
            "projectId": self.project_id,
            "source": self.source,
            "agent": self.agent,
        });
        if !self.model.is_empty() {
            input["model"] = self.model.clone().into();
        }
        let prompt = self.prompt.trim();
        if !prompt.is_empty() {
            input["prompt"] = serde_json::json!({"text": prompt});
        }
        serde_json::from_value(input)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_model_and_prompt_reach_the_first_chat() {
        let draft: NewSource = serde_json::from_value(serde_json::json!({
            "kind": "new", "baseBranch": "main"
        }))
        .unwrap();
        let input = NewWorkspaceDraft {
            project_id: "project".into(),
            source: draft,
            agent: AgentId::Codex,
            model: "reported-model".into(),
            prompt: "  Fix it  ".into(),
        }
        .input()
        .unwrap();
        let json = serde_json::to_value(input).unwrap();
        assert_eq!(json["model"], "reported-model");
        assert_eq!(json["prompt"]["text"], "Fix it");
        assert_eq!(json["source"]["kind"], "new");
    }
}
