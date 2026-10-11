import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/d1.ts",
  out: "./src/db/migrations",
});
