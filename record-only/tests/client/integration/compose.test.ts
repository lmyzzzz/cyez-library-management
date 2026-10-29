import { test, expect, _electron as electron } from "@playwright/test";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.skip(
  process.env.COMPOSE_E2E !== "1",
  "Requires explicit seeded integration Compose stack",
);

test("打包 Electron 连接 Compose gateway：登记、结束、只读历史", async () => {
  const username = process.env.TEST_TEACHER_USERNAME;
  const password = process.env.TEST_TEACHER_PASSWORD;
  if (!username || !password) throw Error("TEST_TEACHER_CREDENTIALS_REQUIRED");
  const cert = new X509Certificate(
    await readFile(resolve("secrets/server.crt")),
  );
  const userData = await mkdtemp(join(tmpdir(), "cyez-packaged-e2e-"));
  const app = await electron.launch({
    executablePath: resolve("release/win-unpacked/图书馆使用登记.exe"),
    env: {
      ...process.env,
      CYEZ_USER_DATA: userData,
      CYEZ_CLIENT_CONFIG: resolve("config/client.integration.json"),
    },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const call = async (action: string, input: unknown = {}) =>
      page.evaluate(
        ({ action, input }) =>
          window.library.call(action as never, input as never),
        { action, input },
      );
    await call("configure", {
      ip: "127.0.0.1",
      port: Number(process.env.COMPOSE_HTTPS_PORT ?? 8443),
      pin: cert.fingerprint256.replaceAll(":", "").toLowerCase(),
    });
    await call("login", { username, password, remember: false });
    const code = `PACKAGED-${Date.now()}`;
    await call("createDevice", {
      code,
      displayName: "打包联调设备",
      notes: "",
      isDisabled: false,
      tagIds: [],
    });
    await page.getByRole("button", { name: "未使用", exact: true }).click();
    await page
      .getByRole("button", { name: "刷新", exact: true })
      .first()
      .click();
    await expect(page.getByText(code, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "测试卡 1", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "登记使用", exact: true }),
    ).toBeVisible();
    await page.getByLabel("搜索可选设备").fill(code);
    await page
      .locator(".picker-row")
      .filter({ hasText: code })
      .getByRole("button", { name: "选择", exact: true })
      .click();
    await page.getByLabel("登记备注").fill("打包端到端记录");
    await page.getByRole("button", { name: "确认登记", exact: true }).click();
    await page.getByRole("button", { name: "使用中", exact: true }).click();
    await expect(
      page.getByText("打包端到端记录", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "结束…", exact: true }).click();
    await page.getByRole("button", { name: "确认结束", exact: true }).click();
    await page.getByRole("link", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "历史记录", exact: true }).click();
    await page.getByLabel("历史设备搜索").fill(code);
    const historyRow = page
      .locator(".interactive-row")
      .filter({ hasText: code });
    await expect(
      historyRow.getByText("打包端到端记录", { exact: true }),
    ).toBeVisible();
    await historyRow.click();
    await expect(
      page.getByRole("heading", { name: "历史记录详情" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "保存备注", exact: true }),
    ).toHaveCount(0);
  } finally {
    await app.close();
  }
});
