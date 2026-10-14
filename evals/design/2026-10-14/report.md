# Design evaluation, 2026-10-14: workspace screen

**Result: the workspace screen fails in both themes. No acceptance is possible yet, because the rubric did not calibrate.**

Scope: main workspace screen of the Mac app (repo build, commit `e2b74e6`), dark and light themes as separate runs. Roles were not evaluated. No test suite was run; typecheck and lint pass.

## 1. Calibration (do not trust scores yet)

Set: your 7 references (Claude, Codex, Gumloop, Attio, Linear, Plain, Customer.io) and 7 Tempo captures with documented problems (`calibration/manifest.json` lists the label basis for each). Ground truth was not sent to Clef. Gates were fixed from what each image shows.

| | Original rubric (v1) | Candidate v2 |
|---|---|---|
| Overall score AUC (reference > problem) | 0.92 | 0.88 |
| Layout area AUC | 0.79 | 0.82 |
| Spacing area AUC | 0.69 | 0.64 |
| Color/depth area AUC | 0.66 | 0.66 |
| Usability area AUC | 0.84 | 0.88 |
| References that pass acceptance | 0 of 7 | 0 of 7 |

- **Every reference fails.** Feature-presence questions score near 0 on most references: `speed_shortcuts` (6 of 7), `ai_feedback`, `ai_limits`, `control_draft`, `focus_space_fit` (~0.3 on all 14 screens). Clef reads features correctly (Plain "Filters F" 0.93, Claude's AI disclaimer 0.95, Customer.io thumbs 0.92). The rubric expects every pattern on every screen.
- **Spacing and color/depth carry no signal.** `spacing_*` answers are ~0.9 on all 14 screens, including Tempo screens you called cramped. Rewording in v2 did not change that.
- **v2** (`v2/`, byte-identical scorer) drops 5 feature-presence questions and rewrites 4. I stopped after one round, because further rewording would tune against the same 14 screens. v2 is uncalibrated and not used for acceptance.
- **Capture noise is larger than small fixes.** Pixel-identical captures, re-encoded, moved dimensions by up to ±0.09 (control 0.25→0.16). The rule "keep a fix only if no dimension drops" cannot be satisfied with one run per state.

Analysis: `calibration/analysis.json` (v1) and `calibration/analysis-v2.json`.

## 2. Workspace screen results (v1 scorer, unchanged)

| Theme | Score | Verdict | Layout | Spacing | Color/depth | Usability |
|---|---|---|---|---|---|---|
| Dark | 0.73 | needs_work | fail 0.83 | pass 0.97\* | review 0.88 | fail 0.73 |
| Light | 0.74 | needs_work | fail 0.82 | pass 0.97\* | review 0.89 | fail 0.73 |

\* Spacing "pass" is not evidence: that area did not separate references from problems.

The screen fails on several counts: score below 0.80, one blocker, weak dimensions, and answers below the 0.40 floor.

### Blockers
- "An action gives no visible feedback near the control." This comes from **Pressed Tab** (`states_feedback` 0.30, confidence 0.12, so uncertain). In the same request Clef answered `feedback_focus_visible: visible`, and `workspace/*/interactions/tab-after.jpg` shows a focus ring on Toggle sidebar. **I think this blocker is wrong; your call.**

### Weak dimensions (below 0.60)
Dark: ai 0.42, control 0.22, states 0.58, overflow 0.50. Light: ai 0.40, control 0.25, states 0.56, overflow 0.50.

### Fixes from `result.fixes`, in order
| # | Dark | Light |
|---|---|---|
| 1 | Save a draft or undo before work is final | same |
| 2 | Show that a region scrolls | same |
| 3 | State the limits of the AI near its output | same |
| 4 | Let the user rate or correct AI output | same |
| 5 | Show a pressed or selected state at once | same |
| 6 | Same name repeated across regions | Say what sleeping means and how to resume |

Fixes 1, 3 and 4 add features that the spec does not define and that most of your references lack. They need a spec decision before any code.

### Issues from `result.issues`
- Same name repeated across regions: p = 0.80 (dark), 0.75 (light). Image 1 (`full.png`): the branch appears in the header and in the sidebar row; the prompt appears as header title, sidebar row and user message.

### Answers below 0.40 (not uncertain)
`status_lifecycle` 0.30, `ai_limits` 0.02, `ai_feedback` 0.03, `control_draft` 0.22–0.25, `speed_views` 0.03, `quality_repeated_identifier` 0.20–0.25, `feedback_selected` 0.14–0.15 (Pressed Tab), `focus_space_fit` 0.29 (light).

### Review (uncertain), not pass
Color/depth: `contrast_secondary`, `contrast_boundaries`, `icons_meaning`. The full uncertain lists are in each `result.json`.

## 3. Defects Clef missed (verified in the real app)

| Area | Severity | Finding | Capture |
|---|---|---|---|
| Layout | Major | With the tool pane open, the header wraps to two rows. The branch, "Running · standard-3", Info and pane toggles are clipped under the chat tabs. Tab 07 requires one 40 pt bar. Clef: `feedback_layout_shift` 0.21–0.48, `quality_overflow` not flagged. | `workspace/*/interactions/changes-after.jpg` |
| Layout | Minor | Opening Info shifts the whole conversation about 176 pt left. Clef: layout shift 0.08–0.14. | `info-before.jpg` → `info-after.jpg` |
| Spacing | Minor | Sidebar footer "Repositories" is centered; tab 07 says footer actions "fill the width and align left". | `sidebar.png` |
| Usability | Minor | Settings › Appearance: System, Light and Dark show no selected state. Not this screen. | seen during setup, not saved |

## 4. Fix attempted, held for your decision

Header no-wrap fix: fixed 40 pt bar, title and branch truncate with an ellipsis, status kept. Verified in the app: one row, nothing clipped (`workspace-header-fix/light/interactions/changes-after.jpg`). Re-scored: 0.74 → 0.73. Several dimensions moved, but the main captures are pixel-identical, so the movement is noise. By your rule I did not keep it. The patch is at `workspace-header-fix/header-no-wrap.patch`.

## 5. Questions for you
1. Keep the header fix despite the noise rule? Or allow a tolerance band, or averages over 3 captures?
2. Repeated name: which copy goes? Header branch, sidebar branch, or header title. The spec is silent.
3. Draft/undo, AI limits note, AI rating, collection views: add to the spec, or treat them as non-gating coverage?
4. Spacing and color/depth: Clef cannot judge them here. Use measured checks from AX frames and theme tokens instead?
5. Calibration needs comparable known-problem screens from other products. All 7 problem screens are Tempo (dark), and 5 references are light.

## Files
`design-eval.ts` and `design-eval.questions.json`: your scorer, verbatim. `run-clef.ts`: runner. `acceptance.v1.json`: area split and 0.40 floor. `calibrate.py`: separation analysis. Each case folder holds `context.json`, `capture.json`, the images, `*.answers.json`, `result.json`, `areas.json` and `acceptance.json`.
