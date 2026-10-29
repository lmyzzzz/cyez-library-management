import { aliases } from "./vitest.aliases.js";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: aliases },
  test: {
    include: ["tests/client/unit/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage/client-unit",
      reporter: ["text", "json-summary", "lcov"],
      include: [
        "packages/client-sdk/src/**/*.ts",
        "apps/teacher/src/main/**/*.ts",
        "apps/teacher/src/renderer/**/*.{ts,tsx}",
        "apps/teacher/src/shared/**/*.ts",
      ],
      exclude: [
        "apps/teacher/src/main/index.ts",
        "apps/teacher/src/preload/index.ts",
        "apps/teacher/src/renderer/index.tsx",
      ],
      thresholds: {
        lines: 85,
        statements: 85,
        functions: 85,
        branches: 80,
        "apps/teacher/src/main/pin.ts": { branches: 90 },
        "apps/teacher/src/main/reader.ts": { branches: 90 },
        "apps/teacher/src/renderer/timers.ts": { branches: 90 },
      },
    },
  },
});
