//! Every menu item, palette entry and shortcut runs one of these actions (07, macOS integration).
use gpui_kit::Action;

#[derive(Clone, Debug, PartialEq, Eq, Action)]
#[action(namespace = tempo, no_json)]
pub struct NewWorkspaceForProject(pub String);

gpui_kit::actions!(
    tempo,
    [
        About,
        CheckForUpdates,
        OpenSettings,
        SignOut,
        HideApp,
        Quit,
        NewWorkspace,
        AddProject,
        RenameWorkspace,
        ShowHistory,
        ConfirmDialog,
        DismissDialog,
        NewChat,
        CloseTab,
        OpenFile,
        SearchFiles,
        CommandPalette,
        ToggleSidebar,
        ToggleRightSide,
        ToggleBottomPanel,
        ShowDiff,
        CommitAndPush,
        CreatePr,
        Merge,
        Archive,
        ToggleRun,
        NextWorkspaceNeedingYou,
        Minimize,
        Zoom,
        OpenTempoInBrowser,
        NextTab,
        PreviousTab,
        NextWorkspace,
        PreviousWorkspace,
        FocusComposer,
        NextComposerChoice,
        PreviousComposerChoice,
        DismissComposerChoice,
        Send,
        StopTurn,
        TogglePlanMode,
        ModelPicker,
        AttachFile,
        ExpandAllToolCalls,
        ToggleDiffScope,
        NextFile,
        PreviousFile,
        MarkFileViewed,
        ViewChecks,
    ]
);

/// ⌘1 to ⌘9: the workspace at this 1-based position in the sidebar.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Action)]
#[action(namespace = tempo, no_json)]
pub struct SwitchToWorkspace(pub usize);
