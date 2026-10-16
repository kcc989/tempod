# Research: ACP v1, MCP Apps and T3 Code for Tempo's closed loop

Tempo baseline: repo `/home/user/tempod` at `28a490b4`. I read `docs/01`, `02`, `04`, `08` and `12`, plus `packages/tempod/src/acp/{session,mapper,convert}.ts`.

Sources were cloned on 2026-10-15 into a scratch directory and read only. I ran no code from them.

| Source | Commit | Version |
|---|---|---|
| github.com/agentclientprotocol/agent-client-protocol | `7855babf8bee9db299ce668dfa911289f4d1cf4e` | Schema v1 changelog at 1.11.0 (2026-10-09) |
| github.com/modelcontextprotocol/ext-apps | `82221c0c8ce7661efa6771c9d461511b1650495f` | npm 2.0.3. Spec `specification/2026-01-26/apps.mdx` |
| github.com/pingdotgg/t3code | `26fffe5aee22ea9bdd39c5b4c400f643c560b4a0` | — |
| npm `@agentclientprotocol/claude-agent-acp@0.89.1` | — | Tempo's pinned adapter. I read its `dist` |
| npm `@agentclientprotocol/codex-acp@2.2.2` | — | Bundled binary only; I could not inspect it |

## 1. ACP v1

**Primary sources:** `schema/v1/meta.json`, `schema/v1/schema.json`, `docs/protocol/v1/*.mdx`, `CHANGELOG.md`, `docs/rfds/*`.

### Stable v1 surface compared with Tempo today

