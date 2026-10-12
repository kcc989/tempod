import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: [
      { find: "~/ui/lib/api", replacement: fileURLToPath(new URL("./api.ts", import.meta.url)) },
      { find: "~", replacement: fileURLToPath(new URL("../../src", import.meta.url)) },
    ],
  },
});
