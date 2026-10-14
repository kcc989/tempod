//! Views (07, Window layout and components). Regions follow 04.
pub mod agent_attachments;
pub mod agents_model;
pub mod agents_settings;
pub mod artifacts_model;
pub mod changes;
pub mod chat;
pub mod chat_model;
pub mod checks;
pub mod ci_model;
pub mod composer;
pub mod composer_model;
mod composer_parts;
pub mod diagnostics;
pub mod dialogs;
pub mod diff;
pub mod diff_model;
pub mod environments;
pub mod environments_model;
pub mod file_picker;
pub mod file_tree;
pub mod files;
pub mod guides;
pub mod indicators;
pub mod issues;
pub mod main_window;
pub mod mcp_model;
pub mod palette;
pub mod processes;
pub mod repositories;
pub mod repository_checks;
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
pub mod tools;
pub mod top_bar;
pub mod workspace;
pub mod workspace_info;

use gpui_kit::component::skeleton::Skeleton;
use gpui_kit::component::v_flex;
use gpui_kit::{IntoElement, ParentElement as _, Styled as _, px};

/// 04, Empty and loading states: lists show skeleton rows, never a blank pane. Regions that are
/// not built yet show the same.
pub fn skeleton_rows(rows: usize) -> impl IntoElement {
    v_flex().gap_2().p_3().children((0..rows).map(|i| {
        Skeleton::new()
            .h(px(18.))
            .w(gpui_kit::relative([0.82, 0.64, 0.93, 0.71, 0.56][i % 5]))
    }))
}

/// Bytes as the web's `formatBytes` shows them: `812 B`, `2.0 KiB`, `3.4 MiB`.
pub fn format_bytes(n: f64) -> String {
    const K: f64 = 1024.;
    if n < K {
        format!("{n} B")
    } else if n < K * K {
        format!("{:.1} KiB", n / K)
    } else if n < K * K * K {
        format!("{:.1} MiB", n / K / K)
    } else {
        format!("{:.1} GiB", n / K / K / K)
    }
}

pub mod events;
