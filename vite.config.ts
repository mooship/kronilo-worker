import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  cacheDir: ".vite_cache",
  optimizeDeps: {
    include: ["hono", "openai", "@hono/swagger-ui"],
  },
  plugins: [cloudflare()],
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules/hono")) {
            return "hono";
          }
          if (id.includes("node_modules/@hono")) {
            return "swagger";
          }
          if (id.includes("node_modules/openai")) {
            return "openai";
          }

          return "vendor";
        },
      },
    },
  },
});
