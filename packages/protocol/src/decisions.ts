import { Schema } from "effect";

const P = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

export const ClefRequest = Schema.Struct({
  model: Schema.Literal("clef-flash"),
  state: Schema.String.check(
    Schema.makeFilter((s) => new TextEncoder().encode(s).length <= 32768 || "state exceeds 32 KiB"),
  ),
  questions: Schema.Record(
    Schema.String,
    Schema.Struct({ type: Schema.Literal("noul"), instructions: Schema.String }),
  ).check(Schema.makeFilter((q) => Object.keys(q).length <= 64 || "too many questions")),
});

export type ClefRequest = typeof ClefRequest.Type;

export const ClefResponse = Schema.Struct({
  answers: Schema.Record(Schema.String, Schema.Struct({ type: Schema.Literal("noul"), noul: P })),
});

export type ClefResponse = typeof ClefResponse.Type;
