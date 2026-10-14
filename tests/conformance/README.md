# Adapter conformance tests

Checks that each agent adapter in the image still behaves the way `tempod` drives it (01, Agents
and Sessions). Run them after every agent upgrade: change `container/versions.json`, rebuild the
image, run these tests inside it (05, Agent upgrades; AGENTS.md rule 14).

`bun test` runs one file per agent. An agent's tests are skipped when its binary is not on `PATH`
(`Bun.which`), so the suite passes, all skipped, on a machine without the adapters.

| Agent      | Binary             | Command (cwd = a temp git repo standing in for `/workspace`) |
| ---------- | ------------------ | ------------------------------------------------------------ |
| `claude`   | `claude-agent-acp` | `claude-agent-acp`                                           |
| `codex`    | `codex-acp`        | `codex-acp`, with `INITIAL_AGENT_MODE=agent-full-access`     |
| `opencode` | `opencode`         | `opencode acp --cwd <dir>`                                   |
| `pi`       | `pi-acp`           | `pi-acp`, with `PI_CODING_AGENT_SESSION_DIR`                 |

## What each agent must do

The client is the ACP v1 SDK (`@agentclientprotocol/sdk` 1.8.0) over stdio with `ndJsonStream`,
set up like `tempod`'s: `session/update` notifications are read raw, permission requests are
answered with an `allow` option (`allow_once` first), and `fs/read_text_file` and `fs/write_text_file` are served
only inside the repo.

1. `initialize` with `protocolVersion: 1` and `clientCapabilities` `fs.readTextFile`,
   `fs.writeTextFile`, `terminal: false` and `session.notices` answers `protocolVersion: 1`.
   `agentCapabilities` is recorded; `loadSession` must be a boolean, and `true` for the agents
   where 01 says `session/load` works (claude, codex, pi).
2. `session/new` with the Playwright MCP server (`PLAYWRIGHT_MCP_SERVER` from `@tempo/protocol`)
   returns a session id, the modes of 01 (from the `mode` config option when advertised, otherwise the session modes response) (claude: `auto` and `plan`; codex:
   `agent-full-access` and `read-only`, starting in `agent-full-access`; opencode: `build` and
   `plan`) and a config option with category `model`.
3. Setting Tempo's default mode through the advertised `mode` config option (`session/set_config_option`), or through `session/set_mode` when session modes are exposed (claude `auto`, codex
   `agent-full-access`, otherwise the agent's current mode) succeeds. Pi reports no modes, which is
   recorded.
4. `session/load` in a new adapter process, when advertised. The result is recorded: before any
   turn an agent may have nothing on disk to load.
5. The `session/cancel` notification is accepted and the connection still answers requests.

With `CONFORMANCE_LIVE=1` (needs model credentials) each agent also:

6. Gets one prompt that asks it to create a file: a `tool_call` update arrives, the turn ends with
   `end_turn`, and the file exists with the right content.
7. Gets a long prompt that is cancelled after its first update: the turn ends with `cancelled`
   within 10 s (tempod kills the adapter after 10 s).
8. Reloads the session with `session/load` in a new process; for claude, codex and pi it must work.

## Running

```bash
cd tests/conformance
bun test                       # every agent whose binary is on PATH
bun test test/codex.test.ts    # one agent
CONFORMANCE_LIVE=1 bun test    # with prompts
```

Inside the image (`HOME=/home/tempo`), the agents use their usual config directories. Credentials
come from the environment: `CLAUDE_CODE_OAUTH_TOKEN` for claude, `$CODEX_HOME/auth.json` for codex,
`OPENROUTER_API_KEY` for opencode and pi (defaults to the placeholder `tempo-placeholder`, which only
`TempoOutbound` can swap, so live runs outside a Tempo container need a real key).

| Variable                                                 | Use                                                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `CONFORMANCE_LIVE=1`                                     | Run the prompt tests                                                                                 |
| `CONFORMANCE_MODEL_CLAUDE`, `_CODEX`, `_OPENCODE`, `_PI` | Model value set with `session/set_config_option` before the live prompt (needed for opencode and pi) |
| `CONFORMANCE_REPORT_DIR`                                 | Also write each agent's report to `<dir>/<agent>.json`                                               |

Each agent's report (capabilities, modes, config options, `session/load` outcomes, live turn
updates) is printed at the end of its file. Keep it with the upgrade's pull request.
