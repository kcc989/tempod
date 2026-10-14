# Shared header and grouped tools review

The Mac app is rebuilt, signed, installed and relaunched. The header uses the rendered pane widths. The header divider and actual tool rail align in the full-screen picker and normal-window Changes captures. No overall app acceptance is claimed.

## Changes

- One 40 pt muted header spans the app. Workspace controls and tool tabs share it; chat tabs remain below.
- Six tools appear in a two-column grid: Changes, Terminal, Run, Browser, Guides and Artifacts. Info stays on its own top-bar toggle.
- Changes contains Changes, Files and Checks. Run contains Setup and Run. Each group has one outer tab and remembers its section.
- The pane toggle opens the picker. Existing tabs remain available. Tool actions open their target directly.
- Native outer tabs have text labels. Section tabs have a 12 pt inset. Picker rows are 36 pt with normal text.
- Web implementations and tabs 04/07 are updated in the same phase.

## Evidence

[Full-screen tool picker](dark/shared-header-aligned/full.png) and [normal-window Changes](dark/shared-header-aligned/windowed-changes.png) show the corrected alignment. Accessibility captures and the installed-build receipt are beside them. The installed build includes other pending native changes, recorded by source hashes. These captures are not evidence of a clean source tree.

## Clef area reviews

Four stateless Cloudflare Workers AI Clef calls returned HTTP 200. Full-window pixels and detail crops were provided. Prior results and requested fixes were not included in the model context. Questions are unchanged from reviews-v2.1. Calibration is incomplete; acceptance is disabled.

| Area        | Raw evidence                                            | Remaining concern                                          |
| ----------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| Layout      | Space fit 0.1848                                        | Panel space fit remains weak.                              |
| Spacing     | Grouping 1.7958/2; alignment 0.8644; consistency 0.8666 | These answers do not establish app-wide quality.           |
| Color/depth | Tonal layers; confidence 0.719                          | Secondary contrast has confidence 0.0696 and needs review. |
| Usability   | Active tabs clear; confidence 0.5761                    | Icon meaning has confidence 0.0505 and needs review.       |

Clef provides answers, not reasons. No cause is inferred for those findings. No aggregate score or ship verdict is assigned.

## Validation

- Native binary build passes. No test targets were compiled.
- Root typecheck passes: eight tasks; latest run 2.565 seconds.
- Changed web-file lint and diff checks pass.
- Root lint fails on existing pending runtime, composer, history, branch-picker and evaluation files.
- Bundle signature and development app/Keychain helper identities pass verification.
- Native picker-on-open, compact rows, tab labels, section inset and rail alignment are visible in the installed app. Windowed and full-screen states were reviewed. Manual divider dragging and the web shared-header interaction have not been confirmed in this pass.
- No test suites ran, as requested. Roles and broader design acceptance remain open.
