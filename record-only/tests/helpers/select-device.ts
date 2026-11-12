import { expect, type Page } from "@playwright/test";

export function deviceChoice(page: Page, code: string) {
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.getByRole("button", {
    name: new RegExp(`^(取消)?选择 ${escaped}$`),
  });
}

export async function selectDevice(page: Page, code: string) {
  const choice = deviceChoice(page, code);
  await expect(choice).toBeVisible();
  if ((await choice.getAttribute("aria-pressed")) !== "true")
    await choice.click();
  await expect(choice).toHaveAttribute("aria-pressed", "true");
}
