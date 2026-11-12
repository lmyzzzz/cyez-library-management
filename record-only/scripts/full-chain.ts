// Docker full-chain runner: isolated Compose project, real gateway/API/PostgreSQL
// and log-ingest, then the container-level and real-Electron suites.
//
//   corepack yarn test:full-chain                 # client + server
//   corepack yarn test:full-chain --suite=server
//   corepack yarn test:full-chain --reuse --suite=client
//   corepack yarn test:full-chain --suite=none --keep
//   corepack yarn test:full-chain --down
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DockerRunner } from "../tests/full-chain/harness/docker.js";
import {
  connectionPath,
  loadConnection,
  repoRoot,
  runDirectory,
  writeConnection,
  type FullChainConnection,
} from "../tests/full-chain/harness/connection.js";
import {
  newRunId,
  prepareDockerEnvironment,
} from "../tests/full-chain/harness/env.js";
import {
  DockerStack,
  createStack,
  type FullChainStack,
} from "../tests/full-chain/harness/stack.js";
import { runSuites, type Suite } from "./full-chain-suites.js";

const argv = process.argv.slice(2);

function value(name: string, fallback?: string): string | undefined {
  const equals = argv.find((argument) => argument.startsWith(`--${name}=`));
  if (equals) return equals.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--"))
    return argv[index + 1];
  return fallback;
}

function flag(name: string) {
  return argv.includes(`--${name}`);
}

function log(message: string) {
  console.log(`[full-chain] ${message}`);
}

const suite = (value("suite", "all") as Suite) ?? "all";
if (!["server", "client", "all", "none"].includes(suite))
  throw new Error(`FULL_CHAIN_SUITE_INVALID: ${suite}`);
const keep = flag("keep") || suite === "none";
const reuse = flag("reuse");
const skipBuild = flag("skip-build");
const portValue = value("port");
const port = portValue ? Number(portValue) : undefined;
if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))
  throw new Error(`FULL_CHAIN_PORT_INVALID: ${portValue}`);

async function down() {
  const connection = await loadConnection();
  log(
    `stopping Docker stack ${connection.docker?.project ?? connection.runId}`,
  );
  await DockerStack.destroy(connection);
  log("stack and named volumes removed");
}

async function main() {
  if (flag("down")) return down();

  let connection: FullChainConnection;
  let stack: FullChainStack | undefined;
  if (reuse) {
    connection = await loadConnection();
    if (connection.mode !== "docker")
      throw new Error("FULL_CHAIN_REUSE_REQUIRES_DOCKER_CONNECTION");
    stack = await createStack(connection);
    log(
      `reusing ${connection.baseUrl} (project ${connection.docker!.project})`,
    );
    await stack.waitReady(10 * 60_000);
  } else {
    const runId = value("run-id") ?? newRunId();
    const runDir = runDirectory(runId);
    const envFile = join(runDir, "compose.env");
    const composeFiles = [
      join(repoRoot, "compose.yaml"),
      join(repoRoot, "tests/full-chain/compose.full-chain.yaml"),
    ];
    const runner = new DockerRunner({
      project: `cyez-fc-${runId}`,
      composeFiles,
      envFile,
      projectDirectory: repoRoot,
    });
    await runner.assertAvailable();
    const prepared = await prepareDockerEnvironment({ runner, runId, port });
    connection = prepared.connection;
    stack = new DockerStack(connection);
    await writeConnection(connection);
    log(`run ${connection.runId}: ${connection.baseUrl}`);
    log(`isolated compose project ${connection.docker!.project}`);
    log(`connection file ${connectionPath()}`);
    try {
      if (!skipBuild) {
        log(
          "building API/PostgreSQL/gateway images (first run can take minutes)",
        );
        const started = Date.now();
        await DockerStack.build(connection);
        log(`images built in ${Math.round((Date.now() - started) / 1000)}s`);
      }
      log("starting stack and waiting for readiness");
      stack = await DockerStack.start(connection);
      log("stack ready; starting suites");
    } catch (error) {
      await mkdir(join(repoRoot, "test-results/full-chain"), {
        recursive: true,
      });
      await stack?.saveDiagnostics(
        join(repoRoot, "test-results/full-chain", connection.runId),
      );
      await DockerStack.destroy(connection);
      throw error;
    }
  }

  let failure: unknown;
  try {
    await runSuites(suite, { connectionPath: connectionPath() });
    log("suites passed");
  } catch (error) {
    failure = error;
  } finally {
    if (failure) {
      const directory = join(
        repoRoot,
        "test-results/full-chain",
        connection.runId,
      );
      await mkdir(directory, { recursive: true });
      await stack?.saveDiagnostics(directory).catch(() => {});
      log(`diagnostics written to ${directory}`);
    }
    if (keep) {
      log("stack kept running for inspection:");
      log(
        `  docker compose -f ${connection.docker!.files.join(" -f ")} --env-file ${connection.docker!.envFile} --project-name ${connection.docker!.project} ps`,
      );
      log("  rerun with --reuse, or clean up with --down");
    } else {
      log("tearing down Compose project and named volumes");
      await DockerStack.destroy(connection);
    }
  }
  if (failure) throw failure;
}

try {
  await main();
} catch (error) {
  console.error(
    `[full-chain] FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  if (
    process.env.FULL_CHAIN_DEBUG === "1" &&
    error instanceof Error &&
    error.stack
  )
    console.error(error.stack);
  process.exitCode = 1;
}
