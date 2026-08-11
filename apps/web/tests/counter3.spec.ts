import { expect, test, type Page } from "@playwright/test";

function node(page: Page, id: string) {
  return page.locator(`.react-flow__node[data-id="${id}"]`);
}

test("3-trit counter increments, holds, resets, and exposes its implementation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByText("WASM v3")).toBeVisible();
  await page.getByRole("button", { name: "示例库" }).click();
  await page
    .getByRole("button", { name: "载入示例：3-trit 同步计数器" })
    .click();

  const count = node(page, "count").locator(".node-signal");
  await expect(count).toHaveText("000");
  await page.getByLabel("画布显示模式").selectOption("decimal");
  await expect(count).toHaveText("0");

  for (const value of ["1", "2", "3"]) {
    await page.getByRole("button", { name: "单步 Tick" }).click();
    await expect(count).toHaveText(value);
  }

  await node(page, "enable").click();
  await expect(node(page, "enable").locator(".node-signal")).toHaveText("T");
  await page.getByRole("button", { name: "单步 Tick" }).click();
  await expect(count).toHaveText("3");

  await node(page, "reset").click();
  await expect(node(page, "reset").locator(".node-signal")).toHaveText("1");
  await page.getByRole("button", { name: "单步 Tick" }).click();
  await expect(count).toHaveText("0");

  await node(page, "counter").dblclick();
  await expect(node(page, "register")).toBeVisible();
  await expect(node(page, "adder-0")).toBeVisible();
  await expect(node(page, "adder-1")).toBeVisible();
  await expect(node(page, "adder-2")).toBeVisible();
  await page.screenshot({
    path: "test-results/counter3-implementation-1440x900.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
