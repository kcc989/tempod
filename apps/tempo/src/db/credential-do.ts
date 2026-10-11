import { blob, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const secrets = sqliteTable("secrets", {
  key: text("key").primaryKey(),
  ciphertext: blob("ciphertext", { mode: "buffer" }).$type<ArrayBuffer>().notNull(),
  iv: blob("iv", { mode: "buffer" }).$type<ArrayBuffer>().notNull(),
  version: integer("version").notNull(),
  metaJson: text("meta_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const codexLeases = sqliteTable("codex_leases", {
  workspaceId: text("workspace_id").primaryKey(),
  since: integer("since").notNull(),
});

export const credentialSchema = { secrets, codexLeases };
