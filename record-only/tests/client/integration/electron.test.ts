import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { createServer, type Server } from "node:https";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../../apps/server/src/database.js";
import { createApp } from "../../../apps/server/src/app.js";
import {
  seedStudents,
  integrationSeed,
} from "../../../apps/server/src/seed.js";
import { testConfig, identity } from "../../helpers/config.js";
import { certificate } from "../../helpers/certificates.js";
import { LocalStore } from "../../../apps/teacher/src/main/store.js";
let api: Awaited<ReturnType<typeof createApp>>,
  admin: Database,
  tls: Server,
  port: number,
  desktop: ElectronApplication,
  page: Page,
  userData: string;
const dbName = "cyez_electron_" + randomUUID().replaceAll("-", ""),
  cert = certificate();
let requests = 0,
  scans = 0;
test.beforeAll(async () => {
  const adminUrl =
    process.env.TEST_DATABASE_URL ??
    "postgres://cyez_test:integration-only@127.0.0.1:55432/cyez_test";
  admin = new Database(adminUrl);
  await admin.sequelize.getQueryInterface().createDatabase(dbName);
  const url = new URL(adminUrl);
  url.pathname = "/" + dbName;
  const config = testConfig(
    url.toString(),
    await mkdtemp(join(tmpdir(), "cyez-electron-spool-")),
  );
  const db = new Database(config.databaseUrl);
  await db.migrator.up();
  await seedStudents(db, integrationSeed(identity), identity);
  api = await createApp(config);
  await api.app.listen({ host: "127.0.0.1", port: 0 });
  const address = api.app.server.address();
  if (!address || typeof address === "string") throw Error("port");
  tls = createServer(cert, (incoming, response) => {
    requests++;
    if (incoming.url === "/api/v1/scan-previews") scans++;
    const proxy = request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path: incoming.url,
        method: incoming.method,
        headers: incoming.headers,
      },
      (upstream) => {
        response.writeHead(upstream.statusCode ?? 503, upstream.headers);
        upstream.pipe(response);
      },
    );
    proxy.on("error", () => {
      response.writeHead(503);
      response.end('{"code":"SERVICE_UNAVAILABLE"}');
    });
    incoming.pipe(proxy);
  });
  await new Promise<void>((r) => tls.listen(0, "127.0.0.1", r));
  port = (tls.address() as { port: number }).port;
  userData = await mkdtemp(join(tmpdir(), "cyez-electron-profile-"));
  await launch();
});
async function launch() {
  const packagedExecutable = process.env.CYEZ_ELECTRON_EXECUTABLE;
  desktop = await electron.launch({
    executablePath: packagedExecutable
      ? resolve(packagedExecutable)
      : resolve("node_modules/electron/dist/electron.exe"),
    args: packagedExecutable ? [] : [resolve("apps/teacher")],
    env: {
      ...process.env,
      CYEZ_USER_DATA: userData,
      CYEZ_CLIENT_CONFIG: resolve("config/client.integration.json"),
    },
    timeout: 30000,
  });
  page = await desktop.firstWindow();
  await page.waitForLoadState("domcontentloaded");
}
test.afterAll(async () => {
  await desktop?.close();
  if (tls) await new Promise<void>((r) => tls.close(() => r()));
  await api?.app.close();
  if (admin) {
    for (let i = 0; ; i++) {
      try {
        await admin.sequelize.getQueryInterface().dropDatabase(dbName);
        break;
      } catch (e) {
        if (i === 4) throw e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    await admin.close();
  }
});
async function call<T = unknown>(action: string, input: unknown = {}) {
  return page.evaluate(
    async ({ action, input }) =>
      window.library.call(action as never, input as never),
    { action, input },
  ) as Promise<T>;
}
async function login() {
  await call("configure", { ip: "127.0.0.1", port, pin: cert.pin });
  await call("login", {
    username: "teacher-test",
    password: "integration-password-only",
    remember: true,
  });
  await page.getByRole("button", { name: "刷新", exact: true }).first().click();
}
test("C-I-01/07: 真实 Electron 沙箱、cyez-ui、两个一级入口", async () => {
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "使用登记", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "设置", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => ({
      node: typeof (window as unknown as { require: unknown }).require,
      bridge: typeof window.library.call,
    })),
  ).toEqual({ node: "undefined", bridge: "function" });
  const preferences = await desktop.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return (
      w.webContents as unknown as {
        getLastWebPreferences: () => Record<string, unknown>;
      }
    ).getLastWebPreferences();
  });
  expect(preferences.sandbox).toBe(true);
  expect(preferences.contextIsolation).toBe(true);
  expect(preferences.nodeIntegration).toBe(false);
});
test("C-I-09: 真 TLS 错 pin 在密码及正文发送前拒绝；正确自签 pin 成功", async () => {
  await call("configure", { ip: "127.0.0.1", port, pin: "00".repeat(32) });
  const before = requests;
  await expect(
    call("login", {
      username: "teacher-test",
      password: "integration-password-only",
      remember: false,
    }),
  ).rejects.toThrow();
  expect(requests).toBe(before);
  await login();
  expect(requests).toBeGreaterThan(before);
  const status = await call<{ authenticated: boolean }>("status");
  expect(status.authenticated).toBe(true);
});
test("C-I-09: 过期/SAN 错误/证书更换、重定向和 HTTP 降级", async () => {
  for (const invalid of [
    certificate("127.0.0.1", true),
    certificate("127.0.0.2"),
  ]) {
    let received = 0;
    const server = createServer(invalid, (_req, res) => {
      received++;
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const target = (server.address() as { port: number }).port;
    try {
      await call("configure", {
        ip: "127.0.0.1",
        port: target,
        pin: invalid.pin,
      });
      await expect(
        call("login", {
          username: "teacher-test",
          password: "integration-password-only",
          remember: false,
        }),
      ).rejects.toThrow();
      expect(received).toBe(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }
  let redirected = 0;
  const redirect = createServer(cert, (_req, res) => {
    redirected++;
    res.writeHead(302, { location: "http://127.0.0.1:1/steal" });
    res.end();
  });
  await new Promise<void>((r) => redirect.listen(0, "127.0.0.1", r));
  try {
    await call("configure", {
      ip: "127.0.0.1",
      port: (redirect.address() as { port: number }).port,
      pin: cert.pin,
    });
    await expect(call("testConnection")).rejects.toThrow();
    expect(redirected).toBe(1);
  } finally {
    await new Promise<void>((r) => redirect.close(() => r()));
  }
  await expect(
    call("configure", { ip: "http://127.0.0.1", port, pin: cert.pin }),
  ).rejects.toThrow();
  await call("configure", { ip: "127.0.0.1", port, pin: "11".repeat(32) });
  const before = requests;
  await expect(
    call("login", {
      username: "teacher-test",
      password: "integration-password-only",
      remember: false,
    }),
  ).rejects.toThrow();
  expect(requests).toBe(before);
  await login();
});
test("C-I-02/08: 设置刷卡不查询；真实 CRUD → 刷卡登记 → 结束 → 只读历史", async () => {
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "设备管理", exact: true }).click();
  await page.getByRole("button", { name: "新增设备", exact: true }).click();
  await page.getByLabel("设备编号", { exact: true }).fill("E2E-001");
  await page.getByLabel("设备名称", { exact: true }).fill("集成测试设备");
  await page.getByRole("button", { name: "保存设备", exact: true }).click();
  await expect(page.getByText("E2E-001", { exact: true })).toBeVisible();
  const before = scans;
  await call("integrationScan", { fixture: "allowed-1" });
  expect(scans).toBe(before);
  await page.getByRole("link", { name: "使用登记", exact: true }).click();
  await page.getByRole("button", { name: "未使用", exact: true }).click();
  await page.waitForTimeout(1300);
  await page.getByRole("button", { name: "测试卡 1", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "登记使用", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "选择", exact: true }).click();
  await page
    .getByLabel("登记备注", { exact: true })
    .fill("真实 Electron 集成记录");
  await page.getByRole("button", { name: "确认登记", exact: true }).click();
  await page.getByRole("button", { name: "使用中", exact: true }).click();
  await expect(
    page.getByText("真实 Electron 集成记录", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "结束…", exact: true }).click();
  await page.getByRole("button", { name: "确认结束", exact: true }).click();
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "历史记录", exact: true }).click();
  await expect(
    page.getByText("真实 Electron 集成记录", { exact: true }),
  ).toBeVisible();
  const historyScans = scans;
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  expect(scans).toBe(historyScans);
  await page.getByText("真实 Electron 集成记录", { exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "历史记录详情" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "保存备注", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.screenshot({
    path: "test-results/electron/history.png",
    fullPage: true,
  });
});
test("C-I-10/04/05: OS 加密保存与真实 SQLite 跨重启，origin 隔离", async () => {
  await login();
  await desktop.close();
  const file = join(userData, "library.sqlite");
  const bytes = await readFile(file);
  expect(bytes.includes(Buffer.from("integration-password-only"))).toBe(false);
  expect(bytes.includes(Buffer.from("uidHex"))).toBe(false);
  const store = new LocalStore(file);
  await store.init();
  expect(await store.get("credentials")).toBeTruthy();
  const id = await store.clientId();
  const otherRequest = randomUUID();
  await store.saveIntent({
    requestId: otherRequest,
    origin: "https://127.0.0.1:1",
    method: "POST",
    path: "/api/v1/devices",
    body: { requestId: otherRequest, code: "MUST-NOT-REPLAY" },
    createdAt: Date.now(),
    state: "pending",
  });
  const sameRequest = randomUUID();
  await store.saveIntent({
    requestId: sameRequest,
    origin: `https://127.0.0.1:${port}`,
    method: "POST",
    path: "/api/v1/devices",
    body: {
      requestId: sameRequest,
      code: "RECOVERED-DEVICE",
      displayName: "恢复中的设备",
      notes: "",
      isDisabled: false,
      tagIds: [],
    },
    createdAt: Date.now(),
    state: "pending",
  });
  const logId = randomUUID();
  await store.append({
    logId,
    source: "main",
    level: "warn",
    atMs: Date.now(),
    appVersion: "0.1.0",
    code: "DISCONNECTED",
  });
  await store.close();
  await launch();
  await call("loginSaved");
  await expect
    .poll(async () =>
      api.db.devices.count({ where: { code: "RECOVERED-DEVICE" } }),
    )
    .toBe(1);
  const reopened = new LocalStore(file);
  await reopened.init();
  expect(await reopened.pending(`https://127.0.0.1:${port}`)).toHaveLength(0);
  expect(await reopened.pending("https://127.0.0.1:1")).toHaveLength(1);
  await reopened.close();
  await expect
    .poll(async () => api.db.logs.count({ where: { origin: id, logId } }))
    .toBe(1);
  expect(
    await api.db.devices.count({ where: { code: "MUST-NOT-REPLAY" } }),
  ).toBe(0);
  await call("clearSaved");
  expect(
    (await call<{ savedCredentials: boolean }>("status")).savedCredentials,
  ).toBe(false);
});
