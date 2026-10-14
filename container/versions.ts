import { Schema } from "effect";

const ContainerVersions = Schema.StructWithRest(
  Schema.Struct({
    base_image: Schema.String,
    base_image_digest: Schema.NullOr(Schema.String),
    sandbox_shim: Schema.String,
    npm: Schema.Record(Schema.String, Schema.String),
    build_args: Schema.Record(Schema.String, Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const readContainerVersions = Schema.decodeUnknownSync(Schema.fromJsonString(ContainerVersions));
