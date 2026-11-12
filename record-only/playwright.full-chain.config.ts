import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/full-chain/client",
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [
    ["list"],
    ["junit", { outputFile: "test-results/full-chain-client.xml" }],
  ],
  outputDir: "test-results/full-chain-electron",
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
