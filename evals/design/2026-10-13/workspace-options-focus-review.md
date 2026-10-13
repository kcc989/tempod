# Workspace options focus: candidate awaiting native confirmation

The prior valid New workspace options Tab capture had no visible focus mark. Clef returned `feedback_focus_visible: missing`, confidence 0.6248; the interaction feedback score was 0.2045 / 2. The source had no tracked focus on the options popover. Supporting capture: `dark/branch-option-alignment/tab.jpg`; raw response: `dark/branch-option-alignment/after/interaction-tab.answers.json`.

Mac now tracks the branch input’s focus handle and focuses it on open. The input uses its existing theme focus border. Web explicitly focuses the selected source tab on open, using its existing tab focus styling. Specs 04 and 07 state the focus targets. The pending creation-composer extraction is saved separately at a7fb6ba; this fix changes only focus routing.

The Mac build, application TypeScript check and changed-file lint passed. No tests or test-target compilation ran. The Mac remains locked according to desktop control, so there is no fresh screenshot, Tab confirmation or Clef after answer. The issue remains `review`; no focus, screen or app pass is claimed. After unlock, inspect Info and Guides first, then record opening workspace options and pressing Tab in separate before/after captures.
