import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  cacheDir: "node_modules/.vite_cache",
  plugins: [cloudflare()],
  build: {
    target: "es2022",
  },
  server: {
    fs: {
      strict: false,
    },
  },
});
