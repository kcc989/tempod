# First project: smart todo list

The loop is first proven on this project (13, First project). Tempo builds it; this folder holds what the owner pastes into Tempo once. Both files pass `parseProfile` and `parseDeployConfig`.

## Set up (once, in Tempo)

1. Create a native (Tempo-hosted) project named `smart-todo`.
2. Settings → Cloudflare: add the account and the deploy token (12). Settings → Cloudflare → TypeSafe AI: add the key (Jev judge, 13 L-ADR-9).
3. Create an environment for the project with the secret `TYPESAFE_API_KEY`, hosts `api.typesafe.ai`. The app's own Jev calls use it through `tempo-secret-TYPESAFE_API_KEY`; the key never enters the container.
   For the deployed app, put the same key once in Cloudflare Secrets Store and bind it to the Workers in `alchemy.run.ts`; the deploy token has `secrets_store`, so the key never passes through the deploy container either.
4. Project settings → Agent → Project profile (Profile YAML): paste [profile.yaml](profile.yaml).
5. The repository's Deploys tab: paste [deploy.yaml](deploy.yaml) as the deploy configuration. Cloudflare permissions are not in it: the agent asks for them in the chat (for example `d1` and `secrets_store`), and you approve them there. Add `smoke` URLs to `production` once the domain exists.
6. In Cloudflare, add a Workers Issues automation that sends to the webhook URL shown in the Deploys tab (Production errors) (13, L-ADR-5).

## First prompt

Start a chat in a new workspace and send:

```text
Build a smart todo list in apps/web:
- Todos: create, edit, complete, delete and order. Desktop and phone width.
- Owner-only sign-in with Better Auth; MCP over OAuth through Better Auth, with tools to list, create, update, complete and tag todos.
- Smart tagging: when a todo changes, ask Jev (jev-1.14.0, @typesafe-ai/sdk 0.7.0) one choice question per tag group from my tag list.
- Background research: a ResearchDO Durable Object searches with env.AI.websearch and attaches the best results, ranked by Jev.
Deploy with Alchemy v2: the Workers in deploy.yaml, a D1 database, and the ResearchDO.
Submit proof for each screen in profile.yaml.
```

The intent check (13, L-ADR-1) asks the agent for a 5-line intent first. New bindings and a new database are new access, so Tempo asks you to confirm.
