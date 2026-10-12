// Test entry: the Worker's classes without the TanStack Start handler (a virtual module).
export { WorkspaceDO } from "../../src/do/workspace/index.ts";
export { UserHubDO } from "../../src/do/user-hub.ts";
export { CredentialDO } from "../../src/do/credential.ts";
export { TempoOutbound } from "../../src/egress/outbound.ts";
export { BrowserOutbound } from "../../src/egress/browser-outbound.ts";
export { DirectoryBackupGateway } from "@cloudflare/sandbox";

export default {
  fetch: () => new Response("tempo test worker"),
};
