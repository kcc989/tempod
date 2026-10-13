import { Schema } from "effect";

/** The fields Tempo requires from the file written by codex login (02, Credentials). */
export const CodexAuthFile = Schema.Struct({
  tokens: Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String }),
  last_refresh: Schema.String,
});

export type CodexAuthFile = typeof CodexAuthFile.Type;
