import { aliases } from "./vitest.aliases.js";
import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

class FullChainSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]) {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    include: ["tests/full-chain/server/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    sequence: { sequencer: FullChainSequencer },
    // Files run in numeric order: the recovery file restarts the API and
    // changes the shared password, and durable state is asserted last.
    reporters: ["default", "junit"],
    outputFile: { junit: "test-results/full-chain-server.xml" },
  },
});
