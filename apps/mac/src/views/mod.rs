//! Views (07, Window layout and components). Regions follow 04.
pub mod agents_model;
pub mod agents_settings;
pub mod changes;
pub mod chat;
pub mod chat_model;
pub mod checks;
pub mod composer;
pub mod composer_model;
pub mod diagnostics;
pub mod dialogs;
pub mod diff;
pub mod diff_model;
pub mod environments;
pub mod environments_model;
pub mod file_picker;
pub mod file_tree;
pub mod files;
pub mod indicators;
pub mod main_window;
pub mod mcp_model;
pub mod palette;
pub mod processes;
pub mod review;
pub mod run;
pub mod settings;
pub mod settings_form;
pub mod settings_model;
pub mod setup;
pub mod sidebar;
pub mod sign_in;
pub mod terminal;
pub mod toast;
pub mod tokens;
pub mod top_bar;
pub mod workspace;

use gpui_kit::component::skeleton::Skeleton;
use gpui_kit::component::v_flex;
use gpui_kit::{IntoElement, ParentElement as _, Styled as _, px};

/// 04, Empty and loading states: lists show skeleton rows, never a blank pane. Regions that are
/// not built yet show the same.
pub fn skeleton_rows(rows: usize) -> impl IntoElement {
    v_flex()
        .gap_2()
        .p_3()
        .children((0..rows).map(|_| Skeleton::new().h(px(14.)).w_full()))
}
