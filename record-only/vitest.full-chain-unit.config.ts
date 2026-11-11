import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/full-chain/harness/**/*.test.ts"],
    testTimeout: 30_000,
    reporters: ["default", "junit"],
    outputFile: { junit: "test-results/full-chain-harness.xml" },
  },
});
