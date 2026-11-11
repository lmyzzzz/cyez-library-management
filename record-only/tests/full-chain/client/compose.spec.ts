import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConnection } from "../harness/connection.js";
import { createStack } from "../harness/stack.js";

const connection = await loadConnection();
const stack = await createStack(connection);
const host = new URL(connection.baseUrl).hostname;
const port = Number(new URL(connection.baseUrl).port);
const runTag = connection.runId.replace(/[^a-z0-9]/gi, "").toUpperCase();

interface Preview {
  id: string;
  mode: "start" | "end";
  student: { name: string };
}
interface CreatedDevice {
  deviceId: string;
  version: number;
}

let appA: ElectronApplication;
let pageA: Page;
let userDataA: string;
const state = {
  deviceCode: `E2E-${runTag}-A`.slice(0, 60),
  deviceCodeB: `E2E-${runTag}-B`.slice(0, 60),
  notes: `全链路登记-${runTag}`,
};

async function launch(userData: string) {
  const noSandbox =
    process.platform === "linux" &&
    (process.getuid?.() === 0 || process.env.CI === "true")
      ? ["--no-sandbox"]
      : [];
  const app = await electron.launch({
    args: [...noSandbox, resolve("apps/teacher/out/main/index.js")],
    env: {
      ...process.env,
      CYEZ_USER_DATA: userData,
      CYEZ_CLIENT_CONFIG: resolve("config/client.integration.json"),
    },
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

async function call<T = unknown>(
  page: Page,
  action: string,
  input: unknown = {},
): Promise<T> {
  return page.evaluate(
    ({ action, input }) => window.library.call(action as never, input as never),
    { action, input },
  ) as Promise<T>;
}

async function connect(page: Page) {
  await call(page, "configure", {
    ip: host,
    port,
    pin: connection.certPinSha256,
  });
  await call(page, "login", {
    username: connection.username,
    password: connection.password,
    remember: false,
  });
  const status = await call<{ authenticated: boolean }>(page, "status");
  expect(status.authenticated).toBe(true);
}

function deviceRow(page: Page, code: string) {
  return page.locator("tbody tr").filter({ hasText: code });
}

async function showDevices(
  page: Page,
  code: string,
  filter: "使用中" | "未使用" = "未使用",
) {
  await page.getByRole("link", { name: "使用登记", exact: true }).click();
  await page.getByRole("button", { name: filter, exact: true }).click();
  await page.getByRole("button", { name: "刷新", exact: true }).first().click();
  await expect(deviceRow(page, code)).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test.describe("全链路：真实 Electron → TLS 网关 → API → PostgreSQL → 日志归集", () => {
  test.beforeAll(async () => {
    userDataA = await mkdtemp(join(tmpdir(), "cyez-full-chain-a-"));
    ({ app: appA, page: pageA } = await launch(userDataA));
    await connect(pageA);
  });

  test.afterAll(async () => {
    await appA?.close();
  });

  test("空学生缓存首次刷卡建立缓存，完成登记、结束与只读历史", async () => {
    const device = await call<CreatedDevice>(pageA, "createDevice", {
      code: state.deviceCode,
      displayName: "全链路 E2E 设备 A",
      notes: "",
      isDisabled: false,
      tagIds: [],
    });
    expect(device.deviceId).toBeTruthy();

    await showDevices(pageA, state.deviceCode);
    await pageA.getByRole("button", { name: "测试卡 1", exact: true }).click();
    await expect(
      pageA.getByRole("heading", { name: "选择设备", exact: true }),
    ).toBeVisible();
    // The provider fixture returns counter-based names; the first lookup is fresh.
    await expect(
      pageA.getByText("集成学生1", { exact: true }).first(),
    ).toBeVisible();

    await pageA.getByLabel("搜索可选设备").fill(state.deviceCode);
    await pageA
      .getByRole("button", { name: `选择 ${state.deviceCode}`, exact: true })
      .click();
    await pageA.getByLabel("登记备注").fill(state.notes);
    await pageA.getByRole("button", { name: "确认登记", exact: true }).click();
    await pageA.getByRole("button", { name: "使用中", exact: true }).click();
    await expect(
      deviceRow(pageA, state.deviceCode).getByText(state.notes, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      deviceRow(pageA, state.deviceCode).getByText("使用中", { exact: true }),
    ).toBeVisible();

    const active = await stack.rows(
      `SELECT count(*) FROM usage_records r
       JOIN students s ON s.id = r."studentId"
       WHERE r.notes = '${state.notes}' AND r."endedAt" IS NULL AND s.name = '集成学生1'`,
    );
    expect(Number(active[0][0])).toBe(1);
    const cached = await stack.rows(
      "SELECT count(*) FROM students WHERE name = '集成学生1'",
    );
    expect(Number(cached[0][0])).toBe(1);

    await deviceRow(pageA, state.deviceCode)
      .getByRole("button", { name: "结束…", exact: true })
      .click();
    await pageA.getByRole("button", { name: "确认结束", exact: true }).click();
    await pageA.getByRole("button", { name: "未使用", exact: true }).click();
    await pageA.getByRole("link", { name: "设置", exact: true }).click();
    await pageA.getByRole("button", { name: "历史记录", exact: true }).click();
    await expect(pageA.getByText(state.notes, { exact: true })).toBeVisible();
    const historyRow = pageA
      .locator(".interactive-row")
      .filter({ hasText: state.notes });
    await historyRow.click();
    await expect(
      pageA.getByRole("heading", { name: "历史记录详情" }),
    ).toBeVisible();
    await expect(
      pageA.getByRole("button", { name: "保存备注", exact: true }),
    ).toHaveCount(0);
    await expect(
      pageA.getByText("集成学生1", { exact: true }).first(),
    ).toBeVisible();
    await pageA.getByRole("button", { name: "关闭", exact: true }).click();

    const ended = await stack.rows(
      `SELECT count(*) FROM usage_records WHERE notes = '${state.notes}' AND "endedAt" IS NOT NULL AND "endReason" = 'manual'`,
    );
    expect(Number(ended[0][0])).toBe(1);
  });

  test("重复刷卡经 provider 刷新缓存，历史显示最新资料；未授权卡不建缓存", async () => {
    const before = await stack.rows("SELECT count(*) FROM students");
    await showDevices(pageA, state.deviceCode);
    await pageA.getByRole("button", { name: "测试卡 1", exact: true }).click();
    await expect(
      pageA.getByRole("heading", { name: "选择设备", exact: true }),
    ).toBeVisible();
    await expect(
      pageA.getByText("集成学生2", { exact: true }).first(),
    ).toBeVisible();
    await pageA.getByRole("button", { name: "取消登记", exact: true }).click();
    const refreshed = await stack.rows(
      "SELECT count(*) FROM students WHERE name = '集成学生2'",
    );
    expect(Number(refreshed[0][0])).toBe(1);

    // Read-only history joins the latest cached student profile.
    await pageA.getByRole("link", { name: "设置", exact: true }).click();
    await pageA.getByRole("button", { name: "历史记录", exact: true }).click();
    await pageA
      .locator(".interactive-row")
      .filter({ hasText: state.notes })
      .click();
    await expect(
      pageA.getByText("集成学生2", { exact: true }).first(),
    ).toBeVisible();
    await pageA.getByRole("button", { name: "关闭", exact: true }).click();

    await pageA.getByRole("link", { name: "使用登记", exact: true }).click();
    await pageA
      .getByRole("button", { name: "未授权测试卡", exact: true })
      .click();
    await expect(
      pageA
        .getByText(
          "校园资料服务未确认该学生的登记资格。请联系学校数据负责人。",
          {
            exact: true,
          },
        )
        .first(),
    ).toBeVisible();
    await expect(
      pageA.getByRole("heading", { name: "选择设备", exact: true }),
    ).toHaveCount(0);
    await pageA.waitForTimeout(1500);
    const after = await stack.rows("SELECT count(*) FROM students");
    expect(Number(after[0][0])).toBe(Number(before[0][0]));
  });

  test("两个教师端共享账号：占用可见、可跨端结束且状态实时刷新", async () => {
    const device = await call<CreatedDevice>(pageA, "createDevice", {
      code: state.deviceCodeB,
      displayName: "全链路 E2E 设备 B",
      notes: "",
      isDisabled: false,
      tagIds: [],
    });
    expect(device.deviceId).toBeTruthy();

    await showDevices(pageA, state.deviceCodeB);
    await pageA.getByRole("button", { name: "测试卡 2", exact: true }).click();
    await expect(
      pageA.getByRole("heading", { name: "选择设备", exact: true }),
    ).toBeVisible();
    await pageA.getByLabel("搜索可选设备").fill(state.deviceCodeB);
    await pageA
      .getByRole("button", { name: `选择 ${state.deviceCodeB}`, exact: true })
      .click();
    await pageA.getByRole("button", { name: "确认登记", exact: true }).click();
    await pageA.getByRole("button", { name: "使用中", exact: true }).click();
    await expect(
      deviceRow(pageA, state.deviceCodeB).getByText("使用中", { exact: true }),
    ).toBeVisible();

    const userDataB = await mkdtemp(join(tmpdir(), "cyez-full-chain-b-"));
    const { app: appB, page: pageB } = await launch(userDataB);
    try {
      await connect(pageB);
      await showDevices(pageB, state.deviceCodeB, "使用中");
      await expect(
        deviceRow(pageB, state.deviceCodeB).getByText("使用中", {
          exact: true,
        }),
      ).toBeVisible();

      // The same card on another teacher client offers the end flow.
      await pageB
        .getByRole("button", { name: "测试卡 2", exact: true })
        .click();
      await expect(
        pageB.getByRole("heading", { name: "刷卡结束使用", exact: true }),
      ).toBeVisible();
      await pageB
        .getByRole("button", { name: "确认结束", exact: true })
        .click();
      await pageB.getByRole("button", { name: "未使用", exact: true }).click();
      await expect(
        deviceRow(pageB, state.deviceCodeB).getByText("空闲", { exact: true }),
      ).toBeVisible();
    } finally {
      await appB.close();
    }

    await showDevices(pageA, state.deviceCodeB);
    await expect(
      deviceRow(pageA, state.deviceCodeB).getByText("空闲", { exact: true }),
    ).toBeVisible();
    const active = await stack.rows(
      `SELECT count(*) FROM usage_records WHERE "deviceId" = '${device.deviceId}' AND "endedAt" IS NULL`,
    );
    expect(Number(active[0][0])).toBe(0);
  });

  test("API 重启后客户端需重新认证，历史与缓存保留", async () => {
    const students = await stack.rows("SELECT count(*) FROM students");
    const records = await stack.rows(
      'SELECT count(*) FROM usage_records WHERE "endedAt" IS NOT NULL',
    );

    await stack.restart("api");

    await expect(
      call(pageA, "devices", { page: 1, pageSize: 30 }),
    ).rejects.toThrow(/AUTH_REQUIRED/);
    await call(pageA, "configure", {
      ip: host,
      port,
      pin: connection.certPinSha256,
    });
    await call(pageA, "login", {
      username: connection.username,
      password: connection.password,
      remember: false,
    });
    expect(
      (await call<{ authenticated: boolean }>(pageA, "status")).authenticated,
    ).toBe(true);
    await showDevices(pageA, state.deviceCode);
    await pageA.getByRole("link", { name: "设置", exact: true }).click();
    await pageA.getByRole("button", { name: "历史记录", exact: true }).click();
    await expect(pageA.getByText(state.notes, { exact: true })).toBeVisible();
    await expect(
      pageA.locator(".interactive-row").filter({ hasText: state.notes }),
    ).toBeVisible();

    expect(
      Number((await stack.rows("SELECT count(*) FROM students"))[0][0]),
    ).toBe(Number(students[0][0]));
    expect(
      Number(
        (
          await stack.rows(
            'SELECT count(*) FROM usage_records WHERE "endedAt" IS NOT NULL',
          )
        )[0][0],
      ),
    ).toBe(Number(records[0][0]));
  });
});
