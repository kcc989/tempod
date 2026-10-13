# Context capacity meter

Replaces the constant percentage label with a neutral 48 × 6 horizontal capacity meter beside `Context`. Fill comes from ACP `usage_update.used / size`, capped at full. No loading animation or added thresholds. Hover and the accessible name expose totals; click or keyboard activation opens the details. Both clients and specs 04/07 changed.

## Observed Mac result

- Installed binary SHA256: `21d2a313b926a50795b728b4ee691bbc657920e9bd8535542df8870411930499`.
- Signed app and Keychain helper identities matched. The saved sign-in restored the chat.
- Current agent data: 30,785 of 1,000,000 tokens, rounded to 3% in the details.
- Click and Enter opened details; Escape closed them. Tab produced a visible focus ring on the context button. No prompt, model or mode change was sent.
- Fixed the initial click handler, which toggled the popup closed after opening it.
- Final capture: [details](dark/context-meter/keyboard-open.jpg). Closed focused control: [keyboard](dark/context-meter/keyboard.jpg).
- `before.jpg` is stale Connecting pixels and must not be evaluated. `full.jpg` and `details.jpg` precede the final click fix; use `keyboard.jpg` and `keyboard-open.jpg` for the final pair.

## Independent Clef reviews

Cloudflare Workers AI `@cf/cloudflare/clef`; stateless requests, no prior results supplied. Version 2.1 draft packs remain uncalibrated. Four area calls and the supplied interaction questions each returned HTTP 200 with all 55 requested answers. Requests, raw responses, metadata and review crops are in `dark/context-meter/`.

| Area | Evidence and limit |
| --- | --- |
| Layout | Overflow detection 0.0561; full-workspace panel space-fit 0.286 remains weak. This capture does not establish a layout pass. |
| Spacing | Grouping 1.7999/2; alignment 0.8136; cramped-padding probability 0.0476. |
| Color/depth | Tonal dark layers confidence 0.7671. Secondary contrast confidence 0.0498 requires review. No measured contrast claim. |
| Usability | Status agreement 0.9228. Action affordance confidence 0.2784 and disabled-state confidence 0.0608 require review. |
| Interaction | Selected-state probability 0.1806: the trigger has no persistent selected mark while details are open. Focus-after-Enter judgment has confidence 0.0645 and requires review; a focus ring is visible before Enter, but not in the popup capture. Layout-shift probability 0.1626. |

No aggregate score or app-wide acceptance. Open-trigger selection and focus within the informational popup remain follow-up findings. No screen-reader session was performed. The popup's plain text is not present as child text in the native accessibility snapshot; the trigger's accessible name contains the percentage and complete token totals.

## Validation

Web TypeScript checking passed. Native `cargo build --locked -p tempo-mac --bin Tempo` passed for the working tree, which also contains earlier unfinished changes. `git diff --check` passed. No test suite ran, per the user's instruction. Web interaction was not exercised in this pass. Nothing was pushed or deployed.
