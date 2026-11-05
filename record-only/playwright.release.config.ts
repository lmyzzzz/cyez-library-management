import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/client/integration",
  testMatch: "**/release.test.ts",
  workers: 1,
  timeout: 60000,
  expect: { timeout: 10000 },
  reporter: [
    ["list"],
    ["junit", { outputFile: "test-results/client-release.xml" }],
  ],
  outputDir: "test-results/release",
});
