import { randomBytes, randomInt } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { certificate } from "../../helpers/certificates.js";
import { identity } from "../../helpers/config.js";
import {
  repoRoot,
  runDirectory,
  type FullChainConnection,
} from "./connection.js";
import type { DockerRunner } from "./docker.js";

const randomHex = (bytes: number) => randomBytes(bytes).toString("hex");

export interface ProvisionedDockerEnvironment {
  connection: FullChainConnection;
  runner: DockerRunner;
  envFile: string;
  secretsDir: string;
  runId: string;
  port: number;
}

export interface ProvisionOptions {
  runner: DockerRunner;
  runId: string;
  port?: number;
  runDir: string;
  secretsDir: string;
  envFile: string;
}

export function newRunId() {
  return (
    process.env.FULL_CHAIN_RUN_ID ??
    `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`
  ).toLowerCase();
}

/** Bind an ephemeral IANA private-range port, then release it for Compose. */
export async function findFreePort(preferred?: number): Promise<number> {
  if (preferred) return preferred;
  for (let attempt = 0; attempt < 25; attempt++) {
    const candidate = randomInt(49_152, 65_536);
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.listen(candidate, "127.0.0.1", () => {
        server.close(() => resolve(true));
      });
    });
    if (free) return candidate;
  }
  throw new Error("FULL_CHAIN_PORT_UNAVAILABLE: no free HTTPS port found");
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function envFileContents(values: Record<string, string>) {
  // Compose env-file: plain KEY=value; generated values contain no whitespace,
  // quotes, `#` or `$`, so no escaping is required.
  return (
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n"
  );
}

/**
 * Creates a completely isolated full-chain run: unique Compose project and
 * named-volume prefix, isolated secrets outside ./secrets, unique image tags,
 * a fresh self-signed leaf certificate and the test campus provider mount.
 * Nothing here touches .env.integration or an existing integration deployment.
 */
export async function prepareDockerEnvironment(
  options: Pick<ProvisionOptions, "runner" | "runId" | "port">,
): Promise<ProvisionedDockerEnvironment> {
  const { runner, runId } = options;
  const runDir = runDirectory(runId);
  const secretsDir = join(runDir, "secrets");
  const envFile = join(runDir, "compose.env");
  const port = await findFreePort(options.port);
  // Refuse to overwrite an existing run's credentials, database or volumes.
  await mkdir(join(repoRoot, "runtime/full-chain"), { recursive: true });
  await mkdir(runDir);
  await mkdir(secretsDir, { mode: 0o700 });

  const cert = certificate("127.0.0.1");
  const teacherPassword = randomHex(24);
  const databasePassword = randomHex(24);
  const runtimePassword = randomHex(24);
  const teacherUsername = "teacher-full-chain";
  const composeFiles = [
    join(repoRoot, "compose.yaml"),
    join(repoRoot, "tests/full-chain/compose.full-chain.yaml"),
  ];
  const fixturesDir = join(repoRoot, "tests/full-chain/fixtures");

  const [secretsEnginePath, fixturesEnginePath] = await Promise.all([
    runner.enginePath(secretsDir),
    runner.enginePath(fixturesDir),
  ]);

  await Promise.all([
    writeFile(join(secretsDir, "server.crt"), cert.cert),
    writeFile(join(secretsDir, "server.key"), cert.key, { mode: 0o444 }),
    writeFile(join(secretsDir, "db-password"), databasePassword, {
      mode: 0o444,
    }),
    writeFile(
      join(secretsDir, "migration-database-url"),
      `postgres://cyez_migrate:${databasePassword}@db:5432/cyez`,
      { mode: 0o444 },
    ),
    writeFile(
      join(secretsDir, "runtime-database-url"),
      `postgres://cyez_runtime:${runtimePassword}@db:5432/cyez`,
      { mode: 0o444 },
    ),
    writeFile(join(secretsDir, "provider-config-key"), randomHex(32), {
      mode: 0o444,
    }),
  ]);

  await writeFile(
    envFile,
    envFileContents({
      APP_ENV: "integration",
      RELEASE_TAG: `fc-${runId}`,
      API_IMAGE: "cyez-record-only",
      DB_IMAGE: "cyez-record-db",
      GATEWAY_IMAGE: "cyez-record-gateway",
      DATA_PREFIX: `cyez-fc-${runId}`,
      BIND_IP: "127.0.0.1",
      INIT_VOLUMES_MODE: "chown",
      CAPACITY_WARNING_BYTES: "1073741824",
      CAPACITY_RESERVE_BYTES: "268435456",
      CAPACITY_RECOVERY_BYTES: "2147483648",
      HTTPS_PORT: String(port),
      TEACHER_USERNAME: teacherUsername,
      TEACHER_PASSWORD: teacherPassword,
      HASH_VERSION: identity.hashVersion,
      FIXED_SALT_HEX: identity.fixedSaltHex,
      CARD_ISSUER: identity.issuer,
      UID_BYTE_LENGTHS: identity.uidByteLengths.join(","),
      PROVIDER_MODE: "module",
      PROVIDER_MODULE: "/full-chain-adapters/provider.mjs",
      PROFILE_CONTRACT_CONFIRMED: "false",
      FULL_CHAIN_SECRETS_DIR: secretsEnginePath,
      FULL_CHAIN_FIXTURES_DIR: fixturesEnginePath,
    }),
    { mode: 0o600 },
  );

  const connection: FullChainConnection = {
    version: 1,
    mode: "docker",
    runId,
    // HTTPS_PORT in Compose publishes 127.0.0.1:<port>; keep the URL explicit.
    baseUrl: `https://127.0.0.1:${port}`,
    certPemPath: join(secretsDir, "server.crt"),
    certPinSha256: cert.pin,
    identity,
    username: teacherUsername,
    password: teacherPassword,
    provider: { module: "/full-chain-adapters/provider.mjs", timeoutMs: 5000 },
    docker: {
      wsl: runner.wsl,
      project: `cyez-fc-${runId}`,
      files: composeFiles,
      envFile,
      projectDirectory: repoRoot,
    },
    createdAtMs: Date.now(),
  };

  await writeFile(
    join(runDir, "run.json"),
    JSON.stringify(
      {
        runId,
        createdAt: new Date().toISOString(),
        port,
        project: connection.docker!.project,
        dataPrefix: `cyez-fc-${runId}`,
        images: {
          api: `cyez-record-only:fc-${runId}`,
          db: `cyez-record-db:fc-${runId}`,
          gateway: `cyez-record-gateway:fc-${runId}`,
        },
      },
      null,
      2,
    ) + "\n",
  );

  return { connection, runner, envFile, secretsDir, runId, port };
}

export async function dockerEnvironmentExists(connection: FullChainConnection) {
  if (connection.mode !== "docker" || !connection.docker) return false;
  return exists(connection.docker.envFile);
}

/** Generates an independent certificate (used by negative-pin gateway tests). */
export function foreignCertificate() {
  return certificate("127.0.0.1");
}
