import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:https";
import { request } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../../apps/server/src/database.js";
import { createApp } from "../../../apps/server/src/app.js";
import { testConfig, identity } from "../../helpers/config.js";
import { certificate } from "../../helpers/certificates.js";
import { sqlServerProviderSchema } from "@record/protocol";

test("C-I: 校园数据源经 TLS 覆盖后立即清空，客户端磁盘没有配置正文", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyez-provider-ui-"));
  const profile = join(dir, "teacher");
  const databaseName = "cyez_provider_ui_" + randomUUID().replaceAll("-", "");
  const adminUrl =
    process.env.TEST_DATABASE_URL ??
    "postgres://cyez_test:integration-only@127.0.0.1:55432/cyez_test";
  const admin = new Database(adminUrl);
  await admin.sequelize.getQueryInterface().createDatabase(databaseName);
  const url = new URL(adminUrl);
  url.pathname = "/" + databaseName;
  const keyFile = join(dir, "provider-key");
  await writeFile(keyFile, randomBytes(32).toString("hex"));
  const db = new Database(url.toString());
  await db.migrator.up();
  await db.initializeIdentity(identity);
  const live = !!process.env.TEST_SQLSERVER_CONFIG;
  const supplied = live
    ? sqlServerProviderSchema.parse(
        JSON.parse(await readFile(process.env.TEST_SQLSERVER_CONFIG!, "utf8")),
      )
    : {
        host: "campus-fixture.invalid",
        port: 1433,
        username: "sql-readonly-test",
        password: "transient-provider-secret-" + randomUUID(),
        caPem: "",
        uidEncoding: "decimal",
      };
  const api = await createApp(
    {
      ...testConfig(url.toString(), join(dir, "spool")),
      providerMode: "sqlserver",
      providerConfigKeyFile: keyFile,
      providerTimeoutMs: 3000,
    },
    {
      database: db,
      // CI Windows verifies real Electron/TLS/PostgreSQL with an explicit SQL test double;
      // TEST_SQLSERVER_CONFIG selects the real TDS adapter when a fixture is available.
      providerFactory: live
        ? undefined
        : () => ({
            async probe() {},
            async lookup() {
              return {
                name: "测试学生",
                className: "Ⅰ（1班）",
                schoolNumber: "",
              };
            },
          }),
      probe: async () => ({
        freeBytes: 100000,
        writable: true,
        oldestAgeMs: 0,
      }),
    },
  );
  await api.app.listen({ host: "127.0.0.1", port: 0 });
  const backendPort = (api.app.server.address() as { port: number }).port;
  const cert = certificate();
  const seen: { method?: string; url?: string }[] = [];
  const tls = createServer(cert, (incoming, response) => {
    seen.push({ method: incoming.method, url: incoming.url });
    const proxy = request(
      {
        hostname: "127.0.0.1",
        port: backendPort,
        method: incoming.method,
        path: incoming.url,
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
  await new Promise<void>((r) => tls.listen(0, "127.0.0.1", r));
  const port = (tls.address() as { port: number }).port;
  const executable = process.env.CYEZ_ELECTRON_EXECUTABLE;
  const desktop = await electron.launch({
    executablePath: resolve(
      executable ?? "node_modules/electron/dist/electron.exe",
    ),
    args: executable ? [] : [resolve("apps/teacher")],
    env: {
      ...process.env,
      CYEZ_USER_DATA: profile,
      CYEZ_CLIENT_CONFIG: resolve("config/client.integration.json"),
    },
  });
  try {
    const page = await desktop.firstWindow();
    await page.evaluate(
      async ({ port, pin }) => {
        await window.library.call("configure", { ip: "127.0.0.1", port, pin });
        await window.library.call("login", {
          username: "teacher-test",
          password: "integration-password-only",
          remember: false,
        });
      },
      { port, pin: cert.pin },
    );
    await page.getByRole("link", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "校园数据源", exact: true }).click();
    await page.getByLabel("SQL Server 地址").fill(supplied.host);
    await page.getByLabel("端口", { exact: true }).fill(String(supplied.port));
    await page.getByLabel("数据库账号").fill(supplied.username);
    await page.getByLabel("数据库密码").fill(supplied.password);
    await page.getByLabel("TLS CA 证书（PEM，可留空）").fill(supplied.caPem);
    await page.getByLabel("卡号表示").selectOption(supplied.uidEncoding);
    await page.getByRole("button", { name: "覆盖服务端配置" }).click();
    await expect(page.getByLabel("数据库密码")).toHaveValue("");
    await expect(page.getByLabel("SQL Server 地址")).toHaveValue("");
    await expect(page.getByText("服务端已覆盖校园数据源配置。")).toBeVisible();
    expect(seen.filter((r) => r.url === "/api/v1/provider-config")).toEqual([
      { method: "POST", url: "/api/v1/provider-config" },
    ]);
    expect(
      (await db.providerConfigs.findByPk("campus"))!.get().sealed,
    ).not.toContain(supplied.password);
    await page.reload();
    await page.getByRole("button", { name: "校园数据源", exact: true }).click();
    await expect(page.getByLabel("SQL Server 地址")).toHaveValue("");
    await expect(page.getByLabel("数据库账号")).toHaveValue("");
    await page.screenshot({
      path: "test-results/electron/provider-settings.png",
    });
    await page.getByRole("link", { name: "使用登记", exact: true }).click();
    await page.evaluate(async () => {
      await window.library.call("gate", {
        page: "devices",
        modal: false,
        submitting: false,
      });
      await window.library.call("integrationScan", { fixture: "allowed-1" });
    });
    await expect(page.getByText("测试学生", { exact: true })).toBeVisible();
    expect((await db.students.findOne())!.get().schoolNumber).toBe("");
  } finally {
    await desktop.close();
    await new Promise<void>((r) => tls.close(() => r()));
    await api.app.close();
    await admin.sequelize.getQueryInterface().dropDatabase(databaseName);
    await admin.close();
  }
  async function checkDirectory(path: string): Promise<void> {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const file = join(path, item.name);
      if (item.isDirectory()) await checkDirectory(file);
      else if (item.isFile()) {
        const bytes = await readFile(file);
        for (const marker of [supplied.password, supplied.username]) {
          expect(bytes.includes(Buffer.from(marker))).toBe(false);
          expect(bytes.includes(Buffer.from(marker, "utf16le"))).toBe(false);
        }
      }
    }
  }
  await checkDirectory(profile);
});
