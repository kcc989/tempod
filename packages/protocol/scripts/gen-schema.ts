import { JsonSchema, Predicate, Schema, SchemaAST } from "effect";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { API_FUNCTIONS, WIRE_TYPES, type TypeRef } from "./wire.ts";
import { formatFiles, repoRoot, run, stableJson } from "./util.ts";

/**
 * `bun run protocol:gen` (07): writes one JSON Schema Draft-07 file per wire type to
 * packages/protocol/schema/, then runs crates/protocol-gen to write the Rust types.
 */

const schemaDir = join(repoRoot, "packages/protocol/schema");

const generatedRs = join(repoRoot, "crates/tempo-protocol/src/generated.rs");

type Json = JsonSchema.JsonSchema;

// toJsonSchemaDocument hands the reference policy the canonical JSON codec's AST, so every form is keyed.
const nameByAst = new Map<SchemaAST.AST, string>();

for (const [name, schema] of WIRE_TYPES) {
  const codec = Schema.toCodecJson(schema).ast;

  for (const ast of [schema.ast, codec, SchemaAST.toEncoded(codec)]) {
    if (!nameByAst.has(ast)) nameByAst.set(ast, name);
  }
}

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray => Array.isArray(value);

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject => Predicate.isObject(value);

const isString = (value: Schema.Json): value is string => Schema.is(Schema.String)(value);

const relink = (node: Schema.Json): Schema.Json => {
  if (isJsonArray(node)) return node.map(relink);

  if (!isJsonObject(node)) return node;
  const out: Record<string, Schema.Json> = {};

  for (const [k, v] of Object.entries(node)) {
    if (k === "$ref" && isString(v) && v.startsWith("#/definitions/")) {
      out[k] = `${decodeURIComponent(v.slice("#/definitions/".length))}.json`;
    } else out[k] = relink(v);
  }

  return out;
};

const toDraft07 = (name: string, schema: Schema.Top) => {
  const doc = JsonSchema.toDocumentDraft07(
    Schema.toJsonSchemaDocument(schema, {
      referencePolicy: ({ ast }) => {
        const n = nameByAst.get(ast);

        return n === name ? undefined : n;
      },
    }),
  );

  const definitions: Record<string, Json> = {};

  for (const [k, v] of Object.entries(doc.definitions)) {
    // SAFETY: relink changes only local $ref strings and preserves every JSON Schema keyword.
    definitions[k] = relink(Schema.decodeUnknownSync(Schema.Json)(v)) as Json;
  }

  // SAFETY: the root receives the same reference-only rewrite as definitions above.
  const root = relink(Schema.decodeUnknownSync(Schema.Json)(doc.schema)) as Json;

  return { root, definitions } satisfies { root: Json; definitions: Record<string, Json> };
};

const roots = new Map<string, Json>();

const references: Array<{ readonly from: string; readonly name: string; readonly schema: Json }> = [];

for (const [name, schema] of WIRE_TYPES) {
  const { root, definitions } = toDraft07(name, schema);
  roots.set(name, root);

  for (const [ref, def] of Object.entries(definitions))
    references.push({ from: name, name: ref, schema: def });
}

// Each referenced type must be a wire type whose own file has the same schema.
for (const { from, name, schema } of references) {
  const own = roots.get(name);

  if (!own) throw new Error(`${from} refers to ${name}, which is not a registered wire type`);

  if (stableJson(own) !== stableJson(schema))
    throw new Error(`${from} sees ${name} differently from ${name}.json`);
}

const META = "http://json-schema.org/draft-07/schema#";

const refOf = (t: TypeRef): Json =>
  t.kind === "named" ? { $ref: `${t.name}.json` } : { type: "array", items: { $ref: `${t.name}.json` } };

const api: Json = {
  $schema: META,
  title: "Api",
  description:
    "Server functions at POST /api/v1/rpc/<name>: the HTTP method of the web wrapper, the input and the output.",
  type: "object",
  properties: Object.fromEntries(
    API_FUNCTIONS.map((f) => [
      f.name,
      {
        type: "object",
        properties: { method: { const: f.method }, input: refOf(f.input), output: refOf(f.output) },
        required: ["method", "input", "output"],
        additionalProperties: false,
      },
    ]),
  ),
  required: API_FUNCTIONS.map((f) => f.name),
  additionalProperties: false,
};

mkdirSync(schemaDir, { recursive: true });

for (const f of readdirSync(schemaDir)) if (f.endsWith(".json")) rmSync(join(schemaDir, f));

const written: string[] = [];

const write = (name: string, body: Json): void => {
  const path = join(schemaDir, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  written.push(path);
};

for (const [name, root] of roots) write(name, { $schema: META, title: name, ...root });

write("Api", api);

formatFiles(written);

run(["cargo", "run", "--quiet", "-p", "protocol-gen", "--", schemaDir, generatedRs]);

console.log(
  `protocol:gen wrote ${written.length} schema files and ${generatedRs.slice(repoRoot.length + 1)}`,
);
