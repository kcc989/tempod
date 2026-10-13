import { Schema } from "effect";

/** Fields Tempo consumes from GitHub's REST API, validated at the HTTP boundary. */
export const GhInstallation = Schema.Struct({
  id: Schema.Number,
  account: Schema.NullOr(Schema.Struct({ login: Schema.String, type: Schema.String })),
  suspended_at: Schema.NullOr(Schema.String),
});

export type GhInstallation = typeof GhInstallation.Type;

export const GhRepo = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  owner: Schema.Struct({ login: Schema.String }),
  default_branch: Schema.String,
  private: Schema.Boolean,
});

export type GhRepo = typeof GhRepo.Type;

export const GhPull = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  draft: Schema.Boolean,
  merged: Schema.optional(Schema.Boolean),
  merged_at: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  head: Schema.Struct({
    ref: Schema.String,
    sha: Schema.String,
    repo: Schema.NullOr(Schema.Struct({ id: Schema.Number })),
  }),
  base: Schema.Struct({ ref: Schema.String }),
});

export type GhPull = typeof GhPull.Type;

export const GithubErrorBody = Schema.Struct({
  message: Schema.optional(Schema.String),
  errors: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.String,
        Schema.Struct({
          message: Schema.optional(Schema.String),
          code: Schema.optional(Schema.String),
        }),
      ]),
    ),
  ),
});

export type GithubErrorBody = typeof GithubErrorBody.Type;
