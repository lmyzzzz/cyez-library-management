import { execFile, spawn } from "node:child_process";
import { connect } from "node:net";
import { open, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Client } from "pg";
import {
  redactedConnection,
  type FullChainConnection,
  type LocalProcessSpec,
} from "./connection.js";
import { Gateway } from "./gateway.js";
import {
  sleep,
  waitFor,
  type FullChainService,
  type FullChainStack,
} from "./stack.js";
import type { ComposePsEntry, InspectedContainer } from "./docker.js";

interface LocalState {
  apiPid?: number;
  ingestPid?: number;
  nginxPid?: number;
}

function runCommand(
  file: string,
  args: string[],
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({ code: error ? 1 : 0, stdout, stderr }),
    );
  });
}

async function alive(pid: number | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Docker-free full-chain deployment for Linux/macOS development machines.
 * scripts/full-chain-local.ts provisions real PostgreSQL, the real API,
 * log-ingest and the real deploy/nginx.conf (with local paths) on loopback;
 * the same suites then run over real HTTPS and a real database.
 */
export class LocalStack implements FullChainStack {
  readonly mode = "local" as const;
  readonly gateway: Gateway;
  private readonly local;
  private envOverrides: Record<string, string> = {};
  private dbStopped = false;

  constructor(readonly connection: FullChainConnection) {
    if (!connection.local)
      throw new Error("FULL_CHAIN_LOCAL_CONNECTION_REQUIRED");
    this.local = connection.local;
    this.gateway = new Gateway(connection);
  }

  private async state(): Promise<LocalState> {
    try {
      return JSON.parse(await readFile(this.local.processFile, "utf8"));
    } catch {
      return {};
    }
  }

  private async saveState(state: LocalState) {
    await writeFile(this.local.processFile, JSON.stringify(state, null, 2));
  }

  private async spawnProcess(
    name: "api" | "ingest" | "nginx",
    spec: LocalProcessSpec,
    extraEnv: Record<string, string> = {},
  ) {
    const log = await open(join(this.local.dirs.logs, `${name}.log`), "a");
    try {
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env, ...extraEnv },
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

  private async stopPid(pid: number | undefined) {
    if (!(await alive(pid))) return;
    process.kill(pid!, "SIGTERM");
    for (let attempt = 0; attempt < 40; attempt++) {
      if (!(await alive(pid))) return;
      await sleep(100);
    }
    process.kill(pid!, "SIGKILL");
    await sleep(200);
  }

  private apiPort() {
    return Number(this.local.commands.api.env.PORT);
  }

  private async portListening(port: number) {
    return new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port });
      const finish = (value: boolean) => {
        socket.destroy();
        resolve(value);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(750, () => finish(false));
    });
  }

  /** Avoid reusing a port while the previous API process is still shutting down. */
  private async waitPortFree(port: number, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.portListening(port))) return;
      await sleep(200);
    }
    throw new Error(`LOCAL_API_PORT_BUSY: ${port}`);
  }

  private async startApi() {
    const state = await this.state();
    if (await alive(state.apiPid)) return;
    const port = this.apiPort();
    await this.waitPortFree(port);
    for (let attempt = 0; attempt < 3; attempt++) {
      const pid = await this.spawnProcess(
        "api",
        this.local.commands.api,
        this.envOverrides,
      );
      // A crash on startup (for example EADDRINUSE) must not be mistaken for the
      // previously killed API that is still draining.
      await sleep(500);
      if (await alive(pid)) {
        state.apiPid = pid;
        await this.saveState(state);
        return;
      }
      await this.waitPortFree(port);
    }
    throw new Error("LOCAL_API_START_FAILED");
  }

  private async startIngest() {
    const state = await this.state();
    if (await alive(state.ingestPid)) return;
    state.ingestPid = await this.spawnProcess(
      "ingest",
      this.local.commands.ingest,
    );
    await this.saveState(state);
  }

  private async spawnNginx() {
    const state = await this.state();
    if (await alive(state.nginxPid)) return;
    state.nginxPid = await this.spawnProcess("nginx", {
      command: "nginx",
      args: [
        "-p",
        this.local.dirs.nginx,
        "-c",
        join(this.local.dirs.nginx, "nginx.conf"),
        "-g",
        "daemon off;",
      ],
      cwd: this.local.dirs.nginx,
      env: {},
    });
    await this.saveState(state);
  }

  async waitReady(timeoutMs = 3 * 60_000) {
    await waitFor(
      "local gateway /health/ready = 200",
      async () => {
        try {
          return (await this.gateway.healthReady()).status === 200;
        } catch {
          return false;
        }
      },
      { timeoutMs, intervalMs: 500 },
    );
  }

  async psql(sql: string) {
    return (await this.rows(sql)).map((row) => row.join("\t")).join("\n");
  }

  async rows(sql: string) {
    const client = new Client({ connectionString: this.local.ownerUrl });
    await client.connect();
    try {
      const result = await client.query(sql);
      return (result.rows ?? []).map((row: Record<string, unknown>) =>
        Object.values(row).map((value) =>
          value === null || value === undefined ? "" : String(value),
        ),
      );
    } finally {
      await client.end();
    }
  }

  private pathFor(service: FullChainService, path: string) {
    const dirs = this.local.dirs;
    if (path === "/data/api-spool") return dirs.apiSpool;
    if (path.startsWith("/data/api-spool/"))
      return join(dirs.apiSpool, basename(path));
    if (path.startsWith("/var/log/cyez/"))
      return join(
        service === "db" ? dirs.dbLogs : dirs.gatewayLogs,
        basename(path),
      );
    if (path === "/var/log/cyez")
      return service === "db" ? dirs.dbLogs : dirs.gatewayLogs;
    throw new Error(`LOCAL_STACK_PATH_UNSUPPORTED: ${service}:${path}`);
  }

  async readFile(service: FullChainService, path: string) {
    return readFile(this.pathFor(service, path), "utf8");
  }

  async listFiles(service: FullChainService, dir: string) {
    try {
      return await readdir(this.pathFor(service, dir));
    } catch {
      return [];
    }
  }

  async readDirectory(service: FullChainService, dir: string) {
    const directory = this.pathFor(service, dir);
    const files = await this.listFiles(service, dir);
    const parts: string[] = [];
    for (const file of files) {
      parts.push(`###FILE:${join(directory, file)}`);
      parts.push(await readFile(join(directory, file), "utf8"));
      parts.push("\n");
    }
    return parts.join("\n");
  }

  async exec(_service: FullChainService, _argv: string[]): Promise<string> {
    throw new Error("LOCAL_STACK_EXEC_UNSUPPORTED");
  }

  async sh(_service: FullChainService, _script: string): Promise<string> {
    throw new Error("LOCAL_STACK_EXEC_UNSUPPORTED");
  }

  async composePs(): Promise<ComposePsEntry[]> {
    const state = await this.state();
    const entry = async (
      name: string,
      pid: number | undefined,
      health?: string,
    ): Promise<ComposePsEntry> => ({
      Service: name,
      State: (await alive(pid)) ? "running" : "exited",
      Health: health,
    });
    return [
      {
        Service: "db",
        State: this.dbStopped ? "exited" : "running",
        Health: this.dbStopped ? undefined : "healthy",
      },
      await entry("api", state.apiPid, "healthy"),
      await entry("log-ingest", state.ingestPid),
      await entry("gateway", state.nginxPid),
      { Service: "migrate", State: "exited", ExitCode: 0 },
    ];
  }

  async inspect(): Promise<InspectedContainer[]> {
    // Container-only inspection (networks, mounts, capabilities) is not applicable.
    return [];
  }

  async restart(service: FullChainService) {
    if (service === "db") {
      const control = this.local.dbControl;
      if (!control) throw new Error("LOCAL_STACK_DB_CONTROL_UNSUPPORTED");
      const stopped = await runCommand(control.stop[0], control.stop.slice(1));
      if (stopped.code !== 0)
        throw new Error(`LOCAL_DB_STOP_FAILED: ${stopped.stderr}`);
      const started = await runCommand(
        control.start[0],
        control.start.slice(1),
      );
      if (started.code !== 0)
        throw new Error(`LOCAL_DB_START_FAILED: ${started.stderr}`);
      await this.waitReady();
      return;
    }
    await this.stop(service);
    await this.start(service);
  }

  async stop(service: FullChainService) {
    const state = await this.state();
    if (service === "db") {
      const control = this.local.dbControl;
      if (!control) throw new Error("LOCAL_STACK_DB_CONTROL_UNSUPPORTED");
      const stopped = await runCommand(control.stop[0], control.stop.slice(1));
      if (stopped.code !== 0)
        throw new Error(`LOCAL_DB_STOP_FAILED: ${stopped.stderr}`);
      this.dbStopped = true;
      return;
    }
    if (service === "api") {
      await this.stopPid(state.apiPid);
      state.apiPid = undefined;
      await this.waitPortFree(this.apiPort()).catch(() => {});
    } else if (service === "log-ingest") {
      await this.stopPid(state.ingestPid);
      state.ingestPid = undefined;
    } else if (service === "gateway") {
      await this.stopPid(state.nginxPid);
      state.nginxPid = undefined;
    } else {
      throw new Error(`LOCAL_STACK_STOP_UNSUPPORTED: ${service}`);
    }
    await this.saveState(state);
  }

  async start(service: FullChainService) {
    if (service === "db") {
      const control = this.local.dbControl;
      if (!control) throw new Error("LOCAL_STACK_DB_CONTROL_UNSUPPORTED");
      const started = await runCommand(
        control.start[0],
        control.start.slice(1),
      );
      if (started.code !== 0)
        throw new Error(`LOCAL_DB_START_FAILED: ${started.stderr}`);
      this.dbStopped = false;
      await this.waitReady();
      return;
    }
    if (service === "api") await this.startApi();
    else if (service === "log-ingest") await this.startIngest();
    else if (service === "gateway") await this.spawnNginx();
    else throw new Error(`LOCAL_STACK_START_UNSUPPORTED: ${service}`);
    await this.waitReady();
  }

  async updateEnv(updates: Record<string, string>) {
    for (const [key, value] of Object.entries(updates)) {
      if (/[\r\n]/.test(value))
        throw new Error(`FULL_CHAIN_ENV_INVALID: ${key}`);
      this.envOverrides[key] = value;
      this.local.commands.api.env[key] = value;
    }
  }

  async recreate(service: FullChainService) {
    if (service === "api") {
      await this.stop("api");
      await this.startApi();
      await this.waitReady();
      return;
    }
    await this.restart(service);
  }

  async restartProject() {
    await this.stop("api");
    await this.stop("log-ingest");
    await this.stop("gateway");
    await this.startApi();
    await this.startIngest();
    await this.spawnNginx();
    await this.waitReady();
  }

  async composeLogs() {
    const parts: string[] = [];
    const files = await readdir(this.local.dirs.logs).catch(
      () => [] as string[],
    );
    for (const file of files)
      parts.push(
        `### ${file}\n` +
          (await readFile(join(this.local.dirs.logs, file), "utf8")),
      );
    for (const file of ["error.log", "access.jsonl"]) {
      try {
        parts.push(
          `### gateway/${file}\n` +
            (await readFile(join(this.local.dirs.gatewayLogs, file), "utf8")),
        );
      } catch {
        // File is created on first write.
      }
    }
    return parts.join("\n").slice(-200_000);
  }

  async saveDiagnostics(directory: string) {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "compose-ps.json"),
      JSON.stringify(await this.composePs(), null, 2),
    );
    await writeFile(
      join(directory, "compose-logs.txt"),
      await this.composeLogs(),
    );
    await writeFile(
      join(directory, "connection-redacted.json"),
      JSON.stringify(redactedConnection(this.connection), null, 2),
    );
  }
}
