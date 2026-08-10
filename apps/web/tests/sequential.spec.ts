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

async function loadDffExample(page: Page) {
  await page.getByRole("button", { name: "示例库" }).click();
  await page
    .getByRole("button", { name: "载入示例：单 trit DFF" })
    .click();
  await expect(page.getByText(/已载入示例: 单 trit DFF/)).toBeVisible();
}

test("desktop DFF demo captures, holds, resets, and reloads through real WASM", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors = watchConsoleErrors(page);
  await page.goto("/");
  await expect(page.getByText("WASM v2")).toBeVisible();
  await loadDffExample(page);

  const q = node(page, "dff-1").locator(".node-signal");
  const clock = node(page, "clock-1").locator(".node-signal");
  await expect(q).toHaveText("0");
  await expect(clock).toHaveText("0");
  await expect(page.getByText("0 TICKS")).toBeVisible();

  await page.getByRole("button", { name: "单步 Tick" }).click();
  await expect(q).toHaveText("1");
  await expect(clock).toHaveText("0");
  await expect(page.getByText("1 TICKS")).toBeVisible();

  await node(page, "input-en").click();
  await expect(node(page, "input-en").locator(".node-signal")).toHaveText("T");
  await node(page, "input-d").click();
  await expect(node(page, "input-d").locator(".node-signal")).toHaveText("T");
  await page.getByRole("button", { name: "单步 Tick" }).click();
  await expect(q).toHaveText("1");
  await expect(page.getByText("2 TICKS")).toBeVisible();

  await node(page, "input-rst").click();
  await expect(node(page, "input-rst").locator(".node-signal")).toHaveText("1");
  await page.getByRole("button", { name: "单步 Tick" }).click();
  await expect(q).toHaveText("0");
  await expect(page.getByText("3 TICKS")).toBeVisible();

  await node(page, "input-rst").click();
  await expect(node(page, "input-rst").locator(".node-signal")).toHaveText("T");
  await node(page, "input-en").click();
  await expect(node(page, "input-en").locator(".node-signal")).toHaveText("0");
  await node(page, "input-en").click();
  await expect(node(page, "input-en").locator(".node-signal")).toHaveText("1");
  await page.getByRole("button", { name: "单步 Tick" }).click();
  await expect(q).toHaveText("T");
  await expect(clock).toHaveText("0");
  await expect(page.getByText("4 TICKS")).toBeVisible();

  await loadDffExample(page);
  await expect(q).toHaveText("0");
  await expect(page.getByText("0 TICKS")).toBeVisible();

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
