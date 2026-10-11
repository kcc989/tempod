//! Store logic shared with the app (07, Live state and reconnects): pure, no I/O. The same messages
//! give the same end state and events as the web stores; `tests/stores.rs` proves it on the shared
//! channel fixtures.

pub mod hub;
pub mod workspace;

pub use hub::{
    HubState, NotifyEvent, NotifyKind, SidebarSection, SortMode, is_listed, sidebar_sections,
};
pub use workspace::{
    MAX_SCRIPT_OUTPUT, TranscriptRow, WorkspaceEvent, WorkspaceState, is_turn_ended,
    transcript_rows,
};
