import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// scripts/deploy-worker.ts sets TEMPO_DEPLOY=1; deploys also minify the Worker bundle.
const deploying = process.env["TEMPO_DEPLOY"] === "1";

export default defineConfig({
  build: deploying ? { minify: "oxc" } : {},
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      experimental: { newConfig: true },
    }),
    tailwindcss(),
    tanstackStart({ server: { entry: "./worker.ts" } }),
    react(),
  ],
  resolve: { tsconfigPaths: true },
});
