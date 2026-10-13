use serde::{Deserialize, Serialize};

use crate::{
    AgentMessageContent, AgentProposalContent, AgentThoughtContent, ArtifactItemContent,
    ErrorContent, HandoffContent, ItemKind, ItemStatus, NoticeContent, PermissionContent,
    PlanContent, RevertMarkerContent, RunContent, ToolCallItemContent, UserMessageContent,
};

/// One transcript item (02, Item model). The fields every kind shares sit on the struct; `kind` and
/// `content` travel together as [`ItemContent`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "turnId", deserialize_with = "Option::deserialize")]
    pub turn_id: Option<String>,
    pub status: ItemStatus,
    pub rev: f64,
    #[serde(rename = "createdAt")]
    pub created_at: f64,
    #[serde(rename = "updatedAt")]
    pub updated_at: f64,
    #[serde(flatten)]
    pub content: ItemContent,
}

/// `kind` with its `content`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "content", rename_all = "snake_case")]
pub enum ItemContent {
    Run(RunContent),
    AgentProposal(AgentProposalContent),
    UserMessage(UserMessageContent),
    AgentMessage(AgentMessageContent),
    AgentThought(AgentThoughtContent),
    ToolCall(ToolCallItemContent),
    Plan(PlanContent),
    Permission(PermissionContent),
    Notice(NoticeContent),
    Handoff(HandoffContent),
    RevertMarker(RevertMarkerContent),
    Error(ErrorContent),
    Artifact(ArtifactItemContent),
}

impl Item {
    pub fn kind(&self) -> ItemKind {
        self.content.kind()
    }
}

impl ItemContent {
    pub fn kind(&self) -> ItemKind {
        match self {
            Self::Run(_) => ItemKind::Run,
            Self::AgentProposal(_) => ItemKind::AgentProposal,
            Self::UserMessage(_) => ItemKind::UserMessage,
            Self::AgentMessage(_) => ItemKind::AgentMessage,
            Self::AgentThought(_) => ItemKind::AgentThought,
            Self::ToolCall(_) => ItemKind::ToolCall,
            Self::Plan(_) => ItemKind::Plan,
            Self::Permission(_) => ItemKind::Permission,
            Self::Notice(_) => ItemKind::Notice,
            Self::Handoff(_) => ItemKind::Handoff,
            Self::RevertMarker(_) => ItemKind::RevertMarker,
            Self::Error(_) => ItemKind::Error,
            Self::Artifact(_) => ItemKind::Artifact,
        }
    }

    /// The `text` of the kinds that have one; `item.delta` appends to it.
    pub fn text(&self) -> Option<&str> {
        match self {
            Self::UserMessage(c) => Some(&c.text),
            Self::AgentMessage(c) => Some(&c.text),
            Self::AgentThought(c) => Some(&c.text),
            Self::Notice(c) => Some(&c.text),
            Self::Handoff(c) => Some(&c.text),
            _ => None,
        }
    }

    pub fn text_mut(&mut self) -> Option<&mut String> {
        match self {
            Self::UserMessage(c) => Some(&mut c.text),
            Self::AgentMessage(c) => Some(&mut c.text),
            Self::AgentThought(c) => Some(&mut c.text),
            Self::Notice(c) => Some(&mut c.text),
            Self::Handoff(c) => Some(&mut c.text),
            _ => None,
        }
    }
}
