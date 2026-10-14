import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["./vitest.worker.config.ts", "./vitest.ui.config.ts", "./vitest.components.config.ts"],
  },
});
