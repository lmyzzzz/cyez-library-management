// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "@record/protocol";
import type {
  BatchAssignment,
  BatchSession,
  StudentDTO,
} from "@record/protocol";
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
  vi.useRealTimers();
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

const cardEvent = () => ({
  scanId: randomUUID(),
  studentId: "a".repeat(64),
  hashVersion: "v1",
  card: { issuer: "test", uidHex: "00000001" },
  source: "integration" as const,
});
const devicesGate = { page: "devices", modal: false, submitting: false };

describe("C-U main 协调器", () => {
  it.each([
    "offline",
    "expired-auth",
    "modal",
    "submitting",
    "cancel",
    "configure",
    "logout",
  ])("当前预览在 %s 状态不允许同卡确认", async (state) => {
    await login();
    await coordinator.call("gate", devicesGate);
    await coordinator.onCard(cardEvent());
    const scan = events.find((e: any) => e.type === "scan") as {
      preview: { id: string };
    };
    const count = traffic.filter(
      (t) => t.path === "/api/v1/scan-previews",
    ).length;
    if (state === "offline" || state === "cancel") coordinator.online = false;
    if (state === "expired-auth") {
      response = () => Promise.reject(new ApiError("AUTH_REQUIRED", 401));
      await expect(coordinator.call("tags", {})).rejects.toThrow();
    }
    if (state === "modal" || state === "submitting")
      await coordinator.call("gate", {
        page: "flow",
        modal: state === "modal",
        submitting: state === "submitting",
      });
    if (state === "cancel") {
      await expect(
        coordinator.call("cancelPreview", { previewId: scan.preview.id }),
      ).rejects.toThrow("OFFLINE_NO_WRITE");
      coordinator.online = true;
    }
    if (state === "configure") await login();
    if (state === "logout") await coordinator.call("logout", {});
    const event = cardEvent();
    await coordinator.onCard(event);
    expect(event.card).toEqual({ issuer: "", uidHex: "" });
    expect(events.filter((e: any) => e.type === "confirm")).toHaveLength(0);
    expect(
      traffic.filter((t) => t.path === "/api/v1/scan-previews"),
    ).toHaveLength(count);
  });

  it("流程中刷另一张卡：取消当前预览并按新卡开始；新卡失败时通知取消", async () => {
    await login();
    await coordinator.call("gate", devicesGate);
    await coordinator.onCard(cardEvent());
    const first = (
      events.find((e: any) => e.type === "scan") as { preview: { id: string } }
    ).preview.id;
    await coordinator.call("gate", { ...devicesGate, page: "flow" });
    const other = () => ({
      ...cardEvent(),
      studentId: "b".repeat(64),
      card: { issuer: "test", uidHex: "00000002" },
    });
    await coordinator.onCard(other());
    expect(
      traffic.filter(
        (t) =>
          t.method === "DELETE" && t.path === `/api/v1/scan-previews/${first}`,
      ),
    ).toHaveLength(1);
    const scans = events.filter((e: any) => e.type === "scan") as {
      preview: { id: string };
    }[];
    expect(scans).toHaveLength(2);
    expect(events.filter((e: any) => e.type === "cancel")).toHaveLength(0);
    // 手动模式下当前卡重复事件只确认，不重复查询校园资料。
    await coordinator.onCard(other());
    expect(events.filter((e: any) => e.type === "confirm")).toHaveLength(1);
    expect(scans).toHaveLength(2);
    // 第三张卡被服务端拒绝：旧流程已取消，刷卡窗口收到 cancel 和提示。
    const initial = response;
    response = (method, path, body) => {
      if (method === "POST" && path === "/api/v1/scan-previews")
        throw new ApiError("STUDENT_NOT_ALLOWED", 403);
      return initial(method, path, body);
    };
    await coordinator.onCard({
      ...cardEvent(),
      studentId: "c".repeat(64),
      card: { issuer: "test", uidHex: "00000003" },
    });
    expect(events.slice(-2)).toEqual([
      { type: "cancel", previewId: scans[1].preview.id },
      { type: "notice", code: "STUDENT_NOT_ALLOWED" },
    ]);
    // 提交中不允许换卡。
    response = initial;
    await coordinator.call("gate", devicesGate);
    await coordinator.onCard(cardEvent());
    await coordinator.call("gate", {
      page: "flow",
      modal: false,
      submitting: true,
    });
    const before = traffic.length;
    await coordinator.onCard(other());
    expect(traffic).toHaveLength(before);
    expect(events.at(-1)).toEqual({
      type: "notice",
      code: "SCAN_RETURN_TO_DEVICES",
    });
  });

  it("流程提交成功后同卡再刷是新刷卡而不是确认", async () => {
    await login();
    await coordinator.call("gate", devicesGate);
    await coordinator.onCard(cardEvent());
    const previewId = (
      events.find((e: any) => e.type === "scan") as { preview: { id: string } }
    ).preview.id;
    await coordinator.call("gate", { ...devicesGate, page: "flow" });
    await coordinator.call("start", {
      previewId,
      deviceId: randomUUID(),
      notes: "",
    });
    // 结果页期间渲染进程尚未重新上报门控，刷卡也立即按新刷卡处理。
    await coordinator.onCard(cardEvent());
    expect(events.filter((e: any) => e.type === "confirm")).toHaveLength(0);
    expect(events.filter((e: any) => e.type === "scan")).toHaveLength(2);
  });

  it("自动模式下同一张卡的重复帧不确认，也不重新查询校园资料", async () => {
    await login();
    await coordinator.call("setScanMode", { mode: "automatic" });
    await coordinator.call("gate", devicesGate);
    await coordinator.onCard(cardEvent());
    await coordinator.call("gate", { ...devicesGate, page: "flow" });
    const count = traffic.filter(
      (t) => t.path === "/api/v1/scan-previews",
    ).length;
    await coordinator.onCard(cardEvent());
    expect(events.filter((e: any) => e.type === "confirm")).toHaveLength(0);
    expect(
      traffic.filter((t) => t.path === "/api/v1/scan-previews"),
    ).toHaveLength(count);
    // 模式切换持久化，重启后仍为自动。
    const restarted = new Coordinator(
      store,
      coordinator.clientId,
      "integration",
      identity,
      (e) => events.push(e),
    );
    await restarted.init();
    expect((await restarted.status()).scanMode).toBe("automatic");
    await restarted.close();
  });

  it("手动模式下同一张卡再次刷卡只发确认事件，携带当前预览键", async () => {
    await login();
    await coordinator.call("gate", devicesGate);
    await coordinator.onCard(cardEvent());
    const previewId = (
      events.find((e: any) => e.type === "scan") as { preview: { id: string } }
    ).preview.id;
    await coordinator.call("gate", { ...devicesGate, page: "flow" });
    const count = traffic.filter(
      (t) => t.path === "/api/v1/scan-previews",
    ).length;
    const event = cardEvent();
    await coordinator.onCard(event);
    expect(event.card).toEqual({ issuer: "", uidHex: "" });
    expect(events.filter((e: any) => e.type === "confirm").at(-1)).toEqual({
      type: "confirm",
      previewId,
    });
    expect(
      traffic.filter((t) => t.path === "/api/v1/scan-previews"),
    ).toHaveLength(count);
  });

  it("刷卡事件标记为 card 来源；刷卡窗口关闭后撤销预览并拒绝刷卡", async () => {
    const origins: [string, string | undefined][] = [];
    const routed = new Coordinator(
      store,
      randomUUID(),
      "integration",
      identity,
      (e, origin) => origins.push([e.type, origin]),
    );
    coordinator = routed;
    await login();
    // 配置、登录等状态变化不属于刷卡窗口专有事件。
    expect(origins.length).toBeGreaterThan(0);
    expect(origins.every(([, origin]) => origin === undefined)).toBe(true);
    origins.length = 0;
    await routed.onCard(cardEvent());
    expect(origins).toEqual([["notice", "card"]]);
    await routed.call("gate", devicesGate);
    await routed.onCard(cardEvent());
    expect(origins.at(-1)).toEqual(["scan", "card"]);
    await routed.call("gate", { ...devicesGate, page: "flow" });
    await routed.onCard(cardEvent());
    // 手动模式同卡再刷只发确认信号，不重新查询校园资料。
    expect(origins.at(-1)).toEqual(["confirm", "card"]);
    const scans = () =>
      traffic.filter((t) => t.path === "/api/v1/scan-previews").length;
    const before = scans();
    await routed.releaseScan();
    expect(
      traffic.some(
        (t) =>
          t.method === "DELETE" && t.path.startsWith("/api/v1/scan-previews/"),
      ),
    ).toBe(true);
    await routed.onCard(cardEvent());
    expect(origins.at(-1)).toEqual(["notice", "card"]);
    expect(scans()).toBe(before);
    // 没有活动预览时再次释放不产生请求。
    const requests = traffic.length;
    await routed.releaseScan();
    expect(traffic.length).toBe(requests);
  });

  it("被拒绝的并发刷卡不解除扫描锁，离开页面后的迟到预览不重开流程", async () => {
    await login();
    await coordinator.call("gate", devicesGate);
    let resolve!: (value: unknown) => void;
    response = () =>
      new Promise((done) => {
        resolve = done;
      });
    const first = cardEvent();
    const pending = coordinator.onCard(first);
    await coordinator.onCard(cardEvent());
    await coordinator.onCard(cardEvent());
    expect(
      traffic.filter((t) => t.path === "/api/v1/scan-previews"),
    ).toHaveLength(1);
    await coordinator.call("gate", { ...devicesGate, page: "settings" });
    await coordinator.call("gate", devicesGate);
    resolve({ id: randomUUID(), mode: "start" });
    await pending;
    expect(first.card).toEqual({ issuer: "", uidHex: "" });
    expect(events.filter((e: any) => e.type === "scan")).toHaveLength(0);
    response = () => ({ id: randomUUID(), mode: "start" });
    await coordinator.onCard(cardEvent());
    expect(events.filter((e: any) => e.type === "scan")).toHaveLength(1);
  });

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
    const scanCount = traffic.filter(
      (t) => t.path === "/api/v1/scan-previews",
    ).length;
    await coordinator.onCard({ ...input, card: { ...input.card } });
    expect(
      traffic.filter((t) => t.path === "/api/v1/scan-previews"),
    ).toHaveLength(scanCount);
    expect(
      events.filter((e) => (e as { type: string }).type === "confirm"),
    ).toHaveLength(1);
    await coordinator.onCard({
      ...input,
      scanId: randomUUID(),
      studentId: "b".repeat(64),
      card: { issuer: "test", uidHex: "00000002" },
    });
    expect(
      events.filter((e) => (e as { type: string }).type === "confirm"),
    ).toHaveLength(1);
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

  describe("相邻试验组批次", () => {
    const BATCH_WINDOW_MS = 30000;
    const studentOf = (id: string): StudentDTO => ({
      id,
      name: "试验学生",
      className: "一班",
      schoolNumber: "",
      version: 1,
      refreshedAtMs: Date.now(),
    });
    const startedAtMs = Date.now();
    const sessionOf = (
      id: string,
      studentIds: string[],
      state: BatchSession["state"] = "collecting",
      /** 自定义窗口：用于把截止时间放到过去或紧邻现在的用例。 */
      windowMs = BATCH_WINDOW_MS,
    ): BatchSession => {
      const atMs = startedAtMs;
      return {
        id,
        mode: "batch",
        atMs,
        closesAtMs: atMs + windowMs,
        students: studentIds.map(studentOf),
        duplicates: [],
        state,
      };
    };
    const assignmentOf = (batchId: string): BatchAssignment => ({
      batchId,
      atMs: Date.now(),
      grade: "excellent",
      gradeLabel: "严格相邻",
      assigned: [],
      busy: [],
      unresolved: [],
      span: 0,
    });
    const batchCard = (studentId = "b".repeat(64), uidHex = "00000002") => ({
      ...cardEvent(),
      studentId,
      card: { issuer: "test", uidHex },
    });
    const emitted = (type: string) =>
      events.filter((event: any) => event.type === type);
    const paths = (path: string) => traffic.filter((t) => t.path === path);
    const joined = (batchId: string) =>
      paths(`/api/v1/scan-previews/${batchId}/join`);
    /** 统一的响应路由：登录/日志照旧，批次路径按参数决定。 */
    const serveBatches = (
      handlers: {
        any?: (method: string, path: string) => unknown;
        start?: () => unknown;
        join?: () => unknown;
        confirm?: (body: unknown) => unknown;
        del?: () => unknown;
      } = {},
    ) => {
      response = (method, path, body) => {
        if (handlers.any) {
          const value = handlers.any(method, path);
          if (value !== undefined) return value;
        }
        if (path === "/api/v1/auth/login") return { token: "test-token" };
        if (path === "/api/v1/logs/batch") return { acked: [] };
        if (method === "POST" && path === "/api/v1/scan-previews")
          return handlers.start
            ? handlers.start()
            : { id: randomUUID(), mode: "start" };
        if (method === "POST" && path.endsWith("/join"))
          return handlers.join ? handlers.join() : {};
        if (method === "POST" && path.startsWith("/api/v1/batches/"))
          return handlers.confirm
            ? handlers.confirm(body)
            : assignmentOf(path.split("/")[4]);
        if (method === "DELETE" && path.startsWith("/api/v1/scan-previews/"))
          return handlers.del ? handlers.del() : {};
        return {};
      };
    };
    const openBatch = async (
      id: string,
      studentIds: string[],
      handlers?: Parameters<typeof serveBatches>[0],
    ) => {
      // 批次场景里再刷卡不应新建单人预览；残留的 start 处理器默认拒绝。
      serveBatches({
        ...handlers,
        start: () => ({
          id,
          mode: "batch",
          atMs: Date.now(),
          expiresAtMs: Date.now() + BATCH_WINDOW_MS,
          student: studentOf(studentIds[0]),
          batch: sessionOf(id, studentIds),
        }),
      });
      await coordinator.call("gate", devicesGate);
      await coordinator.onCard(cardEvent());
      return id;
    };

    it("试验组刷卡返回 batch 时只发 batch 事件，门控切到 batch 且没有单人流程", async () => {
      await login();
      const batchId = randomUUID();
      await openBatch(batchId, ["a".repeat(64)]);
      expect(emitted("batch")).toHaveLength(1);
      expect(emitted("batch")[0]).toMatchObject({
        scanMode: "manual",
        session: { id: batchId, mode: "batch", state: "collecting" },
      });
      expect(emitted("scan")).toHaveLength(0);
      expect((await coordinator.status()).activeBatchId).toBe(batchId);
      /*
       * 没有单人 activeCard：批次里已加入的成员再刷卡不会被当成“确认”，
       * 也不会新建单人预览；但它必须作为“批次结束信号”发给服务端的 join，
       * 由服务端决定何时分配（见 joinBatch）。
       */
      await coordinator.onCard(cardEvent());
      expect(emitted("confirm")).toHaveLength(0);
      expect(joined(batchId)).toHaveLength(1);
      expect(emitted("notice").at(-1)).toEqual({
        type: "notice",
        code: "BATCH_CLOSING",
      });
      // 换一位学生刷卡：走 join，不新建单人预览。
      serveBatches({
        join: () => ({
          batch: sessionOf(batchId, ["a".repeat(64), "b".repeat(64)]),
        }),
      });
      await coordinator.onCard(batchCard("b".repeat(64)));
      expect(joined(batchId)).toHaveLength(1);
      // 批次进行中门控上报 batch 页不会把批次清掉。
      await coordinator.call("gate", { ...devicesGate, page: "batch" });
      expect((await coordinator.status()).activeBatchId).toBe(batchId);
    });

    it("批次中后续刷卡走 join；重复卡返回 assignment 时清状态并 emit batchAssigned", async () => {
      await login();
      const batchId = randomUUID();
      const first = "a".repeat(64);
      const second = "c".repeat(64);
      const afterJoin = sessionOf(batchId, [first, second]);
      await openBatch(batchId, [first], {
        join: () => ({ batch: afterJoin }),
      });
      await coordinator.onCard(batchCard(second));
      expect(joined(batchId)).toHaveLength(1);
      // 不再走新建预览接口，也不再产生单人 scan 事件。
      expect(paths("/api/v1/scan-previews")).toHaveLength(1);
      expect(emitted("scan")).toHaveLength(0);
      expect(emitted("batchUpdate").at(-1)).toMatchObject({
        session: { id: batchId, students: [{ id: first }, { id: second }] },
      });
      /*
       * 已加入的成员再次刷卡 = “批次结束信号”，必须发给服务端：
       * 客户端不认识“何时该分配”，只有服务端在看到重复卡后才会分配并返回
       * assignment。这里断言它确实发出了一次 join 请求，并提示正在结束。
       */
      const before = traffic.length;
      await coordinator.onCard(batchCard(first, "00000001"));
      expect(traffic.length).toBe(before + 1);
      expect(traffic.at(-1)).toMatchObject({
        method: "POST",
        path: `/api/v1/scan-previews/${batchId}/join`,
      });
      expect(emitted("notice").at(-1)).toMatchObject({
        code: "BATCH_CLOSING",
      });
      // 刷到批次里已经出现过的卡：服务端直接结束并返回 assignment。
      const assignment = assignmentOf(batchId);
      response = (method, path) => {
        if (method === "POST" && path.endsWith("/join"))
          return {
            batch: sessionOf(batchId, [first, second], "assigned"),
            assignment,
          };
        if (path === "/api/v1/auth/login") return { token: "test-token" };
        return {};
      };
      // 用第三张卡触发：它不在本地成员表里，所以会真的去 join；
      // 服务端判定为重复（学生已经在批次里）并返回 assignment。
      await coordinator.onCard(batchCard("e".repeat(64), "00000005"));
      expect(emitted("batchAssigned").at(-1)).toEqual({
        type: "batchAssigned",
        assignment,
      });
      expect(emitted("batchClosed").at(-1)).toEqual({
        type: "batchClosed",
        batchId,
        reason: "duplicate",
      });
      expect((await coordinator.status()).activeBatchId).toBeNull();
      // 批次已清理：下一次刷卡重新走新建预览并把门控切回 devices。
      serveBatches();
      await coordinator.onCard(batchCard("d".repeat(64), "00000004"));
      expect(paths("/api/v1/scan-previews")).toHaveLength(2);
      expect(emitted("scan")).toHaveLength(1);
    });

    it("join 收到 BATCH_CLOSED/BATCH_NOT_FOUND 时清本地批次并提示", async () => {
      await login();
      const batchId = randomUUID();
      await openBatch(batchId, ["a".repeat(64)], {
        join: () => Promise.reject(new ApiError("BATCH_CLOSED", 410)),
      });
      await coordinator.onCard(batchCard());
      expect(emitted("batchClosed").at(-1)).toEqual({
        type: "batchClosed",
        batchId,
        reason: "timeout",
      });
      expect(emitted("notice").at(-1)).toMatchObject({ code: "BATCH_EXPIRED" });
      expect((await coordinator.status()).activeBatchId).toBeNull();
      // 批次已清空，再刷卡回到普通流程。
      serveBatches();
      await coordinator.onCard(batchCard());
      expect(emitted("scan")).toHaveLength(1);
    });

    it("batchConfirm 只在有活动批次时可用，请求体只带 requestId 并落 intents", async () => {
      await login();
      const batchId = randomUUID();
      // 没有活动批次：立即拒绝，不发请求、不落意图。
      await expect(coordinator.confirmBatch(batchId)).rejects.toThrow(
        "BATCH_NOT_ACTIVE",
      );
      expect(
        traffic.filter((t) => t.path.startsWith("/api/v1/batches/")),
      ).toHaveLength(0);
      const bodies: Record<string, unknown>[] = [];
      await openBatch(batchId, ["a".repeat(64)], {
        confirm: (body) => {
          bodies.push(body as Record<string, unknown>);
          return assignmentOf(batchId);
        },
      });
      const callerRequestId = randomUUID();
      const result = await coordinator.call("batchConfirmAssigned", {
        batchId,
        requestId: callerRequestId,
      });
      expect(result).toMatchObject({ batchId, grade: "excellent" });
      expect(bodies).toHaveLength(1);
      // 幂等管线：requestId 由 main 生成并覆盖，body 只有 requestId 落库。
      expect(Object.keys(bodies[0])).toEqual(["requestId"]);
      expect(bodies[0].requestId).not.toBe(callerRequestId);
      const intents = await store.intents.findAll({
        where: { path: `/api/v1/batches/${batchId}/confirm` },
      });
      expect(intents).toHaveLength(1);
      expect(intents[0].get().state).toBe("committed");
      expect(intents[0].get().body).toEqual({ requestId: bodies[0].requestId });
      expect(emitted("batchAssigned").at(-1)).toMatchObject({
        assignment: { batchId },
      });
      expect(emitted("batchClosed").at(-1)).toEqual({
        type: "batchClosed",
        batchId,
        reason: "manual",
      });
      expect(await coordinator.call("status", {})).toMatchObject({
        activeBatchId: null,
      });
      // 已结束的批次不能再确认第二次。
      await expect(coordinator.confirmBatch(batchId)).rejects.toThrow(
        "BATCH_NOT_ACTIVE",
      );
      expect(bodies).toHaveLength(1);
    });

    it("batchConfirm 失败保留批次供重试，成功后才清理", async () => {
      await login();
      const batchId = randomUUID();
      await openBatch(batchId, ["a".repeat(64)], {
        confirm: () => Promise.reject(new ApiError("COMMAND_BUSY", 409)),
      });
      await expect(coordinator.confirmBatch(batchId)).rejects.toThrow(
        "COMMAND_BUSY",
      );
      expect(emitted("batchAssigned")).toHaveLength(0);
      expect(await coordinator.call("status", {})).toMatchObject({
        activeBatchId: batchId,
      });
      serveBatches({ confirm: () => assignmentOf(batchId) });
      await coordinator.confirmBatch(batchId);
      expect(emitted("batchAssigned")).toHaveLength(1);
    });

    it("batchAbandon 删除服务端批次预览并以 cancelled 结束", async () => {
      await login();
      const batchId = randomUUID();
      await openBatch(batchId, ["a".repeat(64)]);
      const deletes = () =>
        traffic.filter(
          (t) =>
            t.method === "DELETE" &&
            t.path === `/api/v1/scan-previews/${batchId}`,
        );
      await coordinator.call("batchAbandon", { batchId });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(deletes()).toHaveLength(1);
      expect(emitted("batchClosed").at(-1)).toEqual({
        type: "batchClosed",
        batchId,
        reason: "cancelled",
      });
      expect((await coordinator.status()).activeBatchId).toBeNull();
      // 放弃后没有再发确认请求。
      expect(
        traffic.filter((t) => t.path.startsWith("/api/v1/batches/")),
      ).toHaveLength(0);
    });

    it("logout 与 configure 清理批次，且批次定时器不会留下悬挂", async () => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "Date"],
      });
      await login();
      const batchId = randomUUID();
      await openBatch(batchId, ["a".repeat(64)], {
        confirm: () => assignmentOf(batchId),
      });
      await coordinator.call("logout", {});
      expect((await coordinator.status()).activeBatchId).toBeNull();
      const confirmations = () =>
        traffic.filter((t) => t.path.startsWith("/api/v1/batches/")).length;
      const before = confirmations();
      // 计时器在登出时已清理：越过截止时间也不会再确认批次。
      await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS + 5000);
      expect(confirmations()).toBe(before);
      expect(emitted("batchAssigned")).toHaveLength(0);

      // configure（切换服务器）同样清理批次。
      await login();
      const otherId = randomUUID();
      await openBatch(otherId, ["a".repeat(64)]);
      expect((await coordinator.status()).activeBatchId).toBe(otherId);
      await coordinator.call("configure", {
        ip: "127.0.0.2",
        port: 8443,
        pin: "cd".repeat(32),
      });
      await coordinator.call("login", {
        username: "teacher",
        password: "secret",
        remember: false,
      });
      expect((await coordinator.status()).activeBatchId).toBeNull();
      const after = confirmations();
      await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS + 5000);
      expect(confirmations()).toBe(after);
    });

    it("批次截止时间到点后 main 主动确认并推送分配结果", async () => {
      await login();
      const batchId = randomUUID();
      const assignment = assignmentOf(batchId);
      await openBatch(batchId, ["a".repeat(64)], {
        confirm: () => assignment,
      });
      // 把本地批次的截止时间挪到现在之前，模拟窗口真正到期。
      const expired = sessionOf(batchId, ["a".repeat(64)], "collecting", 1);
      (coordinator as any).activeBatch.closesAtMs = expired.closesAtMs;
      // 定时器在批次建立时就按 closesAtMs 启动；直接叫醒它来模拟到点。
      const timer = (
        coordinator as unknown as {
          onBatchTimeout: (id: string) => Promise<void>;
        }
      ).onBatchTimeout;
      await timer.call(coordinator, batchId);
      expect(
        traffic.filter((t) => t.path === `/api/v1/batches/${batchId}/confirm`),
      ).toHaveLength(1);
      expect(emitted("batchAssigned").at(-1)).toMatchObject({
        assignment: { batchId },
      });
      expect((await coordinator.status()).activeBatchId).toBeNull();
    });

    it("本地时钟先于服务端到点时，定时器重新排期而不是提前确认", async () => {
      await login();
      const batchId = randomUUID();
      await openBatch(batchId, ["a".repeat(64)], {
        confirm: () => assignmentOf(batchId),
      });
      // 截止时间还没到（默认 30 秒窗口）：定时器被唤醒后应重新排期。
      const onTimeout = (
        coordinator as unknown as {
          onBatchTimeout: (id: string) => Promise<void>;
        }
      ).onBatchTimeout;
      await onTimeout.call(coordinator, batchId);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(
        traffic.filter((t) => t.path.startsWith("/api/v1/batches/")),
      ).toHaveLength(0);
      expect((await coordinator.status()).activeBatchId).toBe(batchId);
    });

    it("releaseScan 与 setScanMode 同样清理批次并撤销服务端预览", async () => {
      await login();
      const batchId = randomUUID();
      await openBatch(batchId, ["a".repeat(64)]);
      // 批次收集期间不允许切换刷手动/自动模式（批次本身不受模式影响）。
      await expect(
        coordinator.call("setScanMode", { mode: "automatic" }),
      ).rejects.toThrow("SCAN_MODE_BUSY");
      await coordinator.releaseScan();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(
        traffic.filter(
          (t) =>
            t.method === "DELETE" &&
            t.path === `/api/v1/scan-previews/${batchId}`,
        ),
      ).toHaveLength(1);
      expect(emitted("batchClosed").at(-1)).toEqual({
        type: "batchClosed",
        batchId,
        reason: "cancelled",
      });
      expect((await coordinator.status()).activeBatchId).toBeNull();
    });
  });

  describe("布局设置与试验组名单", () => {
    it("layout 读取后写入 status，saveLayout 与 setExperiment 走 command 管线", async () => {
      await login();
      // 边界值取当前契约合法的最小组合（S1=8、S3=41）。
      const settings = {
        section1Start: 1,
        section1End: 8,
        section2Start: 31,
        section3Start: 41,
        allowCrossArea: true,
        batchWindowSec: 90,
        batchStudentLimit: 8,
      };
      response = (method, path, body) => {
        if (path === "/api/v1/layout" && method === "GET")
          return { settings, version: 3 };
        if (path === "/api/v1/layout" && method === "PUT")
          return { version: 4 };
        if (path.startsWith("/api/v1/students/experiment?"))
          return { items: [], total: 0, page: 1, pageSize: 30 };
        if (method === "PUT" && path.endsWith("/experiment")) return {};
        return path === "/api/v1/auth/login" ? { token: "test-token" } : {};
      };
      expect(await coordinator.call("layout", {})).toEqual({
        settings,
        version: 3,
      });
      expect(await coordinator.call("status", {})).toMatchObject({
        batchWindowSec: 90,
      });
      await coordinator.call("saveLayout", { ...settings, expectedVersion: 3 });
      const saved = traffic.find(
        (t) => t.method === "PUT" && t.path === "/api/v1/layout",
      );
      expect(saved?.body).toMatchObject({ ...settings, expectedVersion: 3 });
      expect((saved?.body as { requestId: string }).requestId).toBeTruthy();
      await coordinator.call("experimentStudents", { page: 1, pageSize: 30 });
      expect(
        traffic.some((t) => t.path.startsWith("/api/v1/students/experiment?")),
      ).toBe(true);
      const studentId = randomUUID();
      await coordinator.call("setExperiment", { studentId, enabled: true });
      const toggled = traffic.find(
        (t) => t.path === `/api/v1/students/${studentId}/experiment`,
      );
      expect(toggled?.body).toMatchObject({ enabled: true });
      // 布局与试验组写入都不含卡号字段，可以安全进入 intents。
      expect(await store.pending("https://127.0.0.1:8443")).toHaveLength(0);
    });

    it("布局写入的版本冲突原样抛给 renderer", async () => {
      await login();
      response = (method, path) => {
        if (method === "PUT" && path === "/api/v1/layout")
          return Promise.reject(new ApiError("LAYOUT_VERSION_CONFLICT", 409));
        return path === "/api/v1/auth/login" ? { token: "test-token" } : {};
      };
      await expect(
        coordinator.call("saveLayout", {
          section1Start: 1,
          section1End: 8,
          section2Start: 31,
          section3Start: 41,
          allowCrossArea: true,
          batchWindowSec: 60,
          batchStudentLimit: 8,
          expectedVersion: 1,
        }),
      ).rejects.toThrow("LAYOUT_VERSION_CONFLICT");
    });
  });
});
