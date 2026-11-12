import { deviceChoice, selectDevice } from "../../helpers/select-device.js";
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
import { testConfig, identity } from "../../helpers/config.js";
import { certificate } from "../../helpers/certificates.js";
import { listenForElectron } from "../../helpers/electron-server.js";
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
  await db.initializeIdentity(identity);
  expect(await db.students.count()).toBe(0);
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
  port = await listenForElectron(tls);
  userData = await mkdtemp(join(tmpdir(), "cyez-electron-profile-"));
  await launch();
});
async function launch() {
  const packagedExecutable = process.env.CYEZ_ELECTRON_EXECUTABLE;
  desktop = await electron.launch({
    executablePath: packagedExecutable
      ? resolve(packagedExecutable)
      : undefined,
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
  expect(await call<{ reader: string }>("status")).toMatchObject({
    reader: "手动输入已就绪",
  });
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
test("C-I-06: 真实 renderer 的 IPC 白名单、输入 schema 与外部导航拒绝", async () => {
  const originalUrl = page.url();
  await expect(call("arbitraryAction", {})).rejects.toThrow("IPC_FORBIDDEN");
  await expect(call("status", { unexpected: true })).rejects.toThrow();
  expect(
    await page.evaluate(() => {
      const opened = window.open("https://example.org/", "untrusted");
      return opened === null;
    }),
  ).toBe(true);
  expect(desktop.windows()).toHaveLength(1);
  const navigationBlocked = await desktop.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    let blocked = false;
    window.webContents.emit(
      "will-navigate",
      { preventDefault: () => (blocked = true) } as never,
      "https://example.org/",
    );
    return blocked;
  });
  expect(navigationBlocked).toBe(true);
  expect(page.url()).toBe(originalUrl);
  await expect(call("status", {})).resolves.toBeTruthy();
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
    const target = await listenForElectron(server);
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
  const redirectPort = await listenForElectron(redirect);
  try {
    await call("configure", {
      ip: "127.0.0.1",
      port: redirectPort,
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
  const scanNotice = page.getByRole("alert").filter({
    hasText: "接收到刷卡消息，请返回主页面以触发登记",
  });
  await expect(scanNotice).toBeVisible();
  await page.getByRole("link", { name: "使用登记", exact: true }).click();
  await page.getByRole("button", { name: "未使用", exact: true }).click();
  await page.waitForTimeout(1300);
  await page.getByRole("button", { name: "测试卡 1", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "选择设备", exact: true }),
  ).toBeVisible();
  await expect(scanNotice).toHaveCount(0);
  await expect(page.locator('[data-ui="app-shell"]')).toHaveAttribute(
    "data-layout",
    "focus",
  );
  const scanBounds = async () =>
    page.locator(".bflow").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        width: rect.width,
        bottom: rect.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
    });
  const registrationBounds = await scanBounds();
  expect(registrationBounds.left).toBe(0);
  expect(registrationBounds.width).toBe(registrationBounds.viewportWidth);
  expect(registrationBounds.bottom).toBeCloseTo(
    registrationBounds.viewportHeight,
    0,
  );
  const scansDuringFlow = scans;
  await call("integrationScan", { fixture: "allowed-2" });
  expect(scans).toBe(scansDuringFlow);
  await expect(scanNotice).toBeVisible();
  const noticedBounds = await scanBounds();
  expect(noticedBounds).toEqual(registrationBounds);
  await scanNotice.getByRole("button", { name: "关闭" }).click();
  await expect(deviceChoice(page, "E2E-001")).toBeVisible();
  await page.screenshot({
    path: "test-results/electron/scan-registration-fullscreen.png",
    fullPage: true,
  });
  const originalViewport = page.viewportSize();
  await page.setViewportSize({ width: 800, height: 650 });
  const narrowBounds = await scanBounds();
  expect(narrowBounds.left).toBe(0);
  expect(narrowBounds.width).toBe(narrowBounds.viewportWidth);
  expect(narrowBounds.bottom).toBeCloseTo(narrowBounds.viewportHeight, 0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(narrowBounds.viewportWidth);
  await expect(page.getByRole("button", { name: "取消登记" })).toBeVisible();
  await page.screenshot({
    path: "test-results/electron/scan-registration-narrow.png",
    fullPage: true,
  });
  if (originalViewport) await page.setViewportSize(originalViewport);
  await selectDevice(page, "E2E-001");
  await page
    .getByLabel("登记备注", { exact: true })
    .fill("真实 Electron 集成记录");
  await page.getByRole("button", { name: "确认登记", exact: true }).click();
  await page.getByRole("button", { name: "使用中", exact: true }).click();
  await expect(
    page.getByText("真实 Electron 集成记录", { exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(1300); // Same-card scans within 1.2 seconds are intentionally ignored.
  await page.getByRole("button", { name: "测试卡 1", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "刷卡结束使用", exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-ui="app-shell"]')).toHaveAttribute(
    "data-layout",
    "focus",
  );
  const endBounds = await scanBounds();
  expect(endBounds.left).toBe(0);
  expect(endBounds.width).toBe(endBounds.viewportWidth);
  expect(endBounds.bottom).toBeCloseTo(endBounds.viewportHeight, 0);
  await page.screenshot({
    path: "test-results/electron/scan-end-fullscreen.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator('[data-ui="app-shell"]')).toHaveAttribute(
    "data-layout",
    "standard",
  );
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
test("C-I-15: 同卡二刷确认登记与结束，不重复查询资料", async () => {
  await page.getByRole("link", { name: "使用登记", exact: true }).click();
  await page.getByRole("button", { name: "未使用", exact: true }).click();
  await page.waitForTimeout(1300);
  const before = scans;
  await call("integrationScan", { fixture: "allowed-2" });
  await expect(
    page.getByRole("heading", { name: "选择设备", exact: true }),
  ).toBeVisible();
  await selectDevice(page, "E2E-001");
  await page.getByLabel("登记备注", { exact: true }).fill("二刷确认集成验证");
  await page.waitForTimeout(1300);
  await call("integrationScan", { fixture: "allowed-2" });
  await expect(
    page.getByRole("heading", { name: "选择设备", exact: true }),
  ).toHaveCount(0);
  expect(scans).toBe(before + 1);
  await page.getByRole("button", { name: "使用中", exact: true }).click();
  await expect(
    page.getByText("二刷确认集成验证", { exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(1300);
  await call("integrationScan", { fixture: "allowed-2" });
  await expect(
    page.getByRole("heading", { name: "刷卡结束使用", exact: true }),
  ).toBeVisible();
  // Editing pauses automatic checkout, so only the second scan can end this record.
  await page.getByLabel("使用备注", { exact: true }).fill("二刷确认结束验证");
  await page.waitForTimeout(1300);
  await call("integrationScan", { fixture: "allowed-2" });
  await expect(
    page.getByRole("heading", { name: "刷卡结束使用", exact: true }),
  ).toHaveCount(0);
  expect(scans).toBe(before + 2);
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "历史记录", exact: true }).click();
  await expect(
    page.getByText("二刷确认结束验证", { exact: true }),
  ).toBeVisible();
  expect(scans).toBe(before + 2);
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
    appVersion: "0.1.1",
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

test("C-I-08: 自动局部更新保留真实滚动、焦点与编辑草稿", async () => {
  await login();
  const rows = Array.from({ length: 24 }, (_, i) => ({
    id: randomUUID(),
    code: `SCROLL-${String(i).padStart(2, "0")}`,
    displayName: `滚动测试设备 ${i}`,
    notes: "",
    isDisabled: false,
    deletedAt: null,
    version: 1,
  }));
  await api.db.devices.bulkCreate(rows);
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "设备管理", exact: true }).click();
  await page.getByLabel("搜索设备").fill("SCROLL-");
  await expect(page.locator("tbody tr")).toHaveCount(24);
  await page.getByLabel("搜索设备").focus();
  const scroll = page.locator(".table-scroll");
  const initial = await scroll.evaluate((element) => {
    const node = element as HTMLElement;
    node.scrollTop = 180;
    node.dataset.preserved = "true";
    return node.scrollTop;
  });
  expect(initial).toBeGreaterThan(0);
  await api.db.devices.update(
    { displayName: "后台更新名称", version: 2 },
    {
      where: { id: rows[0].id },
    },
  );
  await expect(page.getByText("后台更新名称", { exact: true })).toHaveCount(1);
  expect(await scroll.evaluate((e) => e.scrollTop)).toBe(initial);
  await expect(scroll).toHaveAttribute("data-preserved", "true");
  await expect(page.getByLabel("搜索设备")).toBeFocused();
  await expect(page.getByLabel("搜索设备")).toHaveValue("SCROLL-");
  const row = page.locator("tbody tr").filter({ hasText: "SCROLL-04" });
  await row.getByRole("button", { name: "设备操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
  const notes = page.getByLabel("设备备注", { exact: true });
  await notes.fill("尚未保存的草稿");
  await notes.evaluate((element) => {
    const node = element as HTMLTextAreaElement;
    node.style.height = "160px";
    node.setSelectionRange(2, 5);
    node.dataset.preserved = "true";
  });
  await api.db.devices.update(
    { displayName: "第二次后台更新", version: 3 },
    {
      where: { id: rows[0].id },
    },
  );
  await expect(page.getByText("第二次后台更新", { exact: true })).toHaveCount(
    1,
  );
  await expect(notes).toHaveValue("尚未保存的草稿");
  await expect(notes).toHaveAttribute("data-preserved", "true");
  await expect(notes).toBeFocused();
  expect(
    await notes.evaluate((element) => {
      const node = element as HTMLTextAreaElement;
      return {
        height: node.style.height,
        start: node.selectionStart,
        end: node.selectionEnd,
      };
    }),
  ).toEqual({ height: "160px", start: 2, end: 5 });
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.screenshot({
    path: "test-results/electron/amber-devices.png",
    fullPage: true,
  });
});

test("C-I-10: 加密保存后自动登录，读卡进程切换失败保留原配置", async () => {
  await call("configure", { ip: "127.0.0.1", port, pin: cert.pin });
  await call("login", {
    username: "teacher-test",
    password: "integration-password-only",
    remember: true,
    autoLogin: true,
  });
  expect((await call<{ autoLogin: boolean }>("status")).autoLogin).toBe(true);
  await desktop.close();
  const bytes = await readFile(join(userData, "library.sqlite"));
  expect(bytes.includes(Buffer.from("integration-password-only"))).toBe(false);
  await launch();
  await expect
    .poll(
      async () =>
        (await call<{ authenticated: boolean }>("status")).authenticated,
    )
    .toBe(true);
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "读卡器", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "读卡进程", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/electron/serial-settings.png",
    fullPage: true,
  });
  await page.getByLabel("读卡进程").selectOption("acr1552");
  await expect(page.getByLabel("PC/SC 读卡器", { exact: true })).toHaveValue(
    "",
  );
  await expect(page.getByLabel("状态检查间隔（毫秒）")).toHaveValue("250");
  await expect(page.getByLabel("UID 字节顺序")).toHaveValue("forward");
  await expect(page.getByLabel("PC/SC 通信协议")).toHaveValue("auto");
  await expect(page.getByLabel("PC/SC 访问模式")).toHaveValue("shared");
  await expect(page.getByText(/十进制 16909060/)).toBeVisible();
  await page.getByLabel("UID 字节顺序").selectOption("reverse");
  await page.getByLabel("PC/SC 通信协议").selectOption("t1");
  await page.getByLabel("PC/SC 访问模式").selectOption("exclusive");
  await expect(page.getByText(/十进制 67305985/)).toBeVisible();
  await expect(page.getByRole("button", { name: "覆盖并启动" })).toBeDisabled();
  await page.screenshot({
    path: "test-results/electron/acr1552-settings.png",
    fullPage: true,
  });
  await page.getByLabel("读卡进程").selectOption("serial");
  const ports = await call<{ ports: string[] }>("listSerialPorts");
  expect(Array.isArray(ports.ports)).toBe(true);
  await expect(
    call("configureReader", {
      kind: "serial",
      port: "COM9999",
      baudRate: 9600,
      dataBits: 8,
      parity: "none",
      stopBits: 1,
      flowControl: "none",
      format: "decimal",
    }),
  ).rejects.toThrow();
  await expect
    .poll(async () => (await call<{ reader: string }>("status")).reader)
    .toContain("手动输入已就绪");
  await call("configureReader", { kind: "mock" });
  const store = new LocalStore(join(userData, "library.sqlite"));
  await store.init();
  expect(await store.get("readerProcess")).toBe('{"kind":"mock"}');
  await store.close();
  await call("clearSaved");
  expect((await call<{ autoLogin: boolean }>("status")).autoLogin).toBe(false);
});

test("C-I-13: 生产客户端可在设置页启动手动输入", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cyez-reader-setup-"));
  const configFile = join(directory, "client-config.json");
  await writeFile(
    configFile,
    JSON.stringify({ environment: "production", identity }),
  );
  const packagedExecutable = process.env.CYEZ_ELECTRON_EXECUTABLE;
  let setup = await electron.launch({
    executablePath: packagedExecutable
      ? resolve(packagedExecutable)
      : undefined,
    args: packagedExecutable ? [] : [resolve("apps/teacher")],
    env: {
      ...process.env,
      CYEZ_USER_DATA: directory,
      CYEZ_CLIENT_CONFIG: configFile,
    },
  });
  try {
    const setupPage = await setup.firstWindow();
    await setupPage.waitForLoadState("domcontentloaded");
    expect(
      await setupPage.evaluate(
        async () =>
          (await window.library.call<{ reader: string }>("status", {})).reader,
      ),
    ).toBe("未配置读卡进程");
    await setupPage.getByRole("link", { name: "设置", exact: true }).click();
    await setupPage
      .getByRole("button", { name: "读卡器", exact: true })
      .click();
    await expect(
      setupPage.getByRole("heading", { name: "读卡进程", exact: true }),
    ).toBeVisible();
    await expect(
      setupPage.getByRole("option", { name: "手动输入" }),
    ).toHaveCount(1);
    await setupPage.getByLabel("读卡进程").selectOption("mock");
    await setupPage.getByRole("button", { name: "覆盖并启动" }).click();
    await expect(setupPage.getByText(/手动输入已就绪/)).toBeVisible();
    await setup.close();
    setup = await electron.launch({
      executablePath: packagedExecutable
        ? resolve(packagedExecutable)
        : undefined,
      args: packagedExecutable ? [] : [resolve("apps/teacher")],
      env: {
        ...process.env,
        CYEZ_USER_DATA: directory,
        CYEZ_CLIENT_CONFIG: configFile,
      },
    });
    const restarted = await setup.firstWindow();
    await expect(restarted.getByRole("link", { name: "设置" })).toBeVisible();
    expect(
      await restarted.evaluate(
        async () =>
          (await window.library.call<{ reader: string }>("status", {})).reader,
      ),
    ).toBe("手动输入已就绪");
  } finally {
    await setup.close();
  }
});

test("C-I-14: 空白安装可在应用内完成首次配置", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cyez-first-run-"));
  const packagedExecutable = process.env.CYEZ_ELECTRON_EXECUTABLE;
  const env = { ...process.env, CYEZ_USER_DATA: directory };
  Reflect.deleteProperty(env, "CYEZ_CLIENT_CONFIG");
  const setup = await electron.launch({
    executablePath: packagedExecutable
      ? resolve(packagedExecutable)
      : undefined,
    args: packagedExecutable ? [] : [resolve("apps/teacher")],
    env,
  });
  let setupClosed = false;
  try {
    const firstRun = await setup.firstWindow();
    await firstRun.waitForLoadState("domcontentloaded");
    await expect(
      firstRun.getByRole("heading", { name: "首次配置" }),
    ).toBeVisible();
    await expect(
      firstRun.evaluate(() =>
        window.library.call("devices", { page: 1, pageSize: 30 }),
      ),
    ).rejects.toThrow("IDENTITY_CONFIG_REQUIRED");
    await expect(
      firstRun.evaluate(() =>
        window.library.call("initializeClient", {
          hashVersion: "v1",
          fixedSaltHex: "invalid",
          issuer: "integration",
          uidByteLengths: [4],
        }),
      ),
    ).rejects.toThrow("INPUT_INVALID");
    await expect(
      readFile(join(directory, "client-config.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await firstRun.screenshot({
      path: "test-results/electron/first-run.png",
      fullPage: true,
    });
    await firstRun.getByLabel("身份版本").fill(identity.hashVersion);
    await firstRun.getByLabel("发卡方").fill(identity.issuer);
    await firstRun.getByLabel("固定盐（十六进制）").fill(identity.fixedSaltHex);
    await firstRun.getByRole("button", { name: "保存并继续" }).click();
    await expect(
      firstRun.getByRole("heading", { name: "首次配置" }),
    ).toHaveCount(0);
    await expect(firstRun.getByRole("heading", { name: "设置" })).toBeVisible();
    expect(
      JSON.parse(await readFile(join(directory, "client-config.json"), "utf8")),
    ).toEqual({
      environment: "production",
      identity,
    });
    expect(
      await firstRun.evaluate(() =>
        window.library.call<{ identityConfigured: boolean; reader: string }>(
          "status",
          {},
        ),
      ),
    ).toMatchObject({ identityConfigured: true, reader: "未配置读卡进程" });
    await expect(
      firstRun.evaluate(
        (configuredIdentity) =>
          window.library.call("initializeClient", configuredIdentity),
        identity,
      ),
    ).rejects.toThrow("IDENTITY_ALREADY_CONFIGURED");
    await setup.close();
    setupClosed = true;
    const reopened = await electron.launch({
      executablePath: packagedExecutable
        ? resolve(packagedExecutable)
        : undefined,
      args: packagedExecutable ? [] : [resolve("apps/teacher")],
      env,
    });
    try {
      const secondRun = await reopened.firstWindow();
      await secondRun.waitForLoadState("domcontentloaded");
      await expect(
        secondRun.getByRole("heading", { name: "首次配置" }),
      ).toHaveCount(0);
      expect(
        await secondRun.evaluate(() =>
          window.library.call<{ identityConfigured: boolean }>("status", {}),
        ),
      ).toMatchObject({ identityConfigured: true });
    } finally {
      await reopened.close();
    }
  } finally {
    if (!setupClosed) await setup.close();
  }
});
