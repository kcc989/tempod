---
version: 1
slug: "c-ui-components-shell-workspacelayout-tsx-2b13a55e"
primary_target: "apps/tempo/src/ui/components/shell/WorkspaceLayout.tsx"
related_targets: ["apps/mac/src/views/tools.rs"]
---

# Workspace tools

Mode: Operate. Scope: workspace layout in the web and native Mac clients. Keep the existing Tempo palette, type, composer, protocols and tool behavior.

## Direction contract

THESIS: Keep chat and its composer visible while the user works with files, diffs, processes and Cloudflare Browser Run.

OWN-WORLD: Existing system font at 13 px/pt, neutral theme surfaces, one-pixel dividers, existing icon family and compact native controls.

STORY: Select a workspace and chat on the left; open a tool beside the conversation. Every existing review and process action stays reachable.

FIRST VIEWPORT: Sidebar, center transcript/composer, and one full-height resizable right tool area. One tab bar owns that area. Its plus tab opens Files, Terminal, Browser, Changes, Checks, Artifacts, Setup and Run. File, diff and artifact documents share the tool tab bar.

FORM: The user supplied the Codex layout in two screenshots; no seed is needed for this precisely specified layout change. Browser is the Cloudflare Browser Run hosted live view, with no general Mac browser.

FINISH: Review the changed surfaces and record the result, test evidence and open acceptance gates. Update the source-truth specs and UI contract. This scoped extension retains the incumbent tokens and CSS. The repo has no PRODUCT.md or DESIGN.md baseline; document that gap without creating a new visual system. No raster assets ship in this change.

## Evidence boundary

The synthetic real-component web captures are `.impeccable/review/desktop.png`, `file.png` and `mobile.png`. They establish local fixture rendering only. Native capture is blocked by the organization's Computer Use policy. Native visual review and hosted Browser Run acceptance remain open. Cleanup resolved the shared engine's free-disk gate. Full Linux CI stopped in oxlint's allocator with SIGABRT; source lint passes on macOS. Separate Linux typecheck and the complete root test command passed.