| Feature (stable v1) | What the spec says | Tempo now (spec / code) |
|---|---|---|
| `session/update` `plan` | Full list of entries `{content, priority, status}`, sent again as a whole on every change. The client replaces it. | Used. Mapped into a `plan` item (`mapper.ts:259,406`). |
| `tool_call` / `tool_call_update` | Has `kind`, `rawInput`, and content (diff, terminal). | Used. 04 §Plan proposals renders `rawInput.plan` (for example `ExitPlanMode`) as a Plan card with the permission buttons beneath it. |
| `session/request_permission` | Options with kind `allow_once`, `allow_always`, `reject_once` or `reject_always`. | Used (01 §Permission requests, `session.ts:189`). It waits with no limit and the workspace shows `needs_input`. |
| Session modes and `session/set_mode`, `current_mode_update` | Marked deprecated in favour of config options, but still stable ("will be removed in a future version"). | Used for agents that expose modes (`session.ts:603`). Plan mode is `plan` for Claude and OpenCode, `read-only` for Codex, and none for Pi (01). |
| `session/set_config_option`, `config_option_update` | Categories `mode`, `model` (stable since 1.1.0), `thought_level`, and `_`-prefixed custom categories. | Used for mode, model and thought level (`session.ts:614`). |
| `available_commands_update` | Slash commands. | Used. |
| `session_info_update`, `usage_update`, `notice` | `notice` became stable in 1.11.0. | Used. |
| `compaction_update`, `compaction_summary_chunk` | Became stable in 1.11.0. | **Not used.** They hit the "unsupported session/update dropped" warning in `mapper.ts`, and 02:630 forbids advertising `session.compaction`. |
| `elicitation/create` and `elicitation/complete` (Client methods) | Stable since **1.7.0** (2026-08-20, #1779). Form mode is a flat restricted JSON Schema and the reply is `accept`, `decline` or `cancel`. URL mode is for OAuth-style flows. Forms MUST NOT collect secrets. | **Not used, and forbidden.** 02:630 says tempod "MUST NOT advertise `terminal`, `elicitation`…". |
| `terminal/*` | The client runs commands for the agent. | Not advertised (`session.ts:62 terminal:false`). |
| `fs/read_text_file` and `fs/write_text_file` | — | Used. |
| `mcpServers` in `session/new` and `session/load` (stdio, http, sse) | — | Used: Playwright, then `tempo`, then the user's servers, with the tempod HTTP/SSE bridge. |
| `_meta` on every request, response, tool call, plan entry and content block | Custom keys must not go at the root of a type. Root `_meta` keys `traceparent`, `tracestate` and `baggage` are reserved. `_`-prefixed method names are for extensions. | Used on `session/new` (profile `systemPrompt` and tools) and on `initialize` (`steering`). **Dropped on updates:** `convert.ts:132` removes `_meta` from every update it converts. |

### Not stable, and so out of bounds for Tempo

These are unstable v1 or draft v2 only:

- `plan_update` and `plan_removed` (RFD `plan-operations`: markdown and file plans, several plans at once).
- MCP-over-ACP `mcp/message` (`"type":"acp"` servers).
- `session/fork`.
- Boolean config options (RFD).
- Client-provided `systemPrompt` (RFD).

Tempo's rule against using v2 also rules these out until they are stabilized.

### Pinned adapter evidence (claude-agent-acp 0.89.1)

- **Plan approval:** `dist/permissions/options/tools.js` `buildExitPlanModePermissionOptions` sends a permission request titled "Ready to code?". The options are "Yes, clear context and use auto mode", "Yes, and use auto mode", "Yes, auto-accept edits" and "No". This is already a one-action confirm gate.
- **Questions as forms:** `dist/acp-agent.js:6448` turns Claude's `AskUserQuestion` tool into an ACP **form elicitation**, but only if `clientCapabilities.elicitation.form` is set. It also forwards MCP-server elicitations, and uses URL mode only if `elicitation.url` is set.

Because Tempo does not advertise elicitation, Claude's clarifying questions cannot appear as structured forms. What the adapter falls back to when elicitation is missing is UNVERIFIED.

I did not inspect codex-acp 2.2.2, OpenCode or pi-acp for elicitation or plan-permission behaviour (UNVERIFIED). Spike S18 in 04 already tracks who sends `rawInput.plan`.

### How Tempo could build the intent check and capture proof on ACP v1

| Need | ACP v1 mechanism | Gap or work | Friction reduced |
|---|---|---|---|
| Agent states goal, approach and non-goals in ≤5 lines, and the user confirms in one action | **(a)** Start the turn in plan mode (`set_config_option`/`set_mode`), then rely on the existing ExitPlanMode Plan card plus permission. This works today for Claude; OpenCode and Codex are UNVERIFIED. **(b) Agent-neutral option:** a new `tempo` MCP tool (for example `confirm_intent {goal, approach, nonGoals}`) that blocks until the user answers. This copies the existing pattern where tempod answers the permission for `report_result` (08:263). **(c)** Advertise `elicitation.form` so the adapters can ask through forms. | (a) Pi has no plan mode, and the ≤5-line format cannot be enforced. (b) Needs a spec change in 01, 04 and 07 (rule 17: the Mac client changes with the UI). (c) Needs 02:630 changed and a form renderer added to the UI and Mac client. | DIRECTION (main), ACCESS_UNAWARE |
| Structured clarifying questions | `elicitation/create` form mode | Forbidden by 02:630 today | DIRECTION, UNCLEAR_IMPL |
| Live progress in the preview | `plan` entries already shown | None | VERIFY (small effect) |
| Proof shown with a tool call (for example screenshot ids or check results) | `_meta` on `tool_call` and `tool_call_update` | `convert.ts` drops `_meta`. The proof needs its own namespaced key such as `_meta["tempo/proof"]`, which needs a spec change. A tempo MCP tool is simpler. | VERIFY |
| Tracing from a production error back into a session | Reserved `_meta.traceparent` on `session/prompt` | Not used. Could link a deploy or observe event to the turn it seeds. | VERIFY |
| Context compaction notice | `compaction_update` (stable 1.11.0) | Dropped. Low value for this loop. | — |

**Caveat:** Tempo pins `@agentclientprotocol/sdk` 1.8.0. Whether that SDK version contains the elicitation types, which became stable in schema 1.7.0, is UNVERIFIED. The schema repo and the TypeScript SDK have separate version numbers.

## 2. MCP Apps (SEP-1865)

**Primary source:** `ext-apps/specification/2026-01-26/apps.mdx`.

| Item | What it says |
|---|---|
| Status | "Status: Stable (2026-01-26)". Track: Extensions. Created 2025-11-21. Extension id `io.modelcontextprotocol/ui`. A `draft/apps.mdx` already adds "App-Provided Tools" (the app registers its own tools); that part is draft only. |
| License | Moving from MIT to Apache-2.0; documentation is CC-BY-4.0. Compatible with MIT Tempo. |
| Package | `@modelcontextprotocol/ext-apps` 2.0.3 |
| UI resource | URI must be `ui://…`. MIME type is `text/html;profile=mcp-app`; the task's "text/html+mcp" is the older name. `_meta.ui.csp {connectDomains, resourceDomains, frameDomains, baseUriDomains}`, plus optional `domain` and `permissions`. |
| Linking a tool to a UI | Tool `_meta.ui.resourceUri` (the flat `"ui/resourceUri"` form is deprecated) and `_meta.ui.visibility: ["model","app"]`. A host MUST hide tools that are app-only from the model, and MUST reject app calls to tools that are model-only. |
| Protocol | JSON-RPC 2.0 over `postMessage`; the iframe acts as an MCP client of the host. `ui/initialize` returns host context (theme CSS variables, container dimensions, display modes). Messages: `ui/open-link`, `ui/message` (adds a user message), `ui/update-model-context`, `ui/request-display-mode`. Notifications: `tool-input`, `tool-input-partial`, `tool-result`, `tool-cancelled`, `resource-teardown`. The app may call `tools/call` back to its own server. |
| Sandboxing | A web host MUST use a sandbox proxy on a **different origin** with `allow-scripts allow-same-origin`. The proxy loads the HTML under a CSP built from the declared domains, defaulting to `frame-src 'none'`, `object-src 'none'` and a restrictive default. The Threat Model section covers auditable messages and pre-declared resource review. |

### Fit with Tempo

In Tempo the **MCP host is the agent adapter, not Tempo**. ACP v1 has no standard way to pass `_meta.ui.resourceUri` or a `ui://` resource to the client:

- claude-agent-acp 0.89.1 has no mention of `resourceUri` or `mcp-app` (checked by grep).
- MCP-over-ACP, which would let Tempo serve tools to the agent, is unstable.

So MCP Apps can render in Tempo only in two ways:

- **(a)** The `tempo` MCP server: tempod owns it, so it can map its own `ui://` resources to a Tempo item itself, without going through ACP.
- **(b)** Codex app-server, which reports `mcpAppUi.resourceUri` on `mcpToolCall` items. T3 Code relies on this; see section 3.

| What it would let Tempo do | Today in Tempo | Friction | Risk |
|---|---|---|---|
| Interactive proof panels: a screenshot gallery with pass/fail checks, a design-critique checklist the user ticks, and an intent card whose Confirm button calls `tools/call confirm_intent`. | `publish_artifact` (01 §Artifacts) already shows **offline single-file HTML** on a separate artifact origin (05). It is one-way, with no host messages and no tool calls back. | VERIFY, DESIGN_IGNORED, DIRECTION | New host surface: postMessage bridge, a sandbox-proxy origin, CSP building, and the same work again in the Mac client (rule 17). App→tool calls must go through the same permission and profile checks. |
| Deploy panel: status, logs and Redeploy inside the chat, using the 12 deploy tools from a `visibility:["app"]` tool. | 12 has a separate Deployments UI plus four `tempo` MCP tools. | EXIT_CF_DASHBOARD, VERIFY | An app-only tool that triggers a deploy is a privileged action started from agent-written HTML. It needs explicit confirmation. |
| Third-party MCP servers that ship UIs | Not supported. | — | Would need an ACP extension, or waiting for MCP-over-ACP. Each new dependency also needs approval (rule 11). |

**Recommendation:** extend the existing artifact path instead of becoming a general MCP Apps host. The shape could be `publish_artifact` with a typed "proof" kind, or a single Tempo-owned `ui://` resource for the `tempo` server.

## 3. T3 Code (pingdotgg/t3code)

**LICENSE (read in full, 21 lines):** "MIT License — Copyright (c) 2026 T3 Tools Inc." It is the standard MIT grant to use, copy, modify, merge, publish, distribute, sublicense and sell. The one condition is that the copyright and permission notice must be included in all copies or substantial portions. It is provided "AS IS" with no warranty or liability. `apps/server/package.json` also says `"license": "MIT"`. The repo has a `third-party-licenses.config.json`, which I grepped for AGPL/GPL with no hits; that check was not exhaustive.

**Consequence:** Tempo (also MIT) *may* copy code from it, as long as it keeps T3's notice. It is not AGPL like SAM. Rule 11 (approve every new library) and the stack rules (Effect Schema in `packages/protocol`, the Sandbox SDK model) still apply, so in practice the value is ideas and small adapted snippets.

### How it drives agents

T3 is local-first, which is a different architecture from Tempo's containers.

| Agent | Mechanism (evidence) |
|---|---|
| Claude | `@anthropic-ai/claude-agent-sdk ^0.3.276` called directly (`apps/server/package.json`; `orchestration-v2/Adapters/ClaudeAdapterV2.ts`). Not ACP. |
| Codex | **`codex app-server`**, using its own generated `packages/effect-codex-app-server`. Not ACP. |
| Cursor, Grok, OpenCode, Pi, Antigravity, registry agents | ACP through its own Effect implementation `packages/effect-acp` (tests use `protocolVersion: 2`, and there is a `compat.ts`) and `provider-acp-registry`. It handles `elicitation/create` (`client.test.ts:53`). |

### Features relevant to the loop

| T3 feature | Where | Tempo equivalent | Reusable idea (MIT) | Friction |
|---|---|---|---|---|
| Plan card with Implement / Refine actions | `apps/web/src/components/chat/ProposedPlanCard.tsx`, `ComposerPlanFollowUpBanner.tsx` | 04 Plan proposals card | Follow-up banner after a plan, with one-click "implement" | DIRECTION |
| Pending approval and user-input panels docked in the composer | `ComposerPendingApprovalPanel.tsx`, `ComposerPendingUserInputPanel.tsx` (renders elicitation forms) | Permission buttons under the item | Put the intent confirm in the composer, keyboard first | DIRECTION |
| Checkpoints as hidden Git refs, with diff per turn and rollback | `apps/server/src/checkpointing/CheckpointStore.ts`, `orchestration-v2/Checkpoint{Capture,Rollback,RestoreSafety}Service.ts` | Tempo has its own checkpoints (03) | "Restore safety" checks before a rollback | VERIFY |
| Diff panel with a changed-files tree and worker-pool diffing | `DiffPanel.tsx`, `ChangedFilesTree.tsx`, `DiffWorkerPoolProvider.tsx` | 04 diff views | Worker-pool diff rendering | VERIFY |
| **Agent-driven preview browser** as MCP tools: `preview_open`, `navigate`, `snapshot`, `click`, `type`, `resize`, `set_appearance`, `evaluate`, `wait_for`, `recording_start` / `recording_stop` | `apps/server/src/mcp/toolkits/preview/tools.ts`, `contracts/src/previewAutomation.ts`, `PreviewAutomationBroker.ts` | Playwright MCP against `localhost:<port>` (01). Images in tool results are shown but are not kept unless published. | Proof tools that **record video** and check phone width and both themes. These could be Tempo `tempo` MCP tools that save screenshots and recordings as artifacts automatically. | VERIFY, DESIGN_IGNORED |
| `html_preview` (render HTML in headless Chrome, return PNG + content height + console output) and an inline-HTML show tool | `mcp/toolkits/html/tools.ts`, `htmlRender/HtmlRender.ts` | `publish_artifact` HTML | Agent checks its own proof page before publishing it (≈390 px phone check) | DESIGN_IGNORED, VERIFY |
| **MCP Apps host** | `apps/web/src/components/chat/McpAppFrame.tsx` (iframe `sandbox="allow-scripts allow-forms"`, deliberately **without** `allow-same-origin`), `apps/server/src/mcpApps/*`; Codex `mcpAppUi.resourceUri` in `CodexAdapterV2.ts:480` | None | Sandbox choice that differs from the spec. The spec requires a separate-origin proxy with `allow-same-origin`; T3 uses an opaque origin instead. Worth checking against SEP-1865 before copying. | VERIFY |
| Source-control providers for GitHub, GitLab, Forgejo and others; PR rows in thread details | `packages/source-control-*`, `ThreadDetailsPrRow.tsx` | 09 Git Forge | PR status shown inside the thread | EXIT_GITHUB |

I found no T3 feature for deploy, observation, or turning production errors into sessions. I searched only the directory names (`preview`, `htmlRender`, `mcpApps`, `checkpointing`), so this is UNVERIFIED beyond that.

## Summary: what each source unlocks

| Source | Unlocks for Tempo | Already in Tempo | Main friction reduced | Blocker |
|---|---|---|---|---|
| ACP v1 elicitation (stable 1.7.0) | Structured intent and clarifying forms from Claude (`AskUserQuestion`) and from MCP servers | No; forbidden by 02:630 | DIRECTION, UNCLEAR_IMPL | Spec change in 02, 04 and 07. SDK 1.8.0 support is UNVERIFIED. |
| ACP plan mode + ExitPlanMode permission | One-action plan confirmation | Yes (04 Plan proposals) | DIRECTION | Not agent-neutral (Pi has none; Codex and OpenCode UNVERIFIED) |
| `tempo` MCP `confirm_intent` (Tempo-owned, modelled on `report_result`) | Agent-neutral ≤5-line intent gate | No | DIRECTION | New spec (01, 04, 07, 08) |
| ACP `_meta` on tool calls and `traceparent` | Proof and trace metadata travelling with each item | Dropped by `convert.ts` | VERIFY | Spec change |
| MCP Apps (stable 2026-01-26) | Interactive proof and deploy panels | Offline HTML artifacts only | VERIFY, DESIGN_IGNORED, EXIT_CF_DASHBOARD | No ACP path for third-party UIs; sandbox-origin work; Mac parity |
| T3 Code (MIT) | Preview automation with recording, `html_preview` self-check, composer approval panels, restore-safety checks | Partial (Playwright MCP, artifacts) | VERIFY, DESIGN_IGNORED, DIRECTION | Rule 11 (library approval). Different architecture (local, Claude Agent SDK, codex app-server). |

None of these sources directly helps STACK, CI_SLOW, CF_PERMS or API_KEYS.

### UNVERIFIED items

- codex-acp 2.2.2, OpenCode and pi-acp: behaviour for plan permissions, elicitation and `rawInput.plan`.
- Whether `@agentclientprotocol/sdk` 1.8.0 exports the elicitation types.
- What claude-agent-acp does with `AskUserQuestion` when elicitation is not advertised.
- Whether T3 Code has deploy or observation features.
- Whether T3's no-`allow-same-origin` frame meets SEP-1865 conformance.
