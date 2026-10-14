# Freestanding workspace Info correction: native shape confirmed

The user requested a freestanding panel like the Codex reference. Info was previously a full-height tool tab. It now uses a separate 360 px/pt rail, 12 px/pt outer space, a content-height muted card, 16 px/pt padding and 16 px/pt corners. It has no tool tab bar. Workspace controls are a disclosure. Related tools retain their tabs and saved width. Web and Mac specs changed together in 52b026c.

## Native evidence

The first installed card build exposed a major layout regression: the workspace shrank vertically and left a large blank area above it. That capture is retained in `dark/info-height-regression` and is rejected. Explicit full height on the resizable wrapper and Info rail corrected it.

The corrected application build passed. Tempo was quit, installed, signed and relaunched through desktop control. App and Keychain-helper identities match. Fresh full-window captures in `dark/info-freestanding` show the compact card at the top of the rail, with space below. The controls disclosure, base-branch accessible name, Close Info, transitions to Changes and Guides, retained tabs and restored tool width were confirmed. Wake, guide authoring, archive, preview reset and external review submission were not performed.

No tests or native test targets ran. Web type checking and changed-file lint passed for the feature. The height-only correction built successfully. Seven-pair calibration and all-core-screen acceptance remain incomplete.

## Four stateless area reviews

Four before and four after requests returned HTTP 200 and all 51 unchanged draft-v2.1 area answers. Full frames and detail crops remain in each capture folder. There is no overall or area acceptance score. Comparisons include changes in the chat pane width and cannot isolate every answer to the Info card.

| Area        | Result retained                                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layout      | Needs work: panel space-fit probability changed from 0.1753 to 0.2268 and remains low. Clef supplies no location-specific reason.                                |
| Spacing     | Grouping, alignment and consistency answers increased slightly; the uncalibrated rubric does not establish a pass.                                               |
| Color/depth | Tonal layers confidence is 0.7288. Secondary contrast remains review, confidence 0.0386.                                                                         |
| Usability   | Several answers remain uncertain. Affordance increased, but primary-path and navigation answers declined. The shape correction does not establish a screen pass. |

Original-question interactions show controls selected probability 0.7053, with uncertain overall feedback confidence 0.1093. Keyboard focus is `visible`, confidence 0.8446. The same Tab pair has a low, uncertain generic action-feedback score, which is retained rather than suppressed. The full answers, uncertainty list and comparisons are in `dark/info-freestanding/review.json`.

The first interaction submissions failed validation because JPEG screenshot bytes were labelled PNG. Those HTTP 422 attempts are retained under `invalid-image-requests`. Re-encoding unchanged pixels as PNG corrected the request; both Info interaction requests then returned HTTP 200. Provider failures are not design evidence.

The user's Codex screenshot was used locally only, not sent to Clef. No screen or app is marked accepted.
