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
      appVersion: "0.1.0",
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
