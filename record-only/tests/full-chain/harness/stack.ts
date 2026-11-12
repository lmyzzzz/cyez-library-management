import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DockerRunner,
  parseComposeJson,
  type ComposePsEntry,
  type InspectedContainer,
} from "./docker.js";
import {
  assertIsolatedConnection,
  redactedConnection,
  type FullChainConnection,
} from "./connection.js";
import { Gateway, type GatewayResponse } from "./gateway.js";
import { snapshotScript, type DatabaseSnapshot } from "./database-snapshot.js";

export type FullChainService =
  | "db"
  | "migrate"
  | "api"
  | "gateway"
  | "log-ingest";

export interface FullChainStack {
  readonly mode: "docker" | "local";
  readonly connection: FullChainConnection;
  readonly gateway: Gateway;
  waitReady(timeoutMs?: number): Promise<void>;
  snapshot(): Promise<DatabaseSnapshot>;
  exec(service: FullChainService, argv: string[]): Promise<string>;
  sh(service: FullChainService, script: string): Promise<string>;
  readFile(service: FullChainService, path: string): Promise<string>;
  listFiles(service: FullChainService, dir: string): Promise<string[]>;
  readDirectory(service: FullChainService, dir: string): Promise<string>;
  composePs(): Promise<ComposePsEntry[]>;
  inspect(): Promise<InspectedContainer[]>;
  restart(service: FullChainService): Promise<void>;
  stop(service: FullChainService): Promise<void>;
  start(service: FullChainService): Promise<void>;
  updateEnv(updates: Record<string, string>): Promise<void>;
  recreate(service: FullChainService): Promise<void>;
  /** Stop and start the deployment without deleting named volumes. */
  restartProject(): Promise<void>;
  composeLogs(): Promise<string>;
  saveDiagnostics(directory: string): Promise<void>;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor<T>(
  description: string,
  fn: () => Promise<T | undefined | false>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let lastValue: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
      lastValue = value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `FULL_CHAIN_TIMEOUT: ${description} after ${timeoutMs}ms` +
      (lastError ? `\nlast error: ${String(lastError)}` : "") +
      (lastValue !== undefined ? `\nlast value: ${safeJson(lastValue)}` : ""),
  );
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value)?.slice(0, 4000);
  } catch {
    return String(value).slice(0, 4000);
  }
}

function quoteShell(value: string) {
  if (value.includes("'"))
    throw new Error(`FULL_CHAIN_UNSAFE_PATH: ${value.replaceAll("'", "?")}`);
  return `'${value}'`;
}

function composeEnvironmentPath(connection: FullChainConnection) {
  if (!connection.docker)
    throw new Error("FULL_CHAIN_DOCKER_CONNECTION_REQUIRED");
  return connection.docker;
}

function serviceHealth(state: ComposePsEntry) {
  return state.Health ?? "";
}

export class DockerStack implements FullChainStack {
  readonly mode = "docker" as const;
  readonly runner: DockerRunner;
  readonly gateway: Gateway;

  constructor(readonly connection: FullChainConnection) {
    assertIsolatedConnection(connection);
    const docker = composeEnvironmentPath(connection);
    this.runner = new DockerRunner({
      project: docker.project,
      composeFiles: docker.files,
      envFile: docker.envFile,
      projectDirectory: docker.projectDirectory,
      wsl: docker.wsl,
      isolateEnvironment: true,
    });
    this.gateway = new Gateway(connection);
  }

  static runnerFor(connection: FullChainConnection) {
    return new DockerStack(connection).runner;
  }

  static async build(connection: FullChainConnection) {
    const stack = new DockerStack(connection);
    await stack.runner.assertAvailable();
    const started = Date.now();
    await stack.runner.compose(["build"], { timeoutMs: 30 * 60_000 });
    return Date.now() - started;
  }

  static async start(connection: FullChainConnection) {
    const stack = new DockerStack(connection);
    await stack.runner.assertAvailable();
    await stack.runner.compose(["up", "-d"], { timeoutMs: 10 * 60_000 });
    await stack.waitReady(10 * 60_000);
    return stack;
  }

  static async destroy(connection: FullChainConnection) {
    if (connection.mode !== "docker" || !connection.docker) return;
    const stack = new DockerStack(connection);
    await stack.runner.compose(
      ["down", "--volumes", "--remove-orphans", "--timeout", "30"],
      { timeoutMs: 5 * 60_000 },
    );
  }

