import { mergeConfig, defineConfig } from "vitest/config";
import unit from "./vitest.server.config.js";
export default mergeConfig(
  unit,
  defineConfig({
    test: {
      include: [
        "tests/server/unit/**/*.test.ts",
        "tests/server/integration/**/*.test.ts",
      ],
      fileParallelism: false,
      testTimeout: 30000,
      hookTimeout: 60000,
      coverage: { reportsDirectory: "coverage/server", enabled: true },
    },
  }),
);
