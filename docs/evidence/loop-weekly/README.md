# Weekly loop reports

One `<date>.json` per week, written by Tempo's daily loop report through a Tempo PR (13, Phase 3). Each file is the `getLoopReport` result for the 7 days before `<date>`. The `check` job prints the newest one in the CI summary; a missed time target does not fail CI.