  private async psJson(args: string[] = []) {
    const result = await this.runner.compose(
      ["ps", ...args, "--format", "json"],
      { allowFailure: true, timeoutMs: 30_000 },
    );
    if (result.code !== 0) throw new Error(result.stderr.trim());
    return parseComposeJson<ComposePsEntry[]>(result.stdout);
  }

  composePs(): Promise<ComposePsEntry[]> {
    return this.psJson(["-a"]);
  }

  private async verifyServices() {
    const states = await this.composePs();
    const byService = new Map(states.map((state) => [state.Service, state]));
    const problems: string[] = [];
    const check = (service: string, ok: boolean) => {
      if (!ok) problems.push(`${service}=${safeJson(byService.get(service))}`);
    };
    const db = byService.get("db");
    check("db", db?.State === "running" && serviceHealth(db) === "healthy");
    const api = byService.get("api");
    check("api", api?.State === "running" && serviceHealth(api) === "healthy");
    check("gateway", byService.get("gateway")?.State === "running");
    check("log-ingest", byService.get("log-ingest")?.State === "running");
    const migrate = byService.get("migrate");
    const init = byService.get("init-volumes");
    check("init-volumes", init?.State === "exited" && init.ExitCode === 0);
    check(
      "migrate",
      migrate === undefined ||
        (migrate.State === "exited" &&
          (migrate.ExitCode === undefined || migrate.ExitCode === 0)),
    );
    if (problems.length)
      throw new Error(`FULL_CHAIN_SERVICES_NOT_READY: ${problems.join(" | ")}`);
  }

  async waitReady(timeoutMs = 3 * 60_000) {
    let last: string | undefined;
    await waitFor(
      "compose services healthy and gateway /health/ready = 200",
      async () => {
        try {
          await this.verifyServices();
          const response = await this.gateway.healthReady();
          last = `ready status ${response.status}`;
          return response.status === 200;
        } catch (error) {
          last = String(error);
          return false;
        }
      },
      { timeoutMs },
    ).catch(async (error) => {
      const diagnostics = await this.composeLogs().catch(() => "");
      throw new Error(
        `${String(error)}\nlast: ${last ?? "n/a"}\n${diagnostics.slice(-8000)}`,
      );
    });
  }

