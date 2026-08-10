import { expect, test, type Page } from "@playwright/test";

function watchConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

function node(page: Page, id: string) {
  return page.locator(`.react-flow__node[data-id="${id}"]`);
}

async function expectWord(page: Page, q2: string, q1: string, q0: string) {
  await expect(node(page, "probe-q2").locator(".node-signal")).toHaveText(q2);
  await expect(node(page, "probe-q1").locator(".node-signal")).toHaveText(q1);
  await expect(node(page, "probe-q0").locator(".node-signal")).toHaveText(q0);
}

test("desktop Register3 captures, holds, resets, and opens its three DFF lanes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors = watchConsoleErrors(page);
  await page.goto("/");
  await expect(page.getByText("WASM v3")).toBeVisible();

  await page.getByRole("button", { name: "示例库" }).click();
  await page
    .getByRole("button", { name: "载入示例：3-trit 并行寄存器" })
    .click();
  await expect(page.getByText(/已载入示例: 3-trit 并行寄存器/)).toBeVisible();
  await expectWord(page, "0", "0", "0");
  await expect(page.getByText("0 TICKS")).toBeVisible();

  await page.getByRole("button", { name: "单步 Tick" }).click();
  await expectWord(page, "1", "T", "0");
  await expect(node(page, "register-1").locator(".node-signal")).toHaveText("1T0");
  await expect(page.getByText("1 TICKS")).toBeVisible();
  await expect(node(page, "clock-1").locator(".node-signal")).toHaveText("0");

  await node(page, "input-en").click();
  await expect(node(page, "input-en").locator(".node-signal")).toHaveText("T");
  await node(page, "input-d2").click();
  await expect(node(page, "input-d2").locator(".node-signal")).toHaveText("T");
  await node(page, "input-d1").click();
  await expect(node(page, "input-d1").locator(".node-signal")).toHaveText("0");
  await node(page, "input-d0").click();
  await expect(node(page, "input-d0").locator(".node-signal")).toHaveText("1");
  await page.getByRole("button", { name: "单步 Tick" }).click();
  await expectWord(page, "1", "T", "0");
  await expect(page.getByText("2 TICKS")).toBeVisible();

  await node(page, "input-rst").click();
  await expect(node(page, "input-rst").locator(".node-signal")).toHaveText("1");
  await page.getByRole("button", { name: "单步 Tick" }).click();
  await expectWord(page, "0", "0", "0");
  await expect(page.getByText("3 TICKS")).toBeVisible();

  await node(page, "register-1").dblclick();
  await expect(page.getByRole("navigation", { name: "层级导航" })).toContainText(
    "Register3",
  );
  await expect(node(page, "dff-2")).toBeVisible();
  await expect(node(page, "dff-1")).toBeVisible();
  await expect(node(page, "dff-0")).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyClientWidth: document.body.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  expect(dimensions.documentScrollWidth).toBeLessThanOrEqual(
    dimensions.documentClientWidth,
  );
  expect(dimensions.bodyScrollWidth).toBeLessThanOrEqual(dimensions.bodyClientWidth);
  expect(consoleErrors).toEqual([]);
});
