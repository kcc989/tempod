import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      configPath: process.env["TEMPO_WRANGLER_CONFIG"] ?? "./wrangler.jsonc",
    }),
    tailwindcss(),
    tanstackStart({ server: { entry: "./worker.ts" } }),
    react(),
  ],
  resolve: { tsconfigPaths: true },
});
