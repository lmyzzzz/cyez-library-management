import { expect, type ElectronApplication, type Page } from "@playwright/test";

/** 管理后台之外的两个窗口：刷卡窗口（scan）和状态悬浮窗（status）。 */
export async function auxWindow(
  app: ElectronApplication,
  role: "scan" | "status",
): Promise<Page> {
  const find = () =>
    app.windows().find((page) => page.url().includes(`?window=${role}`));
  await expect.poll(() => !!find(), { timeout: 30_000 }).toBe(true);
  const page = find()!;
  await page.waitForLoadState("domcontentloaded");
  return page;
}
