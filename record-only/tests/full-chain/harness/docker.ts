import { spawn } from "node:child_process";

export interface CommandOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Do not throw on non-zero exit; inspect the result instead. */
  allowFailure?: boolean;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: Error;
}

export interface DockerRunnerOptions {
  project: string;
  /** Host absolute compose file paths, base file first. */
  composeFiles: string[];
  /** Host absolute env-file path. */
  envFile: string;
  projectDirectory: string;
  /** Explicitly use `wsl.exe -u root --exec docker` instead of the local CLI. */
  wsl?: boolean;
  /** Test/automation hook: replace the docker executable (arguments are prefixed). */
  executable?: { file: string; args: string[] };
  cwd?: string;
}

function limitText(value: string, max = 200_000) {
  return value.length <= max
    ? value
    : `…(${value.length - max} bytes truncated)…\n` + value.slice(-max);
}

function spawnCommand(
  file: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    const max = options.maxBuffer ?? 64 * 1024 * 1024;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      result.stdout = limitText(Buffer.concat(stdout).toString("utf8"));
      result.stderr = limitText(Buffer.concat(stderr).toString("utf8"));
      resolve(result);
    };
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill("SIGKILL");
      },
      Math.max(1_000, options.timeoutMs ?? 120_000),
    );
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      if (Buffer.concat(stdout).length < max) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.concat(stderr).length < max) stderr.push(chunk);
    });
    child.on("error", (error) =>
      finish({ code: -1, stdout: "", stderr: "", timedOut, spawnError: error }),
    );
    child.on("close", (code) =>
      finish({ code: code ?? -1, stdout: "", stderr: "", timedOut }),
    );
  });
}

/**
 * Cross-platform Docker/Compose runner.
 *
 * Normal Windows use (Docker Desktop CLI on PATH): `docker ...`.
 * WSL Docker Engine without Docker Desktop CLI: set CYEZ_DOCKER_WSL=1 and every
 * command runs as `wsl.exe -u root --exec docker ...`, with host paths converted
 * through `wslpath -a` so compose bind mounts resolve inside the distro.
 */
export class DockerRunner {
  readonly wsl: boolean;
  private readonly executable?: { file: string; args: string[] };
  private paths?: Promise<{ files: string[]; envFile: string; cwd: string }>;
  private pathCache = new Map<string, Promise<string>>();

  constructor(readonly options: DockerRunnerOptions) {
    this.wsl = options.wsl ?? process.env.CYEZ_DOCKER_WSL === "1";
    this.executable = options.executable;
  }

  private base(file: string, args: string[]) {
    if (this.executable)
      return {
        file: this.executable.file,
        args: [...this.executable.args, ...args],
      };
    if (this.wsl)
      return { file: "wsl.exe", args: ["-u", "root", "--exec", file, ...args] };
    return { file, args };
  }

  async docker(args: string[], options: CommandOptions = {}) {
    const { file, args: full } = this.base("docker", args);
    return spawnCommand(file, full, {
      cwd: this.options.cwd ?? this.options.projectDirectory,
      timeoutMs: options.timeoutMs,
      env: options.env,
      maxBuffer: options.maxBuffer,
    });
  }

  /** Convert a planner-side path into a path the Docker engine can bind-mount. */
  async enginePath(hostPath: string): Promise<string> {
    if (!this.wsl) return hostPath.replaceAll("\\", "/");
    const cached = this.pathCache.get(hostPath);
    if (cached) return cached;
    const converted = (async () => {
      const result = await spawnCommand(
        "wsl.exe",
        ["-u", "root", "--exec", "wslpath", "-a", hostPath],
        { timeoutMs: 30_000, cwd: this.options.projectDirectory },
      );
      if (result.code !== 0)
        throw new Error(
          `FULL_CHAIN_WSL_PATH_FAILED: wslpath ${hostPath}\n${result.stderr}`,
        );
      return result.stdout.trim();
    })();
    this.pathCache.set(hostPath, converted);
    return converted;
  }

  private async resolvedPaths() {
    this.paths ??= (async () => ({
      files: await Promise.all(
        this.options.composeFiles.map((file) => this.enginePath(file)),
      ),
      envFile: await this.enginePath(this.options.envFile),
      cwd: await this.enginePath(this.options.projectDirectory),
    }))();
    return this.paths;
  }

  async compose(args: string[], options: CommandOptions = {}) {
    const paths = await this.resolvedPaths();
    const full = [
      "compose",
      ...paths.files.flatMap((file) => ["-f", file]),
      "--env-file",
      paths.envFile,
      "--project-name",
      this.options.project,
      ...args,
    ];
    const result = await this.docker(full, {
      ...options,
      cwd: paths.cwd,
      timeoutMs: options.timeoutMs ?? 120_000,
    });
    if (result.code !== 0 && options.allowFailure !== true)
      throw new Error(
        `FULL_CHAIN_COMPOSE_FAILED: docker compose ${args.join(" ")} exited ${result.code}` +
          (result.timedOut ? " (timeout)" : "") +
          `\n${result.stderr.trim()}\n${result.stdout.trim()}`,
      );
    return result;
  }

  async composeJson<T = unknown>(
    args: string[],
    options: CommandOptions = {},
  ): Promise<T> {
    const result = await this.compose(args, options);
    return parseComposeJson<T>(result.stdout);
  }

  async assertAvailable(): Promise<void> {
    const info = await this.docker(["info", "--format", "{{.ServerVersion}}"], {
      timeoutMs: 30_000,
      allowFailure: true,
    });
    if (info.code !== 0)
      throw new Error(
        "FULL_CHAIN_DOCKER_UNAVAILABLE: Docker Engine is not reachable.\n" +
          "Windows: start Docker Desktop and keep it running; from PowerShell run the suite in record-only/.\n" +
          "WSL Docker Engine without Docker Desktop CLI: set CYEZ_DOCKER_WSL=1.\n" +
          (info.stderr.trim() || info.spawnError?.message || ""),
      );
    const compose = await this.docker(["compose", "version", "--short"], {
      timeoutMs: 30_000,
      allowFailure: true,
    });
    if (compose.code !== 0)
      throw new Error(
        "FULL_CHAIN_DOCKER_COMPOSE_UNAVAILABLE: Docker Compose v2 plugin is required " +
          `(docker compose version failed).\n${compose.stderr.trim()}`,
      );
  }
}

/**
 * Compose v2.21+ prints a JSON array for `--format json`; older releases print
 * one JSON object per line. Accept both so the harness works across versions.
 */
export function parseComposeJson<T = unknown>(stdout: string): T {
  const text = stdout.trim();
  if (!text) return [] as unknown as T;
  if (text.startsWith("[")) return JSON.parse(text) as T;
  const items = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return items as unknown as T;
}

export interface ComposePsEntry {
  ID?: string;
  Name?: string;
  Service: string;
  State: string;
  Health?: string;
  ExitCode?: number;
  Publishers?: Array<{
    URL?: string;
    TargetPort?: number;
    PublishedPort?: number;
    Protocol?: string;
  }>;
}

export interface InspectedContainer {
  id: string;
  name: string;
  service?: string;
  image?: string;
  imageId?: string;
  privileged: boolean;
  capAdd: string[];
  capDrop: string[];
  readonlyRootfs: boolean;
  securityOpt: string[];
  hostNetwork: boolean;
  networks: string[];
  mounts: Array<{ type?: string; source?: string; destination?: string }>;
  labels: Record<string, string>;
}
