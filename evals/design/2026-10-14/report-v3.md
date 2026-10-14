# Workspace screen: rubric v3, denoised, measured

**Result: the workspace screen still fails acceptance in both themes. Three measured defects are fixed; two need your approval.**

## What changed in the rubric (per your decisions)

- **Coverage, not acceptance:** `speed_shortcuts`, `speed_views`, `ai_limits`, `ai_feedback`, `ai_evidence` and `control_draft` are still asked and reported, but never scored. So are `focus_space_fit` and `overflow_scroll_cue`: in calibration they gave the same answer on almost all 14 screens.
- **Measured instead of Clef:**
  - Spacing: accessibility-tree frames and pixel edges against tab 07's numbers (row heights, footer alignment, 4-pt scale, 12 pt chat inset, 24 pt targets).
  - Color/depth: WCAG contrast computed from the theme hex values in `tokens.rs`.
  - Layout: adds a measured "header is one row" check.
  - Results feed `scoreDesign()`'s existing `checks` inputs.
- **Keyboard actions:** Pressed Tab gets only the focus and layout-shift questions. The earlier blocker came from a pressed-control question applied to a key press.
- **Denoising:** each state is scored over 4 encodings (original, JPEG 95/90/85) and averaged. Score SD is now 0.000–0.021 (it was ±0.09 per dimension). A dimension counts as dropped only below −max(0.03, 2·√(sd₁²+sd₂²)).
- **Unchanged:** `design-eval.ts` and `design-eval.questions.json`. v3 is a policy over them (`acceptance.v2.json`). It is still uncalibrated.

## Before → after (matched state: repo build vs `HEAD`, Sleeping workspace, same window)

| | Dark | Light |
|---|---|---|
| Score (mean of 4) | 0.817 → 0.815 (band 0.042) | 0.820 → 0.833 (band 0.030) |
| Blocker "element wider than its container" | removed | removed |
| Dimension drops beyond noise | none | none |
| Gains | craft | craft |

Measured checks (same in both themes):

| Check | Before | After |
|---|---|---|
| Header one row with the tool pane open | fail (centers 26.6 pt apart, bottom 50 pt) | **pass** |
| Footer rows aligned left, same height | fail (Repositories at 76 pt vs 16 pt; 20 pt tall) | **pass** |
| Chat bar 12 pt from the divider | fail (10.2 pt) | **pass** (12.3 pt) |
| Row heights 36 pt; 4-pt spacing scale; text contrast AA | pass | pass |
| Target size 24 pt (WCAG 2.5.8 spacing rule) | fail | fail: needs approval |
| Input boundaries 3:1 (WCAG 1.4.11) | fail (1.25–1.35:1) | fail: needs approval |

## Fixes (one commit each)
1. `a479c29`: header stays one 40 pt row; branch truncates; no workspace title on desktop (web and Mac; specs 04 and 07; e2e test checks the sidebar row on desktop).
2. `54a943f`: Mac sidebar "Repositories" matches the other footer rows.
3. `4f90bb7`: Mac chat tab bar starts 12 pt from the divider (tab 07).

## Still failing after the fixes
Score 0.83–0.84, no blockers, no weak dimensions. Remaining reasons:
- **Verdict "review":** uncertain Clef answers make up more than 25% of the weight. They include `focus_content_share`, `focus_affordance`, `ai_steps`, `states_disabled_clear`, `states_feedback`, `copy_labels`, `type_scale`, `type_mono` and `icons_meaning`.
- **`quality_repeated_identifier`** 0.20 (issue p = 0.79–0.80). It is unchanged after removing the header title, and Clef does not say which name it means.
- **`feedback_selected`** 0.32–0.35: after "Workspace info", Clef doesn't see the button as selected.
- **Spacing:** target size. **Color/depth:** input boundaries.

## Decisions needed
1. **Target size:** tab 07 specifies small (20 pt) header and sidebar icon buttons. Enlarge them to 24 pt, or add spacing between neighbours?
2. **Input boundaries:** the composer fill and borders are 1.2–1.35:1 against the background. Raising them to 3:1 means changing theme color values (`border` and/or `surface`).
3. **Repeated names:** which copy should go next? Candidates: the branch in the sidebar row metadata, or the status shown in the header, sidebar and Info.

## Caveats
- One Clef run per encoding; calibration (v1) never passed, and v3 has not been recalibrated against the 14-screen set.
- The light baseline in `workspace/` (Running state) reused the dark AX frames; the matched comparison above does not.
- Replicate images are git-ignored; `run-design.ts` regenerates them, and `images.json` holds the hashes.
