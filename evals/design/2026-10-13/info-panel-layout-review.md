# Workspace Info placement correction

The user changed the requirement to mutually exclusive Info and tools. Info now reserves space beside the transcript below the workspace header and chat tabs. Both bars span the workspace width. Opening Info hides tools; opening tools hides Info. Closing Info leaves both closed. Existing tool tabs and their width remain available.

The installed native capture `dark/info-below-bars/full.png` shows the full-width bars and Info below them. Desktop accessibility shows Changes replacing Info after ⌘⌥B. Pointer actions and some captures returned stale state or `noWindowsAvailable`; those attempts are not accepted as interaction evidence. No simultaneous Info/tools view is required by the final user instruction.

Four separate stateless Clef requests succeeded with HTTP 200. No overall score or acceptance verdict was produced. The question pack remains reviews-v2.1 and is not calibrated for acceptance.

| Area        | Evidence from Clef                                                                                           | Status                                |
| ----------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| Layout      | Panel space fit 0.2788; reading order 0.8507. Scroll cue and covered text remain uncertain.                  | Needs work / review                   |
| Spacing     | Grouping 1.7968 of 2; alignment 0.8850; consistency 0.8513.                                                  | Evidence retained; no acceptance gate |
| Color/depth | Tonal layers confidence 0.7073. Secondary contrast 1.1894 of 2, confidence 0.0306.                           | Review                                |
| Usability   | Status agreement 0.9387; active tabs clear, confidence 0.5983. Main path and affordance have low confidence. | Review                                |

These results precede the scrollbar correction. Raw answers and capture metadata are in `dark/info-below-bars/`. They do not prove every core screen passes. Calibration and the separate Roles issue remain incomplete.

Mac builds, signing identity verification, and web type checks passed. Root typecheck passed. Changed-file lint passed. Root lint failed in other pending runtime, composer, agent and evaluator files. No test suites ran, as requested.
