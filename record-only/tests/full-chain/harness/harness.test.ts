import { createHash, X509Certificate } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DockerRunner, parseComposeJson } from "./docker.js";
import {
  connectionPath,
  loadConnection,
  redactedConnection,
  repoRoot,
  runDirectory,
  writeConnection,
  assertIsolatedConnection,
  type FullChainConnection,
} from "./connection.js";
import { prepareDockerEnvironment, findFreePort } from "./env.js";
import { waitFor } from "./stack.js";

async function fakeDocker() {
  const directory = join(repoRoot, "runtime/full-chain-harness-unit");
  await mkdir(directory, { recursive: true });
  const script = join(directory, "fake-docker.mjs");
  await writeFile(
    script,
    `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n");
process.stdout.write(process.env.FAKE_DOCKER_STDOUT ?? "");
process.stderr.write(process.env.FAKE_DOCKER_STDERR ?? "");
process.exit(Number(process.env.FAKE_DOCKER_CODE ?? 0));
`,
  );
  return { script, log: join(directory, "calls.log") };
}

describe("全链路 harness：Docker 编排与隔离环境", () => {
  it("宿主变量不能覆盖测试卷前缀，错误 env 在执行 Docker 前拒绝", async () => {
    const directory = join(repoRoot, "runtime/full-chain-harness-unit");
    await mkdir(directory, { recursive: true });
    const envFile = join(directory, "isolation.env");
    await writeFile(envFile, "APP_ENV=integration\nDATA_PREFIX=cyez-fc-unit\n");
    const runner = new DockerRunner({
      project: "cyez-fc-unit",
      composeFiles: [],
      envFile,
      projectDirectory: repoRoot,
      isolateEnvironment: true,
      wsl: false,
      executable: {
        file: process.execPath,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({prefix:process.env.DATA_PREFIX,mode:process.env.APP_ENV}))",
          "--",
        ],
      },
    });
    const result = await runner.compose(["ps"], {
      env: { ...process.env, DATA_PREFIX: "production", APP_ENV: "production" },
    });
    expect(JSON.parse(result.stdout)).toEqual({});
    await writeFile(envFile, "APP_ENV=integration\nDATA_PREFIX=production\n");
    await expect(runner.compose(["down", "--volumes"])).rejects.toThrow(
      /ENV_NOT_ISOLATED/,
    );
  });

  it("本地诊断同时移除进程环境中的共享口令和数据库 URL", () => {
    const connection = {
      password: "teacher-secret",
      local: {
        ownerUrl: "owner-secret",
        runtimeUrl: "runtime-secret",
        adminUrl: "admin-secret",
        commands: { api: { env: { TEACHER_PASSWORD: "teacher-secret" } } },
      },
    } as unknown as FullChainConnection;
    const output = JSON.stringify(redactedConnection(connection));
    for (const secret of [
      "teacher-secret",
      "owner-secret",
      "runtime-secret",
      "admin-secret",
    ])
      expect(output).not.toContain(secret);
  });

  it("Compose JSON 输出兼容数组和逐行两种格式", () => {
    expect(parseComposeJson('[{"Service":"api"}]')).toEqual([
      { Service: "api" },
    ]);
    expect(parseComposeJson('{"Service":"api"}\n{"Service":"db"}\n')).toEqual([
      { Service: "api" },
      { Service: "db" },
    ]);
    expect(parseComposeJson("")).toEqual([]);
  });

  it("Compose 命令包含两个文件、独立 env 与项目名；失败带诊断", async () => {
    const fake = await fakeDocker();
    await writeFile(fake.log, "");
    const runner = new DockerRunner({
      project: "cyez-fc-unit",
      composeFiles: ["/repo/compose.yaml", "/repo/override.yaml"],
      envFile: "/repo/runtime/compose.env",
      projectDirectory: repoRoot,
      executable: { file: process.execPath, args: [fake.script, "--"] },
    });
    const previous = { ...process.env };
    try {
      process.env.FAKE_DOCKER_LOG = fake.log;
      process.env.FAKE_DOCKER_STDOUT = '[{"Service":"api"}]';
      const result = await runner.compose(["ps", "--format", "json"]);
      expect(result.code).toBe(0);
      const call = JSON.parse(
        (await readFile(fake.log, "utf8")).trim().split("\n").at(-1)!,
      ) as string[];
      expect(call).toEqual([
        "compose",
        "-f",
        "/repo/compose.yaml",
        "-f",
        "/repo/override.yaml",
        "--env-file",
        "/repo/runtime/compose.env",
        "--project-name",
        "cyez-fc-unit",
        "ps",
        "--format",
        "json",
      ]);

      process.env.FAKE_DOCKER_CODE = "1";
      process.env.FAKE_DOCKER_STDERR = "compose failed for test";
      await expect(runner.compose(["up", "-d"])).rejects.toThrow(
        /FULL_CHAIN_COMPOSE_FAILED[\s\S]*compose failed for test/,
      );
      await expect(
        runner.compose(["up", "-d"], { allowFailure: true }),
      ).resolves.toMatchObject({ code: 1 });
    } finally {
      for (const key of Object.keys(process.env))
        if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  });

  it("可用性检查报告 Docker Engine 与 Compose 插件缺失", async () => {
    const fake = await fakeDocker();
    const runner = new DockerRunner({
      project: "cyez-fc-unit",
      composeFiles: ["/repo/compose.yaml"],
      envFile: "/repo/compose.env",
      projectDirectory: repoRoot,
      executable: { file: process.execPath, args: [fake.script, "--"] },
    });
    const previous = { ...process.env };
    try {
      process.env.FAKE_DOCKER_LOG = fake.log;
      process.env.FAKE_DOCKER_STDOUT = "24.0.7";
      await expect(runner.assertAvailable()).resolves.toBeUndefined();
      process.env.FAKE_DOCKER_CODE = "1";
      await expect(runner.assertAvailable()).rejects.toThrow(
        /FULL_CHAIN_DOCKER_UNAVAILABLE/,
      );
    } finally {
      for (const key of Object.keys(process.env))
        if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  });

  it("每次运行生成独立的 env、secrets、端口与镜像标签，不触碰 .env.integration", async () => {
    const fake = await fakeDocker();
    const runner = new DockerRunner({
      project: "cyez-fc-unit",
      composeFiles: [join(repoRoot, "compose.yaml")],
      envFile: join(repoRoot, "runtime/ignored.env"),
      projectDirectory: repoRoot,
      executable: { file: process.execPath, args: [fake.script, "--"] },
    });
    const integrationBefore = await readFile(
      join(repoRoot, ".env.integration"),
      "utf8",
    ).catch(() => undefined);
    const runIds = ["unit-a", "unit-b"];
    const prepared = [];
    try {
      for (const runId of runIds)
        prepared.push(
          await prepareDockerEnvironment({ runner, runId, port: 0 }),
        );
      const env = await readFile(prepared[0].envFile, "utf8");
      expect(env).toContain("APP_ENV=integration");
      expect(env).toContain("PROVIDER_MODE=module");
      expect(env).toContain(`DATA_PREFIX=cyez-fc-${runIds[0]}`);
      expect(env).toContain("API_IMAGE=cyez-record-only");
      expect(env).toContain(`RELEASE_TAG=fc-${runIds[0]}`);
      expect(env).toContain(`HTTPS_PORT=${prepared[0].port}`);
      expect(env).toMatch(/FULL_CHAIN_SECRETS_DIR=(?:[A-Za-z]:)?\/.+/);
      expect(env).toMatch(
        /FULL_CHAIN_FIXTURES_DIR=(?:[A-Za-z]:)?\/.+tests\/full-chain\/fixtures/,
      );
      expect(prepared[0].port).toBeGreaterThan(0);
      expect(prepared[0].port).not.toBe(prepared[1].port);

      const secrets = [
        "server.crt",
        "server.key",
        "db-password",
        "migration-database-url",
        "runtime-database-url",
        "provider-config-key",
      ];
      for (const file of secrets)
        expect(
          (await readFile(join(prepared[0].secretsDir, file), "utf8")).length,
        ).toBeGreaterThan(0);
      const cert = await readFile(
        join(prepared[0].secretsDir, "server.crt"),
        "utf8",
      );
      const pin = createHash("sha256")
        .update(new X509Certificate(cert).raw)
        .digest("hex");
      expect(prepared[0].connection.certPinSha256).toBe(pin);
      expect(prepared[0].connection).toMatchObject({
        version: 1,
        mode: "docker",
        runId: runIds[0],
      });
      expect(prepared[0].connection.docker?.files).toHaveLength(2);
      expect(prepared[0].connection.docker?.project).toBe("cyez-fc-unit-a");
      await expect(
        prepareDockerEnvironment({ runner, runId: runIds[0], port: 0 }),
      ).rejects.toThrow(/EEXIST/);

      const integrationAfter = await readFile(
        join(repoRoot, ".env.integration"),
        "utf8",
      ).catch(() => undefined);
      expect(integrationAfter).toBe(integrationBefore);
    } finally {
      for (const runId of runIds) {
        const directory = runDirectory(runId);
        if (!directory.startsWith(join(repoRoot, "runtime/full-chain/")))
          throw new Error(`UNSAFE_CLEANUP_PATH: ${directory}`);
        await rm(directory, { recursive: true, force: true });
      }
      await rm(join(repoRoot, "runtime/full-chain-harness-unit"), {
        recursive: true,
        force: true,
      });
    }
  });

  it("连接文件可回读、校验必填字段且诊断信息不含口令", async () => {
    const fake = await fakeDocker();
    const runner = new DockerRunner({
      project: "cyez-fc-unit",
      composeFiles: [join(repoRoot, "compose.yaml")],
      envFile: join(repoRoot, "runtime/ignored.env"),
      projectDirectory: repoRoot,
      executable: { file: process.execPath, args: [fake.script, "--"] },
    });
    const runId = "unit-connection";
    const target = join(
      repoRoot,
      "runtime/full-chain-harness-unit/connection.json",
    );
    const previous = process.env.FULL_CHAIN_CONNECTION;
    try {
      process.env.FULL_CHAIN_CONNECTION = target;
      const prepared = await prepareDockerEnvironment({
        runner,
        runId,
        port: 0,
      });
      const connection: FullChainConnection = prepared.connection;
      const path = await writeConnection(connection);
      expect(path).toBe(target);
      const loaded = await loadConnection(target);
      expect(loaded).toEqual(connection);
      expect(() =>
        assertIsolatedConnection({
          ...loaded,
          docker: { ...loaded.docker!, project: "cyez-record-only" },
        }),
      ).toThrow(/NOT_ISOLATED/);
      expect(() => runDirectory("../outside")).toThrow(/RUN_ID_INVALID/);
      const redacted = redactedConnection(loaded);
      expect(redacted.password).toBe("<redacted>");
      expect(JSON.stringify(redacted)).not.toContain(connection.password);

      await writeFile(
        target,
        JSON.stringify({ ...connection, password: null }),
      );
      await expect(loadConnection(target)).rejects.toThrow(
        /FULL_CHAIN_CONNECTION_INVALID: missing password/,
      );
      await rm(target, { force: true });
      await expect(loadConnection(target)).rejects.toThrow(
        /FULL_CHAIN_NOT_PROVISIONED/,
      );
    } finally {
      if (previous === undefined) delete process.env.FULL_CHAIN_CONNECTION;
      else process.env.FULL_CHAIN_CONNECTION = previous;
      await rm(runDirectory(runId), { recursive: true, force: true });
    }
  });

  it("等待器在超时前返回真值，否则报 FULL_CHAIN_TIMEOUT", async () => {
    let count = 0;
    await expect(
      waitFor("counter", async () => ++count === 3, {
        timeoutMs: 5_000,
        intervalMs: 10,
      }),
    ).resolves.toBe(true);
    await expect(
      waitFor("never", async () => false, {
        timeoutMs: 100,
        intervalMs: 10,
      }),
    ).rejects.toThrow(/FULL_CHAIN_TIMEOUT: never/);
    const port = await findFreePort();
    expect(port).toBeGreaterThanOrEqual(49_152);
    expect(port).toBeLessThan(65_536);
    expect(connectionPath()).toBeTruthy();
  });
});
