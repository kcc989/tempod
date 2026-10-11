import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Node-only tests for the UI's pure logic (stores, parsers, shortcut table). */
export default defineConfig({
  resolve: {
    alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["test/ui/**/*.test.ts"],
  },
});
