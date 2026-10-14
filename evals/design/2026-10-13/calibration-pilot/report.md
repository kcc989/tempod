# Calibration pilot: acceptance withheld

The draft questions do not yet distinguish the user-supplied professional references from the user-supplied problem screens reliably. Increasing a pass threshold cannot correct questions that rank a known problem above its reference. No screen or app is accepted from this pilot.

The original user question definitions, scorer and weights remain unchanged. Version 2.1 is a diagnostic split into layout, spacing, color/depth and usability. Version 3 preserves its 51 questions and adds four questions for header overhead, transcript/composer alignment, navigation density and secondary-action disclosure. Version 3 remains a draft with acceptance disabled.

## Evidence and method

Two matched pairs use the user's supplied Conductor and Tempo images: a full workspace pair and a sidebar-only pair. Labels and expected results are retained in the manifest but were not sent to Clef. State describes the app and task neutrally. Historic screenshots have no verified DOM or accessibility text, so page_text was omitted. These are two comparisons, not the required seven references and seven problem screens.

The fixed inputs were submitted three times per question set through Workers AI, model @cf/cloudflare/clef. There are 84 successful requests: 48 for the unchanged 2.1 draft, 24 for the four added questions in applicable frames, and 12 for one corrected-header confirmation. All requested answers were returned. Maximum within-question numeric spread was 0.0000. Repeatability does not establish accuracy or show that the provider produced independent samples.

The first header detail crop excluded branding over the sidebar. The full image still included it. One confirmation used a full-width header crop in both workspace cases, with unchanged questions and source screenshots. The misleading ordering persisted. Further threshold tuning was stopped.

## Results that prevent calibration

All scores below are raw question values on a 0–2 scale, not area averages or overall design scores. Confidence below 0.40 requires review.

| Question and frame                              | Conductor reference | Tempo problem screen | Implication                                                |
| ----------------------------------------------- | ------------------: | -------------------: | ---------------------------------------------------------- |
| Spacing grouping, workspace                     |              1.7899 |               1.8226 | Known problem scores slightly higher.                      |
| Spacing grouping, sidebar                       |              1.8386 |               1.8404 | Almost no separation.                                      |
| Action affordance, sidebar                      |              1.2195 |               1.5351 | Known problem scores higher; both uncertain.               |
| Header overhead, corrected header               |              1.6220 |               1.7266 | Wrong ordering remains; reference uncertain.               |
| Secondary disclosure, corrected header          |              1.7916 |               1.7692 | Small separation despite reported excess controls.         |
| Transcript/composer alignment, corrected header |              1.3159 |               1.2291 | Both answers highly uncertain.                             |
| Navigation density, sidebar supplement          |              1.7094 |               1.0520 | Useful direction, but problem answer confidence is 0.0253. |

Color/depth contrast and several usability answers also remain uncertain. The pilot does not establish a reliable gate for any of the four areas. Raw answers, probabilities, confidence, metadata and exact images are retained beside this report.

## Required next evidence

Use observable questions and measurements for occupied toolbar rows, persistent secondary controls, transcript/input leading edges, row heights, shared padding, surface contrast and available content width. Tie each finding to its region and capture. Use counts or measurements where possible instead of general praise terms. Measure color contrast from actual UI values; screenshot judgment alone does not certify WCAG contrast.

Freeze applicability from verified screen state. Component frames may calibrate component questions; they cannot pass global layout or whole-app navigation. Keep seven comparable reference/problem screen pairs, including varied states and densities, before enabling the replacement. Do not manufacture a pass by adjusting weights or thresholds to these two pairs.

The six public documentation candidates were inspected. They contain component crops, annotations or decorative presentation and have no matched problem tasks yet. They are candidates, not six additional accepted references. Native Conductor and Codex control was blocked by desktop organization policy. Mobbin requires a paid plan; no purchase was made.

## Native capture limit in this continuation

After the user unlocked the Mac, Tempo accessibility responded to opening New workspace and loading the model list. Screenshots repeatedly showed an earlier workspace with a context popover. Reconnecting desktop control did not resolve the mismatch. Those captures are excluded from Clef and visual acceptance. The unsubmitted dialog was dismissed. At the user's request, the app was then closed, rebuilt, signed and relaunched. Saved sign-in and the workspace restored. A fresh workspace capture and New workspace options capture now render. Earlier stale captures remain excluded. The new options capture still shows centered branch rows, contrary to the requested left alignment; it is a remaining UI defect. The on-device Vision OCR attempt failed without producing measurements; no reading-length or alignment measurement is claimed.

No test suite was run. No app change, deployment or overall acceptance is claimed by this report.
