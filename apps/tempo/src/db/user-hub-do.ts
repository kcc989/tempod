import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const summaries = sqliteTable("summaries", {
  workspaceId: text("workspace_id").primaryKey(),
  summaryJson: text("summary_json").notNull(),
  rev: integer("rev").notNull(),
});

export const userHubSchema = { summaries };
