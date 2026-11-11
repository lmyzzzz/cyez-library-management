import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type Suite = "server" | "client" | "all" | "none";
export type ConcreteSuite = "server" | "client";

export const projectRoot = fileURLToPath(new URL("..", import.meta.url));

export function suiteList(suite: Suite): ConcreteSuite[] {
  if (suite === "none") return [];
  // Client E2E runs first against a fresh, empty student cache; the server
  // suite then exercises restarts, persistence and log aggregation.
  if (suite === "all") return ["client", "server"];
  return [suite];
}

function spawnInherit(
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
      windowsHide: true,
      shell: false,
    });
    child.on("error", (error) => {
      console.error(`FULL_CHAIN_SUITE_SPAWN_FAILED: ${String(error)}`);
      resolve(-1);
    });
    child.on("close", (code) => resolve(code ?? -1));
  });
}

async function runSuite(
  suite: ConcreteSuite,
  options: { connectionPath: string },
) {
  const node = process.execPath;
  const env = {
    ...process.env,
    FULL_CHAIN_CONNECTION: options.connectionPath,
  };
  let command = node;
  let args: string[];
  if (suite === "server")
    args = [
      join(projectRoot, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      "vitest.full-chain.config.ts",
    ];
  else
    args = [
      join(projectRoot, "node_modules/@playwright/test/cli.js"),
      "test",
      "--config",
      "playwright.full-chain.config.ts",
    ];
  if (
    suite === "client" &&
    process.platform === "linux" &&
    !process.env.DISPLAY
  ) {
    command = "xvfb-run";
    args = ["-a", node, ...args];
  }
  console.log(`\n=== full-chain ${suite} suite ===`);
  const code = await spawnInherit(command, args, {
    cwd: projectRoot,
    env,
  });
  if (code !== 0) {
    const hint =
      suite === "client" && code === -1 && process.platform === "linux"
        ? " (install xvfb or run under a desktop session: `xvfb-run` was not usable)"
        : "";
    throw new Error(`FULL_CHAIN_SUITE_FAILED: ${suite} exited ${code}${hint}`);
  }
}

export async function runSuites(
  suite: Suite,
  options: { connectionPath: string },
) {
  for (const name of suiteList(suite)) await runSuite(name, options);
}
