import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/client/integration",
  workers: 1,
  fullyParallel: false,
  timeout: 60000,
  expect: { timeout: 10000 },
  reporter: [
    ["list"],
    ["junit", { outputFile: "test-results/client-integration.xml" }],
  ],
  outputDir: "test-results/electron",
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
