// Docker-free full-chain runner for Linux/macOS development machines.
//
// It provisions an isolated database, runs the real migrations, starts the real
// API, log-ingest and deploy/nginx.conf (local paths) on loopback, writes the
// same connection file used by the Docker runner, then executes the suites.
//
// Requirements: PostgreSQL (admin account with CREATEDB + CREATEROLE), nginx,
// and built artifacts (`yarn build:shared && yarn build:server`, plus
// `yarn build:client:integration` for the Electron suite).
//
//   FULL_CHAIN_ADMIN_URL=postgres://user:pass@127.0.0.1:5432/postgres \
//     corepack yarn tsx scripts/full-chain-local.ts --suite=server
import { execFile, spawn } from "node:child_process";
import { access, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { certificate } from "../tests/helpers/certificates.js";
import { identity } from "../tests/helpers/config.js";
import {
  connectionPath,
  loadConnection,
  repoRoot,
  runDirectory,
  writeConnection,
  assertIsolatedConnection,
  type FullChainConnection,
  type LocalProcessSpec,
} from "../tests/full-chain/harness/connection.js";
import { findFreePort, newRunId } from "../tests/full-chain/harness/env.js";
import { Gateway } from "../tests/full-chain/harness/gateway.js";
import { projectRoot, runSuites, type Suite } from "./full-chain-suites.js";

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
  console.log(`[full-chain:local] ${message}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function run(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  inherit = false,
): Promise<number> {
  if (inherit)
    return new Promise((resolve) => {
      const child = spawn(file, args, {
        cwd: options.cwd ?? projectRoot,
        env: options.env ?? process.env,
        stdio: "inherit",
        windowsHide: true,
        shell: false,
      });
      child.on("error", () => resolve(-1));
      child.on("close", (code) => resolve(code ?? -1));
    });
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd ?? projectRoot,
        env: options.env ?? process.env,
        timeout: 300_000,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error) => resolve(error ? 1 : 0),
    );
  });
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function pgClient(connectionString: string) {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

interface ProcessFile {
  apiPid?: number;
  ingestPid?: number;
  nginxPid?: number;
}

interface LocalProvision {
  connection: FullChainConnection;
  processFile: string;
  dbControl?: { stop: string[]; start: string[] };
}

function sanitize(value: string) {
  return value.replace(/[^a-z0-9]/g, "_");
}

function detectedCluster(adminUrl: string) {
  // Opt-in only: never infer permission to stop a shared host database.
  const configured = process.env.FULL_CHAIN_PG_CLUSTER;
  if (!configured) return undefined;
  if (
    !/^\d+\/[a-zA-Z0-9_-]+$/.test(configured) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(adminUrl).hostname)
  )
    throw new Error("FULL_CHAIN_PG_CLUSTER_INVALID");
  const [version, name] = configured.split("/");
  return {
    stop: ["pg_ctlcluster", version, name, "stop"],
    start: ["pg_ctlcluster", version, name, "start"],
  };
}

async function startDatabase(dbControl?: { stop: string[]; start: string[] }) {
  if (!dbControl) return;
  await run(dbControl.start[0], dbControl.start.slice(1));
  await sleep(1000);
}

async function spawnProcess(
  name: string,
  spec: LocalProcessSpec,
  logs: string,
): Promise<number> {
  const log = await open(join(logs, `${name}.log`), "a");
  try {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      windowsHide: true,
    });
    child.unref();
    if (!child.pid) throw new Error(`LOCAL_SPAWN_FAILED: ${name}`);
    return child.pid;
  } finally {
    await log.close();
  }
}

async function stopPid(pid: number | undefined) {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await sleep(100);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

async function waitReady(connection: FullChainConnection, timeoutMs = 180_000) {
  const gateway = new Gateway(connection);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await gateway.healthReady()).status === 200) return;
    } catch {
      /* API or nginx not up yet */
    }
    await sleep(500);
  }
  throw new Error("LOCAL_STACK_READY_TIMEOUT");
}

function nginxConfig(
  template: string,
  values: {
    nginxDir: string;
    gatewayLogs: string;
    httpsPort: number;
    apiPort: number;
    certPath: string;
    keyPath: string;
  },
) {
  let config = template;
  const replacements: Array<[RegExp, string]> = [
    [/^pid .*$/m, `pid ${values.nginxDir}/nginx.pid;`],
    [/^error_log .*$/m, `error_log ${values.gatewayLogs}/error.log warn;`],
    [
      /access_log \/var\/log\/cyez\/access\.jsonl safe;/,
      `access_log ${values.gatewayLogs}/access.jsonl safe;`,
    ],
    [/listen 8443 ssl;/, `listen 127.0.0.1:${values.httpsPort} ssl;`],
    [
      /ssl_certificate \/run\/secrets\/tls_cert;/,
      `ssl_certificate ${values.certPath};`,
    ],
    [
      /ssl_certificate_key \/run\/secrets\/tls_key;/,
      `ssl_certificate_key ${values.keyPath};`,
    ],
    [
      /client_body_temp_path \/tmp\/client_temp;/,
      `client_body_temp_path ${values.nginxDir}/client_temp;`,
    ],
    [
      /proxy_temp_path \/tmp\/proxy_temp;/,
      `proxy_temp_path ${values.nginxDir}/proxy_temp;`,
    ],
    [
      /fastcgi_temp_path \/tmp\/fastcgi_temp;/,
      `fastcgi_temp_path ${values.nginxDir}/fastcgi_temp;`,
    ],
    [
      /uwsgi_temp_path \/tmp\/uwsgi_temp;/,
      `uwsgi_temp_path ${values.nginxDir}/uwsgi_temp;`,
    ],
    [
      /scgi_temp_path \/tmp\/scgi_temp;/,
      `scgi_temp_path ${values.nginxDir}/scgi_temp;`,
    ],
    [
      /proxy_pass http:\/\/\$api_upstream:3000\$request_uri;/g,
      `proxy_pass http://127.0.0.1:${values.apiPort};`,
    ],
  ];
  for (const [pattern, replacement] of replacements) {
    if (!pattern.test(config))
      throw new Error(`LOCAL_NGINX_TEMPLATE_CHANGED: ${pattern}`);
    config = config.replace(pattern, replacement);
  }
  return config;
}

