import { expect, test } from "@playwright/test";

test("home page exposes the immediate download workflow", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "织册" })).toBeVisible();
  await expect(page.getByPlaceholder(/basic.smartedu.cn/)).toBeVisible();
  await expect(page.getByRole("button", { name: /生成 PDF/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "最近下载" })).toBeVisible();
});
