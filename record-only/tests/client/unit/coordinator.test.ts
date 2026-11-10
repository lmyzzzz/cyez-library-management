// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "@record/protocol";
import { identity } from "../../helpers/config.js";

const traffic: {
  method: string;
  path: string;
  body: unknown;
  token: unknown;
}[] = [];
let response: (method: string, path: string, body: unknown) => unknown;
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from("encrypted:" + s),
    decryptString: (b: Buffer) => b.toString().slice("encrypted:".length),
  },
}));
vi.mock("../../../apps/teacher/src/main/transport.js", () => ({
  PinnedTransport: class {
    origin = "https://127.0.0.1:8443";
    async request(method: string, path: string, body: unknown, token: unknown) {
      traffic.push({ method, path, body, token });
      return response(method, path, body);
    }
    async close() {}
  },
}));
import { Coordinator } from "../../../apps/teacher/src/main/coordinator.js";
import { LocalStore } from "../../../apps/teacher/src/main/store.js";

const directories: string[] = [];
let store: LocalStore;
let coordinator: Coordinator;
const events: unknown[] = [];
beforeEach(async () => {
  traffic.length = 0;
  events.length = 0;
  response = (_method, path) =>
    path === "/api/v1/auth/login"
      ? { token: "test-token" }
      : path === "/api/v1/logs/batch"
        ? { acked: [] }
        : path === "/api/v1/scan-previews"
          ? { id: randomUUID(), mode: "start" }
          : {};
  const directory = await mkdtemp(join(tmpdir(), "cyez-coordinator-"));
  directories.push(directory);
  store = new LocalStore(join(directory, "library.sqlite"));
  await store.init();
  coordinator = new Coordinator(
    store,
    randomUUID(),
    "integration",
    identity,
    (e) => events.push(e),
  );
});
afterEach(async () => {
  await store.close().catch(() => {});
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function login() {
  await coordinator.call("configure", {
    ip: "127.0.0.1",
    port: 8443,
    pin: "ab".repeat(32),
  });
  await coordinator.call("login", {
    username: "teacher",
    password: "secret",
    remember: true,
  });
}

describe("C-U main 协调器", () => {
  it("校园配置发送后立即清除，失败也不写本地队列、设置或日志", async () => {
    await login();
    const beforeSettings = JSON.stringify(await store.settings.findAll());
    const beforeMetrics = await store.metrics();
    let received: unknown;
    let reject!: (error: unknown) => void;
    response = (_method, path, body) => {
      expect(path).toBe("/api/v1/provider-config");
      received = structuredClone(body);
      return new Promise((_resolve, fail) => {
        reject = fail;
      });
    };
    const input = {
      host: "sql.example",
      port: 1433,
      username: "readonly",
      password: "never-save-this-api-password",
      caPem: "",
      uidEncoding: "decimal",
    };
    const pending = coordinator.call("replaceProviderConfig", input);
    expect(received).toMatchObject({
      host: "sql.example",
      password: "never-save-this-api-password",
    });
    expect(Object.values(input).every((value) => value === undefined)).toBe(
      true,
    );
    reject(new ApiError("NETWORK_TIMEOUT", 503));
    await expect(pending).rejects.toMatchObject({ code: "NETWORK_TIMEOUT" });
    expect(JSON.stringify(await store.settings.findAll())).toBe(beforeSettings);
    expect(await store.metrics()).toMatchObject({
      pendingCommands: beforeMetrics.pendingCommands,
      pendingLogs: beforeMetrics.pendingLogs,
    });
    const invalid = { password: "invalid-not-persisted" };
    await expect(
      coordinator.call("replaceProviderConfig", invalid),
    ).rejects.toThrow();
    expect(invalid.password).toBeUndefined();
  });
  it("自动登录只在加密保存密码后启用，启动按来源恢复，退出后禁用", async () => {
    await coordinator.call("configure", {
      ip: "127.0.0.1",
      port: 8443,
      pin: "ab".repeat(32),
    });
    await expect(
      coordinator.call("login", {
        username: "teacher",
        password: "secret",
        remember: false,
        autoLogin: true,
      }),
    ).rejects.toThrow("AUTO_LOGIN_REQUIRES_SAVED_PASSWORD");
    expect(await store.get("credentials")).toBeNull();
    await coordinator.call("login", {
      username: "teacher",
      password: "secret",
      remember: true,
      autoLogin: true,
    });
    expect(await store.get("autoLogin")).toBe("true");
    const before = traffic.filter(
      (t) => t.path === "/api/v1/auth/login",
    ).length;
    const restarted = new Coordinator(
      store,
      coordinator.clientId,
      "integration",
      identity,
      (e) => events.push(e),
    );
    await restarted.init();
    expect((await restarted.status()).authenticated).toBe(false);
    await restarted.autoLoginOnStartup();
    expect((await restarted.status()).authenticated).toBe(true);
    expect(traffic.filter((t) => t.path === "/api/v1/auth/login")).toHaveLength(
      before + 1,
    );
    await restarted.call("logout", {});
    expect(await store.get("autoLogin")).toBe("false");
  });
  it("连接、加密保存、刷卡门控与原卡号生命周期", async () => {
    await coordinator.init();
    expect((await coordinator.status()).authenticated).toBe(false);
    await login();
    expect((await coordinator.status()).authenticated).toBe(true);
    expect(await store.get("credentials")).toContain(
      Buffer.from("encrypted:").toString("base64").slice(0, 8),
    );
    const input = {
      scanId: randomUUID(),
      studentId: "a".repeat(64),
      hashVersion: "v1",
      card: { issuer: "test", uidHex: "00000001" },
      source: "integration",
    } as const;
    await coordinator.onCard({ ...input, card: { ...input.card } });
    expect(traffic.some((t) => t.path === "/api/v1/scan-previews")).toBe(false);
    await coordinator.call("gate", {
      page: "devices",
      modal: false,
      submitting: false,
    });
    const card = { ...input.card };
    await coordinator.onCard({ ...input, card });
    expect(traffic.some((t) => t.path === "/api/v1/scan-previews")).toBe(true);
    expect(card).toEqual({ issuer: "", uidHex: "" });
    expect(events.some((e) => (e as { type: string }).type === "scan")).toBe(
      true,
    );
    await coordinator.call("gate", {
      page: "devices",
      modal: true,
      submitting: false,
    });
    const before = traffic.length;
    await coordinator.onCard({ ...input, card: { ...input.card } });
    expect(traffic).toHaveLength(before);
    await coordinator.call("clearSaved", {});
    expect((await coordinator.status()).savedCredentials).toBe(false);
  });

  it("先落 SQLite 意图，响应丢失后原键查询恢复且不跨 origin", async () => {
    await login();
    const initial = response;
    response = (method, path, body) => {
      if (method === "POST" && path === "/api/v1/devices")
        throw new ApiError("NETWORK_TIMEOUT", 503);
      return initial(method, path, body);
    };
    await expect(
      coordinator.command("POST", "/api/v1/devices", { code: "P-1" }),
    ).rejects.toThrow("COMMAND_PENDING");
    const pending = await store.pending("https://127.0.0.1:8443");
    expect(pending).toHaveLength(1);
    expect((await coordinator.status()).pendingCommands).toBe(1);
    coordinator.online = true;
    await expect(
      coordinator.command("POST", "/api/v1/devices", { code: "P-2" }),
    ).rejects.toThrow("COMMAND_PENDING");
    response = (method, path, body) =>
      path === `/api/v1/operations/${pending[0].requestId}`
        ? { result: { deviceId: "recovered" } }
        : initial(method, path, body);
    expect(await coordinator.recover()).toEqual({
      outcomes: [
        {
          requestId: pending[0].requestId,
          state: "committed",
          result: { deviceId: "recovered" },
        },
      ],
    });
    expect(await store.pending("https://127.0.0.1:8443")).toHaveLength(0);
    expect(traffic.filter((t) => t.path === "/api/v1/devices")).toHaveLength(1);
    expect((await coordinator.status()).pendingCommands).toBe(0);
  });

  it("404 时原键重试、业务拒绝落 rejected，日志仅按 ACK 删除", async () => {
    await login();
    const requestId = randomUUID();
    await store.saveIntent({
      requestId,
      origin: "https://127.0.0.1:8443",
      method: "POST",
      path: "/api/v1/devices",
      body: { requestId, code: "RETRY" },
      createdAt: Date.now(),
      state: "pending",
    });
    const initial = response;
    response = (method, path, body) =>
      path.startsWith("/api/v1/operations/")
        ? Promise.reject(new ApiError("NOT_FOUND", 404))
        : initial(method, path, body);
    const result = await coordinator.recover();
    expect(result.outcomes).toEqual([
      { requestId, state: "committed", result: {} },
    ]);
    expect(
      traffic.some(
        (t) =>
          t.path === "/api/v1/devices" &&
          (t.body as { requestId: string }).requestId === requestId,
      ),
    ).toBe(true);
    response = (method, path, body) =>
      path === "/api/v1/devices"
        ? Promise.reject(new ApiError("DEVICE_VERSION_CONFLICT", 409))
        : initial(method, path, body);
    await expect(
      coordinator.command("POST", "/api/v1/devices", { code: "REJECT" }),
    ).rejects.toThrow("DEVICE_VERSION_CONFLICT");
    expect((await coordinator.status()).pendingCommands).toBe(0);
    const logId = randomUUID();
    await store.append({
      logId,
      source: "main",
      level: "info",
      atMs: Date.now(),
      appVersion: "0.1.1",
      code: "APP_STARTED",
    });
    coordinator.online = true;
    response = (method, path, body) =>
      path === "/api/v1/logs/batch"
        ? { acked: [logId] }
        : initial(method, path, body);
    await coordinator.flush();
    expect((await store.logBatch()).some((log) => log.logId === logId)).toBe(
      false,
    );
  });

  it("仅传输层失败才离线，业务 4xx/5xx 响应保持在线", async () => {
    await login();
    expect(coordinator.online).toBe(true);
    const initial = response;
    response = () => Promise.reject(new ApiError("PROVIDER_UNAVAILABLE", 503));
    await expect(
      coordinator.call("history", { page: 1, pageSize: 30 }),
    ).rejects.toThrow("PROVIDER_UNAVAILABLE");
    expect(coordinator.online).toBe(true);
    response = () => Promise.reject(new ApiError("AUTH_REQUIRED", 401));
    await expect(coordinator.call("testConnection", {})).rejects.toThrow(
      "AUTH_REQUIRED",
    );
    expect(coordinator.online).toBe(true);
    response = () =>
      Promise.reject(new ApiError("RECORD_VERSION_CONFLICT", 409));
    await expect(coordinator.call("tags", {})).rejects.toThrow(
      "RECORD_VERSION_CONFLICT",
    );
    expect(coordinator.online).toBe(true);
    response = () => Promise.reject(new ApiError("TLS_OR_NETWORK_FAILED", 503));
    await expect(coordinator.call("testConnection", {})).rejects.toThrow(
      "TLS_OR_NETWORK_FAILED",
    );
    expect(coordinator.online).toBe(false);
    response = initial;
  });

  it("确定性预提交 503 立即拒绝，模糊 503 保持待恢复", async () => {
    await login();
    const initial = response;
    response = (method, path, body) =>
      method === "POST" && path === "/api/v1/devices"
        ? Promise.reject(new ApiError("STORAGE_WRITE_RESTRICTED", 503))
        : initial(method, path, body);
    await expect(
      coordinator.command("POST", "/api/v1/devices", { code: "RESTRICTED" }),
    ).rejects.toThrow("STORAGE_WRITE_RESTRICTED");
    expect(coordinator.online).toBe(true);
    expect(await store.pending("https://127.0.0.1:8443")).toHaveLength(0);
    expect(await store.intents.count({ where: { state: "rejected" } })).toBe(1);
    response = (method, path, body) =>
      method === "POST" && path === "/api/v1/devices"
        ? Promise.reject(new ApiError("SERVICE_UNAVAILABLE", 503))
        : initial(method, path, body);
    await expect(
      coordinator.command("POST", "/api/v1/devices", { code: "AMBIGUOUS" }),
    ).rejects.toThrow("COMMAND_PENDING");
    expect(await store.pending("https://127.0.0.1:8443")).toHaveLength(1);
    response = initial;
  });

  it("REQUEST_FAILED 是可达服务器的响应错误，保持在线", async () => {
    await login();
    const initial = response;
    response = () => Promise.reject(new ApiError("REQUEST_FAILED", 500));
    await expect(coordinator.call("testConnection", {})).rejects.toThrow(
      "REQUEST_FAILED",
    );
    expect(coordinator.online).toBe(true);
    response = initial;
  });

  it("恢复时确定性预提交 503 落 rejected 并清空待恢复意图", async () => {
    await login();
    const requestId = randomUUID();
    await store.saveIntent({
      requestId,
      origin: "https://127.0.0.1:8443",
      method: "POST",
      path: "/api/v1/devices",
      body: { requestId, code: "RESTRICTED" },
      createdAt: Date.now(),
      state: "pending",
    });
    const initial = response;
    response = (method, path, body) =>
      path.startsWith("/api/v1/operations/")
        ? Promise.reject(new ApiError("NOT_FOUND", 404))
        : method === "POST" && path === "/api/v1/devices"
          ? Promise.reject(new ApiError("STORAGE_WRITE_RESTRICTED", 503))
          : initial(method, path, body);
    expect(await coordinator.recover()).toEqual({
      outcomes: [
        { requestId, state: "rejected", code: "STORAGE_WRITE_RESTRICTED" },
      ],
    });
    expect(await store.pending("https://127.0.0.1:8443")).toHaveLength(0);
    expect(
      await store.intents.count({ where: { requestId, state: "rejected" } }),
    ).toBe(1);
    response = initial;
  });

  it("服务端登出失败仍清除本地在线、令牌与自动登录", async () => {
    await coordinator.call("configure", {
      ip: "127.0.0.1",
      port: 8443,
      pin: "ab".repeat(32),
    });
    await coordinator.call("login", {
      username: "teacher",
      password: "secret",
      remember: true,
      autoLogin: true,
    });
    expect((await coordinator.status()).authenticated).toBe(true);
    expect(await store.get("autoLogin")).toBe("true");
    response = (method, path) =>
      path === "/api/v1/auth/logout"
        ? Promise.reject(new ApiError("NETWORK_TIMEOUT", 503))
        : Promise.resolve({});
    await expect(coordinator.call("logout", {})).rejects.toThrow(
      "NETWORK_TIMEOUT",
    );
    expect(coordinator.online).toBe(false);
    expect(coordinator.sdk?.authenticated).toBe(false);
    expect(await store.get("autoLogin")).toBe("false");
    expect((await coordinator.status()).authenticated).toBe(false);
  });

  it("版本由构造参数注入状态、日志与启动上报", async () => {
    const versioned = new Coordinator(
      store,
      coordinator.clientId,
      "integration",
      identity,
      (e) => events.push(e),
      "9.9.9",
    );
    await versioned.call("configure", {
      ip: "127.0.0.1",
      port: 8443,
      pin: "ab".repeat(32),
    });
    await versioned.call("login", {
      username: "teacher",
      password: "secret",
      remember: false,
    });
    expect((await versioned.status()).version).toBe("9.9.9");
    expect(
      traffic.find((t) => t.path === "/api/v1/clients/startup")?.body,
    ).toEqual({ version: "9.9.9" });
    await versioned.init();
    expect(
      (await store.logBatch()).some((log) => log.appVersion === "9.9.9"),
    ).toBe(true);
  });

  it("IPC 白名单、只读查询、测试接口和登录来源隔离", async () => {
    await login();
    await expect(coordinator.call("unsupported" as never, {})).rejects.toThrow(
      "IPC_ACTION_INVALID",
    );
    await expect(
      coordinator.call("configure", {
        ip: "127.0.0.1",
        port: 8443,
        pin: "invalid",
      }),
    ).rejects.toThrow();
    await coordinator.call("devices", { page: 1, pageSize: 30 });
    await coordinator.call("history", { page: 1, pageSize: 30 });
    await coordinator.call("tags", {});
    await coordinator.call("testConnection", {});
    await coordinator.call("uiError", {});
    await coordinator.call("integrationScan", { fixture: "unknown" });
    expect(
      traffic.some((t) => t.path.startsWith("/api/v1/usage-records?")),
    ).toBe(true);
    expect(traffic.some((t) => t.path === "/api/v1/scan-previews")).toBe(false);
    await coordinator.call("logout", {});
    expect((await coordinator.status()).authenticated).toBe(false);
    await coordinator.call("loginSaved", {});
    expect((await coordinator.status()).authenticated).toBe(true);
  });

  it("关闭时清理连接并关闭 SQLite", async () => {
    await login();
    await coordinator.close();
    expect(coordinator.sdk?.authenticated).toBe(false);
    await expect(store.get("connection")).rejects.toThrow();
  });
});