let startingConnection: FullChainConnection | undefined;

async function provision(): Promise<LocalProvision> {
  const adminUrl = process.env.FULL_CHAIN_ADMIN_URL;
  if (!adminUrl)
    throw new Error(
      "FULL_CHAIN_ADMIN_URL_REQUIRED: local mode needs a PostgreSQL admin URL " +
        "with CREATEDB and CREATEROLE, for example " +
        "postgres://cyez_fc:password@127.0.0.1:5432/postgres",
    );
  for (const [name, path] of [
    ["server", "apps/server/dist/main.js"],
    ["protocol", "packages/protocol/dist/index.js"],
  ] as const)
    if (!(await exists(join(repoRoot, path))))
      throw new Error(
        `LOCAL_MODE_BUILD_MISSING: ${name} (${path}); run ` +
          "`corepack yarn build:shared && corepack yarn build:server`",
      );

  const runId = value("run-id") ?? newRunId();
  const directory = runDirectory(runId);
  const dirs = {
    apiSpool: join(directory, "api-spool"),
    gatewayLogs: join(directory, "gateway-logs"),
    dbLogs: join(directory, "db-logs"),
    cursors: join(directory, "cursors"),
    nginx: join(directory, "nginx"),
    logs: join(directory, "logs"),
  };
  await mkdir(join(repoRoot, "runtime/full-chain"), { recursive: true });
  await mkdir(directory, { mode: 0o700 });
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  const processFile = join(directory, "processes.json");
  await writeFile(processFile, "{}\n");

  const dbControl = await detectedCluster(adminUrl);
  await startDatabase(dbControl);
  const admin = await pgClient(adminUrl).catch((error) => {
    throw new Error(
      `LOCAL_MODE_POSTGRES_UNAVAILABLE: ${String(error)}\n` +
        "Set FULL_CHAIN_ADMIN_URL to a reachable PostgreSQL admin account.",
    );
  });
  const dbName = `cyez_fc_${sanitize(runId)}`.slice(0, 60);
  const runtimeRole = `fc_runtime_${sanitize(runId)}`.slice(0, 60);
  try {
    // A reused run ID must fail rather than deleting an existing database.
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = "/" + dbName;
  const runtimeUrl = new URL(ownerUrl);
  runtimeUrl.username = runtimeRole;
  runtimeUrl.password = randomBytes(24).toString("hex");
  const ownerFile = join(directory, "owner-url");
  const runtimeFile = join(directory, "runtime-url");
  await writeFile(ownerFile, ownerUrl.toString(), { mode: 0o600 });
  await writeFile(runtimeFile, runtimeUrl.toString(), { mode: 0o600 });

  const cert = certificate("127.0.0.1");
  const certPath = join(directory, "server.crt");
  const keyPath = join(directory, "server.key");
  await writeFile(certPath, cert.cert);
  await writeFile(keyPath, cert.key, { mode: 0o600 });

  const username = "teacher-full-chain";
  const password = randomBytes(24).toString("hex");
  const providerPath = join(repoRoot, "tests/full-chain/fixtures/provider.mjs");
  const protocolModule = pathToFileURL(
    join(repoRoot, "packages/protocol/dist/index.js"),
  ).href;
  const baseEnv = {
    APP_ENV: "integration",
    TEACHER_USERNAME: username,
    TEACHER_PASSWORD: password,
    HASH_VERSION: identity.hashVersion,
    FIXED_SALT_HEX: identity.fixedSaltHex,
    CARD_ISSUER: identity.issuer,
    UID_BYTE_LENGTHS: identity.uidByteLengths.join(","),
    PROVIDER_MODE: "module",
    PROVIDER_MODULE: providerPath,
    PROFILE_CONTRACT_CONFIRMED: "false",
    DATABASE_URL_FILE: ownerFile,
    RUNTIME_DATABASE_URL_FILE: runtimeFile,
    SPOOL_DIR: dirs.apiSpool,
    FULL_CHAIN_PROTOCOL_MODULE: protocolModule,
  };

  log("running ORM and role migrations");
  const migrate = await run(
    process.execPath,
    [join(repoRoot, "apps/server/dist/cli.js"), "migrate"],
    { env: { ...process.env, ...baseEnv } },
  );
  if (migrate !== 0) throw new Error("LOCAL_MIGRATION_FAILED");

  const apiPort = await findFreePort();
  const httpsPort = await findFreePort();
  const apiCommands: LocalProcessSpec = {
    command: process.execPath,
    args: [join(repoRoot, "apps/server/dist/main.js")],
    cwd: repoRoot,
    env: {
      ...baseEnv,
      HOST: "127.0.0.1",
      PORT: String(apiPort),
    },
  };
  const ingestCommands: LocalProcessSpec = {
    command: process.execPath,
    args: [join(repoRoot, "apps/server/dist/ingest.js")],
    cwd: repoRoot,
    env: {
      DATABASE_URL_FILE: runtimeFile,
      INGEST_SOURCES: `api:${dirs.apiSpool}`,
      INGEST_FILE_SOURCES: `gateway:${dirs.gatewayLogs};db:${dirs.dbLogs}`,
      INGEST_CURSOR_DIR: dirs.cursors,
    },
  };

  const connection: FullChainConnection = {
    version: 1,
    mode: "local",
    runId,
    baseUrl: `https://127.0.0.1:${httpsPort}`,
    certPemPath: certPath,
    certPinSha256: cert.pin,
    identity,
    username,
    password,
    provider: { module: providerPath, timeoutMs: 5000 },
    local: {
      ownerUrl: ownerUrl.toString(),
      runtimeUrl: runtimeUrl.toString(),
      adminUrl,
      dbName,
      runtimeRole,
      directory,
      dirs,
      commands: { api: apiCommands, ingest: ingestCommands },
      dbControl,
      processFile,
    },
    createdAtMs: Date.now(),
  };
  startingConnection = connection;
  log("starting local API, log-ingest and nginx");
  const processes: ProcessFile = {};
  processes.apiPid = await spawnProcess("api", apiCommands, dirs.logs);
  await writeFile(processFile, JSON.stringify(processes));
  processes.ingestPid = await spawnProcess("ingest", ingestCommands, dirs.logs);
  await writeFile(processFile, JSON.stringify(processes));

  const template = await readFile(join(repoRoot, "deploy/nginx.conf"), "utf8");
  const config = nginxConfig(template, {
    nginxDir: dirs.nginx,
    gatewayLogs: dirs.gatewayLogs,
    httpsPort,
    apiPort,
    certPath,
    keyPath,
  });
  const configPath = join(dirs.nginx, "nginx.conf");
  await writeFile(configPath, config);
  const check = await run("nginx", ["-t", "-p", dirs.nginx, "-c", configPath], {
    cwd: dirs.nginx,
  });
  if (check !== 0)
    throw new Error("LOCAL_NGINX_CONFIG_INVALID: see nginx -t output above");
  processes.nginxPid = await spawnProcess(
    "nginx",
    {
      command: "nginx",
      args: ["-p", dirs.nginx, "-c", configPath, "-g", "daemon off;"],
      cwd: dirs.nginx,
      env: {},
    },
    dirs.logs,
  );
  await writeFile(processFile, JSON.stringify(processes, null, 2));

  await waitReady(connection);
  await writeConnection(connection);
  log(`local stack ready at ${connection.baseUrl}`);
  log(`connection file ${connectionPath()}`);
  return { connection, processFile, dbControl };
}

async function teardown(connection: FullChainConnection) {
  assertIsolatedConnection(connection);
  const local = connection.local;
  if (!local) return;
  let processes: ProcessFile = {};
  try {
    processes = JSON.parse(await readFile(local.processFile, "utf8"));
  } catch {
    /* no process file */
  }
  for (const pid of [processes.nginxPid, processes.ingestPid, processes.apiPid])
    await stopPid(pid);
  await writeFile(local.processFile, "{}\n").catch(() => {});
  if (local.dbControl) await startDatabase(local.dbControl);
  const admin = await pgClient(local.adminUrl).catch(() => undefined);
  if (admin) {
    try {
      await admin.query(
        `DROP DATABASE IF EXISTS "${local.dbName}" WITH (FORCE)`,
      );
      await admin.query(`DROP ROLE IF EXISTS "${local.runtimeRole}"`);
    } finally {
      await admin.end();
    }
  }
  log(
    `local database ${local.dbName} removed; logs remain in ${local.directory}`,
  );
}

async function down() {
  const connection = await loadConnection();
  if (connection.mode !== "local")
    throw new Error("LOCAL_DOWN_REQUIRES_LOCAL_CONNECTION");
  log(`stopping local stack ${connection.runId}`);
  await teardown(connection);
}

async function main() {
  if (flag("down")) return down();
  const suite = (value("suite", "server") as Suite) ?? "server";
  if (!["server", "client", "all", "none"].includes(suite))
    throw new Error(`FULL_CHAIN_SUITE_INVALID: ${suite}`);
  if (suite === "client" || suite === "all")
    if (!(await exists(join(repoRoot, "apps/teacher/out/main/index.js"))))
      throw new Error(
        "LOCAL_MODE_CLIENT_BUILD_MISSING: run `corepack yarn build:client:integration` " +
          "before the Electron full-chain suite",
      );

  let provisioned: LocalProvision;
  try {
    provisioned = await provision();
  } catch (error) {
    if (startingConnection) await teardown(startingConnection);
    throw error;
  }
  let failure: unknown;
  try {
    await runSuites(suite, {
      connectionPath: connectionPath(),
    });
    log("suites passed");
  } catch (error) {
    failure = error;
  } finally {
    if (flag("keep") || suite === "none") {
      log("local stack kept running; stop it with `--down`");
    } else {
      log("tearing down local stack");
      await teardown(provisioned.connection);
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
