import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:https";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { join, resolve, dirname, sep } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { Database } from "../../../apps/server/src/database.js";
import { createApp } from "../../../apps/server/src/app.js";
import { testConfig, identity } from "../../helpers/config.js";
import { certificate } from "../../helpers/certificates.js";
import { listenForElectron } from "../../helpers/electron-server.js";

const executablePath = resolve(
  process.env.CYEZ_ELECTRON_EXECUTABLE ??
    "release/win-unpacked/图书馆使用登记.exe",
);

test("发布包包含手动输入、硬件进程且不含开发入口和注入刷卡动作", async () => {
  const resources = join(dirname(executablePath), "resources");
  expect((await readdir(join(resources, "readers"))).sort()).toEqual([
    "cyez-reader-acr1552.exe",
    "cyez-reader-mock.exe",
    "cyez-reader-serial.exe",
  ]);
  const asar = createRequire(import.meta.url)("@electron/asar") as {
    listPackage(path: string): string[];
    extractFile(path: string, file: string): Buffer;
  };
  const archive = join(resources, "app.asar");
  const files = asar
    .listPackage(archive)
    .map((name) => name.replaceAll("\\", "/").replace(/^\//, ""));
  expect(files.some((name) => /^(tests|config|src|runtime)\//.test(name))).toBe(
    false,
  );
  const appFiles = files.filter(
    (name) => name.startsWith("out/") && /\.(js|cjs|html|css|map)$/.test(name),
  );
  expect(appFiles.length).toBeGreaterThan(3);
  expect(appFiles.some((name) => name.endsWith(".map"))).toBe(false);
  for (const file of appFiles) {
    const code = asar
      .extractFile(archive, file.split("/").join(sep))
      .toString();
    expect(code, file).not.toMatch(
      /integrationScan|allowed-1|allowed-2|测试卡 1|测试卡 2|未授权测试卡|本机诊断|刷新诊断|手动 UID 测试窗口|开发 \/ 集成环境|sourceMappingURL/,
    );
  }
});

test("正式安装包首次配置、登录、设备管理与手动输入可用；测试入口仍禁用", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyez-release-"));
  const adminUrl =
    process.env.TEST_DATABASE_URL ??
    "postgres://cyez_test:integration-only@127.0.0.1:55432/cyez_test";
  const admin = new Database(adminUrl);
  const name = "cyez_release_" + randomUUID().replaceAll("-", "");
  await admin.sequelize.getQueryInterface().createDatabase(name);
  const url = new URL(adminUrl);
  url.pathname = "/" + name;
  const db = new Database(url.toString());
  await db.migrator.up();
  await db.initializeIdentity(identity);
  const api = await createApp(testConfig(url.toString(), join(dir, "spool")), {
    database: db,
  });
  await api.app.listen({ host: "127.0.0.1", port: 0 });
  const backendPort = (api.app.server.address() as { port: number }).port;
  const cert = certificate();
  const tls = createServer(cert, (incoming, response) => {
    const proxy = request(
      {
        hostname: "127.0.0.1",
        port: backendPort,
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
      response.end();
    });
    incoming.pipe(proxy);
  });
  const port = await listenForElectron(tls);
  const userData = join(dir, "teacher");
  const env = {
    ...process.env,
    CYEZ_USER_DATA: userData,
    NODE_ENV: "development",
    CYEZ_TEST_FEATURES: "true",
  };
  Reflect.deleteProperty(env, "CYEZ_CLIENT_CONFIG");
  const desktop = await electron.launch({ executablePath, args: [], env });
  try {
    const page = await desktop.firstWindow();
    await expect(page.getByRole("heading", { name: "首次配置" })).toBeVisible();
    await page.getByLabel("身份版本").fill(identity.hashVersion);
    await page.getByLabel("发卡方").fill(identity.issuer);
    await page.getByLabel("固定盐（十六进制）").fill(identity.fixedSaltHex);
    await page.getByRole("button", { name: "保存并继续" }).click();
    await page.getByLabel("服务器 IP").fill("127.0.0.1");
    await page.getByLabel("HTTPS 端口").fill(String(port));
    await page.getByLabel("叶证书 SHA-256 指纹").fill(cert.pin);
    await page.getByLabel("共享账号").fill("teacher-test");
    await page
      .getByLabel("密码", { exact: true })
      .fill("integration-password-only");
    await page.getByRole("button", { name: "覆盖连接并登录" }).click();
    await expect(page.getByText("登录成功", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "诊断", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText(/开发 \/ 集成环境/)).toHaveCount(0);
    await expect(
      page.evaluate(() =>
        window.library.call("integrationScan", { fixture: "allowed-1" }),
      ),
    ).rejects.toThrow("IPC_FORBIDDEN");
    await page.getByRole("button", { name: "读卡器", exact: true }).click();
    await expect(page.getByRole("option", { name: "手动输入" })).toHaveCount(1);
    await page.getByLabel("读卡进程").selectOption("mock");
    await page.getByRole("button", { name: "覆盖并启动" }).click();
    await expect(page.getByText(/手动输入已就绪/)).toBeVisible();
    const preferences = await desktop.evaluate(
      async ({ BrowserWindow, Menu }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.webContents.openDevTools();
        await new Promise((resolve) => setTimeout(resolve, 250));
        return {
          opened: window.webContents.isDevToolsOpened(),
          menu: Menu.getApplicationMenu() !== null,
        };
      },
    );
    expect(preferences).toEqual({
      opened: false,
      menu: false,
    });
    await page.evaluate(() =>
      window.library.call("createDevice", {
        code: "RELEASE-01",
        displayName: "发布验证设备",
        notes: "",
        isDisabled: false,
        tagIds: [],
      }),
    );
    await page.getByRole("link", { name: "使用登记", exact: true }).click();
    await page.getByRole("button", { name: "未使用", exact: true }).click();
    await expect(page.getByText("发布验证设备", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /测试卡/ })).toHaveCount(0);
    await page.screenshot({ path: "test-results/release/registration.png" });
    await page.getByRole("link", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "校园数据源", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "覆盖服务端配置" }),
    ).toBeVisible();
    await page.screenshot({ path: "test-results/release/settings.png" });
    expect(
      JSON.parse(await readFile(join(userData, "client-config.json"), "utf8"))
        .environment,
    ).toBe("production");
  } finally {
    await desktop.close();
    await new Promise<void>((r) => tls.close(() => r()));
    await api.app.close();
    await admin.sequelize.getQueryInterface().dropDatabase(name);
    await admin.close();
  }
});
