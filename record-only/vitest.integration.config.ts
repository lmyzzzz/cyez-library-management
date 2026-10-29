import { aliases } from "./vitest.aliases.js";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: aliases },
  test: {
    include: ["tests/server/integration/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
    reporters: ["default", "junit"],
    outputFile: { junit: "test-results/server-integration.xml" },
  },
});
