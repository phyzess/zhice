import { resolve } from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import Inspect from "vite-plugin-inspect";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve("apps/web/dist"),
  build: {
    emptyOutDir: true,
    outDir: resolve("dist/client"),
    rollupOptions: {
      input: resolve("apps/web/dist/index.html"),
    },
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    cloudflare({ configPath: resolve("wrangler.jsonc") }),
    ...(process.env.VITE_INSPECT === "true" ? [Inspect()] : []),
  ],
});
