import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Provisioned by scripts/full-chain.ts (Docker) or scripts/full-chain-local.ts. */
export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

export interface FullChainIdentity {
  hashVersion: string;
  fixedSaltHex: string;
  issuer: string;
  uidByteLengths: number[];
}

export interface FullChainDocker {
  /** true when `docker` is reached through wsl.exe (Windows without Docker Desktop CLI). */
  wsl: boolean;
  project: string;
  /** Host (planner-side) absolute compose file paths, base file first. */
  files: string[];
  envFile: string;
  projectDirectory: string;
}

export interface LocalProcessSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface FullChainLocal {
  ownerUrl: string;
  runtimeUrl: string;
  adminUrl: string;
  dbName: string;
  runtimeRole: string;
  directory: string;
  dirs: {
    apiSpool: string;
    gatewayLogs: string;
    dbLogs: string;
    cursors: string;
    nginx: string;
    logs: string;
  };
  commands: { api: LocalProcessSpec; ingest: LocalProcessSpec };
  /** Optional PostgreSQL cluster control used by the DB outage test. */
  dbControl?: { stop: string[]; start: string[] };
  processFile: string;
}

export interface FullChainConnection {
  version: 1;
  mode: "docker" | "local";
  runId: string;
  baseUrl: string;
  certPemPath: string;
  certPinSha256: string;
  identity: FullChainIdentity;
  username: string;
  password: string;
  provider: { module: string; timeoutMs: number };
  docker?: FullChainDocker;
  local?: FullChainLocal;
  createdAtMs: number;
}

export function connectionPath(): string {
  return (
    process.env.FULL_CHAIN_CONNECTION ??
    join(repoRoot, "runtime/full-chain/connection.json")
  );
}

export function runDirectory(runId?: string): string {
  if (!runId || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(runId))
    throw new Error("FULL_CHAIN_RUN_ID_INVALID");
  return join(repoRoot, "runtime/full-chain", runId);
}

export function assertIsolatedConnection(connection: FullChainConnection) {
  const directory = runDirectory(connection.runId);
  const same = (actual: string, expected: string) =>
    typeof actual === "string" && resolve(actual) === resolve(expected);
  if (connection.mode === "docker") {
    const d = connection.docker;
    if (
      !d ||
      d.project !== `cyez-fc-${connection.runId}` ||
      !same(d.envFile, join(directory, "compose.env")) ||
      !same(d.projectDirectory, repoRoot) ||
      d.files.length !== 2 ||
      !same(d.files[0], join(repoRoot, "compose.yaml")) ||
      !same(
        d.files[1],
        join(repoRoot, "tests/full-chain/compose.full-chain.yaml"),
      )
    )
      throw new Error("FULL_CHAIN_CONNECTION_NOT_ISOLATED");
  } else if (connection.mode === "local") {
    const l = connection.local;
    const suffix = connection.runId.replaceAll("-", "_");
    if (
      !l ||
      l.dbName !== `cyez_fc_${suffix}` ||
      l.runtimeRole !== `fc_runtime_${suffix}` ||
      !same(l.directory, directory) ||
      !same(l.processFile, join(directory, "processes.json")) ||
      new URL(l.ownerUrl).pathname !== `/${l.dbName}`
    )
      throw new Error("FULL_CHAIN_CONNECTION_NOT_ISOLATED");
  } else throw new Error("FULL_CHAIN_CONNECTION_INVALID: mode");
}

/** Fails loudly instead of silently skipping tests against an unknown deployment. */
export async function loadConnection(
  path = connectionPath(),
): Promise<FullChainConnection> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(
        `FULL_CHAIN_NOT_PROVISIONED: no ${path}. ` +
          "Run `corepack yarn test:full-chain` (Docker) or `corepack yarn test:full-chain:local`, " +
          "or point FULL_CHAIN_CONNECTION at an existing connection file.",
      );
    throw error;
  }
  const value = JSON.parse(text) as Partial<FullChainConnection>;
  const required = [
    "version",
    "mode",
    "runId",
    "baseUrl",
    "certPemPath",
    "certPinSha256",
    "identity",
    "username",
    "password",
    "provider",
  ] as const;
  for (const key of required)
    if (value[key] === undefined || value[key] === null)
      throw new Error(`FULL_CHAIN_CONNECTION_INVALID: missing ${key}`);
  if (value.version !== 1)
    throw new Error(`FULL_CHAIN_CONNECTION_INVALID: version ${value.version}`);
  if (value.mode === "docker" && !value.docker)
    throw new Error("FULL_CHAIN_CONNECTION_INVALID: docker section missing");
  if (value.mode === "local" && !value.local)
    throw new Error("FULL_CHAIN_CONNECTION_INVALID: local section missing");
  if (!/^[0-9a-f]{64}$/.test(value.certPinSha256!))
    throw new Error("FULL_CHAIN_CONNECTION_INVALID: certPinSha256");
  assertIsolatedConnection(value as FullChainConnection);
  return value as FullChainConnection;
}

export async function writeConnection(connection: FullChainConnection) {
  const path = connectionPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(connection, null, 2) + "\n", {
    mode: 0o600,
  });
  return path;
}

/** Diagnostics must never include the shared teacher password. */
export function redactedConnection(connection: FullChainConnection) {
  return {
    ...connection,
    password: "<redacted>",
    local: connection.local
      ? {
          ...connection.local,
          ownerUrl: "<redacted>",
          runtimeUrl: "<redacted>",
          adminUrl: "<redacted>",
          commands: "<redacted>",
        }
      : undefined,
  };
}
