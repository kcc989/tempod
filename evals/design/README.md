# Design evaluation

Scores a captured screen with Cloudflare Workers AI `@cf/cloudflare/clef`. Credentials come only from `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in the environment.

## Pipeline (rubric v3)

1. Capture the window at 2× from the running app: four quadrant zooms, the accessibility frames (`ax/default.txt`), and before/after images for each interaction.
2. `python3 evals/design/assemble_screen.py <spec.json>` builds the case: `full.png`, crops, `context.json`, `capture.json`. Context holds no judgment words or hints.
3. `python3 evals/design/measure.py <case>` runs the measured checks: one-row header, row heights, footer alignment, 4 pt spacing scale, chat inset, 24 pt targets (WCAG 2.5.8), text contrast AA and 3:1 non-text contrast (WCAG 1.4.11). It uses the theme hex values in `apps/mac/src/views/tokens.rs` at the case's `tokensRev`.
4. `bun evals/design/run-design.ts <case>` asks Clef over four encodings (original, JPEG 95/90/85), averages the answers, and scores with `design-eval.ts` under `acceptance.v2.json`. Coverage questions are reported, not scored. Spacing and color come from the measured checks. Key presses get only focus and layout-shift questions. No answer may be below 0.40.
5. `python3 evals/design/compare.py <before> <after>` reports dimension changes. A drop counts only beyond max(0.03, 2·√(sd₁²+sd₂²)).

`design-eval.ts` and `design-eval.questions.json` are used unchanged. Replicate images are git-ignored.

## Calibration

`calibration/` holds 7 professional reference screens and 7 Tempo screens with known problems (`manifest.json`). `run-clef.ts` and `calibrate.py` (with `acceptance.v1.json`) score the set and report per-area AUC. With the original rubric, every reference failed and spacing and color did not separate the sets, which is why v3 measures them instead. v3 is not yet recalibrated against this set.

## Findings that shaped the app (2026-10-14)

- Header kept to one 40 pt row with no workspace title.
- 24 pt targets everywhere, 3:1 input borders, and a primary tint for toggles that are on.
- Less repeated text: one-line sidebar rows; the branch in the hover card and Info.
- Rail tools: the selected tab scrolls into view; Activity, Artifacts and Browser explain their empty or ended state.
- Remaining Clef concerns were mostly uncertain answers (verdict `review`) rather than blockers.