  async snapshot(): Promise<DatabaseSnapshot> {
    const script = snapshotScript(
      "file:///app/apps/server/dist/database.js",
      `(await (await import('node:fs/promises')).readFile('/run/secrets/migration_database_url', 'utf8')).trim()`,
      "cyez_runtime",
    );
    const result = await this.runner.compose(
      [
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "migrate",
        "node",
        "--input-type=module",
        "-e",
        script,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return JSON.parse(result.stdout);
  }

  async exec(service: FullChainService, argv: string[]) {
    const result = await this.runner.compose(
      ["exec", "-T", "-e", "HOME=/tmp", service, ...argv],
      { timeoutMs: 120_000 },
    );
    return result.stdout;
  }

  async sh(service: FullChainService, script: string) {
    return this.exec(service, ["sh", "-c", script]);
  }

  async nodeEval(service: "api", script: string) {
    return this.exec(service, ["node", "--input-type=module", "-e", script]);
  }

  async readFile(service: FullChainService, path: string) {
    return this.sh(service, `cat -- ${quoteShell(path)}`);
  }

  async listFiles(service: FullChainService, dir: string) {
    const output = await this.sh(
      service,
      `ls -1 ${quoteShell(dir)} 2>/dev/null || true`,
    );
    return output.replace(/\r\n/g, "\n").split("\n").filter(Boolean);
  }

  async readDirectory(service: FullChainService, dir: string) {
    const quoted = quoteShell(dir);
    return this.sh(
      service,
      `for f in ${quoted}/*; do [ -f "$f" ] || continue; printf '###FILE:%s\\n' "$f"; cat -- "$f"; printf '\\n'; done`,
    );
  }

  private async containerIds() {
    const result = await this.runner.compose(["ps", "-q", "-a"], {
      allowFailure: true,
      timeoutMs: 30_000,
    });
    if (result.code !== 0) throw new Error(result.stderr.trim());
    return result.stdout
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  async inspect(): Promise<InspectedContainer[]> {
    const ids = await this.containerIds();
    if (!ids.length) return [];
    const result = await this.runner.docker(["inspect", ...ids], {
      timeoutMs: 60_000,
    });
    const raw = JSON.parse(result.stdout) as Array<{
      Id: string;
      Name: string;
      Config: { Image: string; Labels?: Record<string, string> };
      Image: string;
      HostConfig: {
        NetworkMode?: string;
        Privileged?: boolean;
        CapAdd?: string[] | null;
        CapDrop?: string[] | null;
        ReadonlyRootfs?: boolean;
        SecurityOpt?: string[] | null;
      };
      NetworkSettings: { Networks?: Record<string, unknown> };
      Mounts: Array<{ Type?: string; Source?: string; Destination?: string }>;
    }>;
    return raw.map((container) => ({
      id: container.Id,
      name: container.Name.replace(/^\//, ""),
      service: container.Config.Labels?.["com.docker.compose.service"],
      image: container.Config.Image,
      imageId: container.Image,
      privileged: container.HostConfig.Privileged === true,
      capAdd: container.HostConfig.CapAdd ?? [],
      capDrop: container.HostConfig.CapDrop ?? [],
      readonlyRootfs: container.HostConfig.ReadonlyRootfs === true,
      securityOpt: container.HostConfig.SecurityOpt ?? [],
      hostNetwork: container.HostConfig.NetworkMode === "host",
      networks: Object.keys(container.NetworkSettings.Networks ?? {}),
      mounts: container.Mounts.map((mount) => ({
        type: mount.Type,
        source: mount.Source,
        destination: mount.Destination,
      })),
      labels: container.Config.Labels ?? {},
    }));
  }

  async restart(service: FullChainService) {
    await this.runner.compose(["restart", service], { timeoutMs: 120_000 });
    await this.waitReady();
  }

  async stop(service: FullChainService) {
    await this.runner.compose(["stop", service], { timeoutMs: 120_000 });
  }

  async start(service: FullChainService) {
    await this.runner.compose(["start", service], { timeoutMs: 120_000 });
    await this.waitReady();
  }

  async updateEnv(updates: Record<string, string>) {
    const docker = composeEnvironmentPath(this.connection);
    const current = await readFile(docker.envFile, "utf8");
    const values = new Map<string, string>();
    for (const line of current.split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      const index = line.indexOf("=");
      if (index > 0) values.set(line.slice(0, index), line.slice(index + 1));
    }
    for (const [key, value] of Object.entries(updates)) {
      if (/[\r\n]/.test(value))
        throw new Error(`FULL_CHAIN_ENV_INVALID: ${key}`);
      values.set(key, value);
    }
    await writeFile(
      docker.envFile,
      Array.from(values, ([key, value]) => `${key}=${value}`).join("\n") + "\n",
    );
  }

  async recreate(service: FullChainService) {
    // Keep the gateway alive: production nginx resolves the replacement API
    // through Docker DNS, including after a shared-password change.
    const services = [service];
    await this.runner.compose(
      ["up", "-d", "--no-deps", "--force-recreate", ...services],
      { timeoutMs: 5 * 60_000 },
    );
    await this.waitReady();
  }

  async restartProject() {
    await this.runner.compose(["down", "--timeout", "30"], {
      timeoutMs: 5 * 60_000,
    });
    await this.runner.compose(["up", "-d"], { timeoutMs: 10 * 60_000 });
    await this.waitReady(10 * 60_000);
  }

  async composeLogs() {
    const result = await this.runner.compose(
      ["logs", "--no-color", "--timestamps", "--tail", "4000"],
      { allowFailure: true, timeoutMs: 120_000 },
    );
    return [result.stdout, result.stderr].filter(Boolean).join("\n");
  }

  async serviceStatus(token: string): Promise<GatewayResponse> {
    return this.gateway.api("GET", "/service-status", { token });
  }

  async saveDiagnostics(directory: string) {
    await mkdir(directory, { recursive: true });
    const write = async (name: string, produce: () => Promise<string>) => {
      try {
        await writeFile(join(directory, name), await produce());
      } catch (error) {
        await writeFile(
          join(directory, name),
          `diagnostics failed: ${String(error)}\n`,
        );
      }
    };
    await Promise.all([
      write("compose-ps.json", async () =>
        JSON.stringify(await this.composePs(), null, 2),
      ),
      write("inspect.json", async () =>
        JSON.stringify(await this.inspect(), null, 2),
      ),
      write("compose-logs.txt", () => this.composeLogs()),
      write("connection-redacted.json", async () =>
        JSON.stringify(redactedConnection(this.connection), null, 2),
      ),
    ]);
  }
}

export async function createStack(
  connection: FullChainConnection,
): Promise<FullChainStack> {
  if (connection.mode === "docker") return new DockerStack(connection);
  const { LocalStack } = await import("./local-stack.js");
  return new LocalStack(connection);
}

export function gatewayFor(connection: FullChainConnection) {
  return new Gateway(connection);
}
