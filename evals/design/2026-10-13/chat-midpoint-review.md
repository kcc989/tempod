# Chat width midpoint

The user requested smaller chat margins and then chose a midpoint between the previous 680 pt layout and the proposed 960 pt layout. The outer chat track now caps at 820 pt on Mac and 51.25rem on web (820 px at a 16 px root). That is 20.6% wider than the previous native track.

Closed-tool-area padding changes from 4% / 48 maximum to 2% / 24 maximum. Minimum padding remains 16 pt on Mac and 12 px on web. Open-tool-area padding remains 16 pt / 12 px. Both outer tracks stay centered and shrink to fit their pane.

Markdown has its own reading constraint: 75ch on web and a 600 pt content width inside a 632 pt native message row. The native limit belongs on the row container: placing it directly on TextView did not reliably constrain layout. Composer and structured work controls can use the wider outer track. Markdown tables and code inside a message retain the same reading constraint in this iteration. These are layout limits, not a measured guarantee that every line contains at most 75 characters.

This separates the interface width from the text measure. [W3C's visual presentation guidance](https://www.w3.org/WAI/WCAG22/Understanding/visual-presentation.html) describes an 80-character text-width option at Level AAA; it does not require every interface panel to use that width.

## Evidence

- Installed final binary SHA256: `557f6b1234e6d884d211c7e3fb60ee4fa42cd6752ae23f7708108d7e4f3471d6`.
- [Final closed tool area](dark/chat-midpoint/final-collapsed.jpg) and [final open tool area](dark/chat-midpoint/final-expanded.jpg) show the same chat and final build. The installed app was left with tools closed.
- `before.jpg` shows the previous build. `collapsed.jpg` and `expanded.jpg` precede the final native row-container fix and are superseded.
- Saved sign-in restored. App and Keychain helper signing identities matched. No prompt, model, mode, branch or project data changed.
- Native build and web TypeScript checking passed. Mechanical layout scan returned no findings; this is not a visual pass. Git diff checks passed. No test suites ran. Web interaction was not exercised in this pass.

## Independent Clef findings

Cloudflare Workers AI `@cf/cloudflare/clef`, four stateless version 2.1 draft packs. All four calls returned HTTP 200 with all 51 answers. Full views and dense crops, requests, raw answers and metadata are under `dark/chat-midpoint/`. The packs remain uncalibrated. No prior results or desired scores were supplied.

| Area        | Finding                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Layout      | Panel space-fit 0.3067 remains weak. Long-line detection 0.2274 and overflow detection 0.0412. Scroll-edge detection 0.2833.   |
| Spacing     | Grouping 1.8445/2, alignment 0.9060, consistency 0.8383. Cramped-padding detection 0.0465.                                     |
| Color/depth | Tonal layers confidence 0.6390. Secondary contrast confidence 0.0247 requires review. Boundary visibility 0.5967 is uncertain. |
| Usability   | Status agreement 0.8966. Affordance confidence 0.1969 and disabled-state confidence 0.0534 require review.                     |

These are observations of the current workspace, not a controlled score comparison with earlier captures. No overall score or app-wide acceptance is claimed. The isolated commit includes only this width change and matching client specs; earlier unfinished edits remain unstaged. Nothing was pushed or deployed.
