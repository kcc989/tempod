use tempo_protocol::{
    AgentMessageContent, Empty, Function, Item, ItemContent, ItemKind, ItemStatus, Method,
    PlanContent, SendPromptIn, Turn, WorkspaceDetail, api,
};

fn types_of<F: Function>() -> (&'static str, Method) {
    (F::NAME, F::METHOD)
}

#[test]
fn api_markers_pair_inputs_with_outputs() {
    fn send_prompt<F: Function<Input = SendPromptIn, Output = Turn>>() {}
    fn list_projects<F: Function<Input = Empty, Output = Vec<tempo_protocol::Project>>>() {}
    fn get_workspace<F: Function<Output = WorkspaceDetail>>() {}
    send_prompt::<api::SendPrompt>();
    list_projects::<api::ListProjects>();
    get_workspace::<api::GetWorkspace>();
    assert_eq!(types_of::<api::SendPrompt>(), ("sendPrompt", Method::Post));
    assert_eq!(
        types_of::<api::GetWorkspace>(),
        ("getWorkspace", Method::Get)
    );
}

#[test]
fn empty_is_an_empty_object() {
    assert_eq!(serde_json::to_string(&Empty {}).unwrap(), "{}");
    assert_eq!(
        serde_json::from_str::<Empty>(r#"{"later":"field"}"#).unwrap(),
        Empty {}
    );
}

fn item(content: ItemContent) -> Item {
    Item {
        id: "i1".into(),
        session_id: "s1".into(),
        turn_id: None,
        status: ItemStatus::Streaming,
        rev: 3.0,
        created_at: 1.0,
        updated_at: 2.0,
        content,
    }
}

#[test]
fn items_put_kind_and_content_on_the_item() {
    let it = item(ItemContent::AgentMessage(AgentMessageContent {
        blocks: None,
        text: "Hi".into(),
    }));
    let json = serde_json::to_value(&it).unwrap();
    assert_eq!(json["kind"], "agent_message");
    assert_eq!(json["content"]["text"], "Hi");
    assert!(json["turnId"].is_null() && json.get("turnId").is_some());
    assert_eq!(serde_json::from_value::<Item>(json).unwrap(), it);
}

#[test]
fn item_text_is_there_for_the_kinds_that_stream() {
    let mut it = item(ItemContent::AgentMessage(AgentMessageContent {
        blocks: None,
        text: "Hi".into(),
    }));
    it.content.text_mut().unwrap().push_str(" there");
    assert_eq!(it.content.text(), Some("Hi there"));
    assert_eq!(it.kind(), ItemKind::AgentMessage);
    let plan = item(ItemContent::Plan(PlanContent { entries: vec![] }));
    assert_eq!(plan.content.text(), None);
    assert_eq!(plan.kind(), ItemKind::Plan);
}

#[test]
fn a_missing_turn_id_is_an_error() {
    let raw = r#"{"id":"i","sessionId":"s","status":"completed","rev":1,"createdAt":1,"updatedAt":1,"kind":"handoff","content":{"text":"x"}}"#;
    assert!(serde_json::from_str::<Item>(raw).is_err());
}
