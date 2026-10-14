# Workspace options focus: candidate awaiting native confirmation

The prior valid New workspace options Tab capture had no visible focus mark. Clef returned `feedback_focus_visible: missing`, confidence 0.6248; the interaction feedback score was 0.2045 / 2. The source had no tracked focus on the options popover. Supporting capture: `dark/branch-option-alignment/tab.jpg`; raw response: `dark/branch-option-alignment/after/interaction-tab.answers.json`.

Mac now tracks the branch input’s focus handle and focuses it on open. The input uses its existing theme focus border. Web explicitly focuses the selected source tab on open, using its existing tab focus styling. Specs 04 and 07 state the focus targets. The pending creation-composer extraction is saved separately at a7fb6ba; this fix changes only focus routing.

The Mac build, application TypeScript check and changed-file lint passed. No tests or test-target compilation ran. The Mac remains locked according to desktop control, so there is no fresh screenshot, Tab confirmation or Clef after answer. The issue remains `review`; no focus, screen or app pass is claimed. After unlock, inspect Info and Guides first, then record opening workspace options and pressing Tab in separate before/after captures.

Installed candidate: `7ed0178`; binary SHA-256 `7ac70b027d8599283abc054d99ad727f584d3824783a0db5aae7c83786d87086`. Signing and Keychain-helper identities match. The binary includes other pending working-tree edits. Desktop relaunch is unverified while locked.


## Native confirmation after desktop access resumed

Fresh captures in `dark/workspace-options-focus` show the input focus border immediately on open, then a focus ring on the first branch row after Tab. Both original interaction requests returned HTTP 200 after correcting screenshot MIME encoding; the initial HTTP 422 attempts are retained. Clef reports keyboard focus `visible`, confidence 0.5361. The old missing-focus finding is resolved for this captured native flow. Generic feedback and selected-state answers remain uncertain; persistent branch selection and whole-screen acceptance are not established. The draft was dismissed without creating a workspace. No tests ran.
