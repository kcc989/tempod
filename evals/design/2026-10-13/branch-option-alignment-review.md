# New workspace branch rows: alignment confirmed, screen needs work

The user requested left-aligned base-branch options. The valid before capture shows centered branch rows. The Mac rows now use the existing ghost button style with full-width, left-aligned text and truncation. Full names remain accessible. The web picker explicitly allows rows and labels to shrink within the menu. Tabs 04 and 07 describe the row rules. The installed working tree includes earlier pending composer work; this review concerns the branch-row change only.

A fresh full-window capture now matches accessibility and visibly shows shared left edges for the branch names. Clicking auth-enrollment-flow changes the nearby draft branch field. The draft was dismissed without creating a workspace. No supplied branch name exceeds the available row width, so the ellipsis code is not claimed as a verified long-name case.

The TypeScript check and Mac build passed. Signing and the Keychain helper identities were verified. The saved sign-in restored after relaunch. No test suite ran.

## Separate stateless reviews

Four before and four after Workers AI requests returned HTTP 200 and all 51 draft area answers. Two original-question interaction calls also returned HTTP 200. No overall or area score is used for acceptance; these 2.1 questions remain uncalibrated.

| Question | Before | After | Interpretation |
| --- | ---: | ---: | --- |
| Spacing alignment | 0.7751 | 0.8532 | Higher probability of aligned elements. |
| Spacing consistency | 0.8921 | 0.8423 | Declined; retained in the record. |
| Spacing grouping, raw /2 | 1.7402 | 1.7213 | Slight decline; not hidden in an average. |
| Control boundaries | 0.7529 | 0.6648 | Declined with the borderless rows. |
| Overflow detection | 0.3830 | 0.2509 | Lower detection probability; before was uncertain. |
| Panel space fit | 0.2706 | 0.2668 | Existing weak layout answer persists. |

Secondary text contrast and action affordance remain uncertain. All answers, probabilities and confidence are saved in review.json and the raw response files; no reasons are attributed to Clef. The direct alignment request is visibly fulfilled, but these results do not establish that the whole screen passes or that every other design measure improved.

## Remaining usability findings

- **Major, needs work:** workspace-options keyboard focus. The Tab capture has no visible focus mark; Clef returns missing with confidence 0.6248. Supporting capture: dark/branch-option-alignment/tab.jpg.
- **Major, review:** persistent branch selection feedback. The draft field changes, but Clef's selected probability is 0.2828 and feedback confidence is 0.3567. Supporting capture: dark/branch-option-alignment/picked.jpg. The hover fill alone does not prove a persistent selection mark.
- **Color/depth, review:** secondary contrast has confidence 0.0149. Native measured contrast is unavailable, so no WCAG claim is made.

Earlier screenshots that disagreed with accessibility are excluded. The accepted after input uses a fresh full-window frame plus the same two crop regions as before. Source choices, project, branch draft and right-panel state are matched for the area comparison. Keyboard and selection evidence remain separate action pairs.

The app and screen remain unaccepted. Seven-pair calibration, other core screens, complete interactions, consistency and the separate Roles issue still require work.
