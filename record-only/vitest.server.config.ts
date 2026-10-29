import { aliases } from "./vitest.aliases.js";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: aliases },
  test: {
    include: ["tests/server/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage/server-unit",
      reporter: ["text", "json-summary", "lcov"],
      include: [
        "packages/protocol/src/**/*.ts",
        "packages/domain/src/**/*.ts",
        "apps/server/src/**/*.ts",
      ],
      exclude: [
        "apps/server/src/main.ts",
        "apps/server/src/cli.ts",
        "apps/server/src/ingest.ts",
      ],
      thresholds: {
        lines: 85,
        statements: 85,
        functions: 85,
        branches: 80,
        "packages/protocol/src/identity.ts": { branches: 90 },
        "packages/domain/src/index.ts": { branches: 90 },
        "apps/server/src/service.ts": { branches: 90 },
        "apps/server/src/provider.ts": { branches: 90 },
      },
    },
  },
});
