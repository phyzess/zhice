import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    cloudflareTest({
      main: "./apps/worker/src/index.ts",
      additionalExports: {
        MaterialCoordinator: "DurableObject",
        PdfWorkflow: "WorkflowEntrypoint",
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["test/worker/**/*.test.ts"],
  },
});
