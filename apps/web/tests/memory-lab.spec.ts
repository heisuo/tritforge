import { expect, test, type Page } from "@playwright/test";

function node(page: Page, id: string) {
  return page.locator(`.react-flow__node[data-id="${id}"]`);
}

test("Memory Lab reads ROM and writes, holds, and resets RAM", async ({
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
    .getByRole("button", { name: "载入示例：三进制 Memory Lab" })
    .click();

  await expect(node(page, "rom").locator(".node-signal")).toHaveText("T01");
  await expect(node(page, "ram").locator(".node-signal")).toHaveText("000");

  await page.getByLabel("画布显示模式").selectOption("decimal");
  await expect(node(page, "rom").locator(".node-signal")).toHaveText("-8");
  await expect(node(page, "ram").locator(".node-signal")).toHaveText("0");
  await expect(node(page, "data-input").locator(".node-signal")).toHaveText(
    "6",
  );
  await expect(
    page.getByTestId("wire-label-rom-probe").locator("strong"),
  ).toHaveText("-8");
  await page.getByLabel("画布显示模式").selectOption("balanced");

  await page.getByRole("button", { name: "单步 Tick" }).click();
  await expect(node(page, "ram").locator(".node-signal")).toHaveText("1T0");

  await node(page, "write-enable").click();
  await expect(node(page, "write-enable").locator(".node-signal")).toHaveText(
    "T",
  );
  await node(page, "data-input").click();
  await expect(node(page, "data-input").locator(".node-signal")).toHaveText(
    "T01",
  );
  await page.getByRole("button", { name: "单步 Tick" }).click();
  await expect(node(page, "ram").locator(".node-signal")).toHaveText("1T0");

  await node(page, "reset").click();
  await expect(node(page, "reset").locator(".node-signal")).toHaveText("1");
  await page.getByRole("button", { name: "单步 Tick" }).click();
  await expect(node(page, "ram").locator(".node-signal")).toHaveText("000");
  await expect(node(page, "rom").locator(".node-signal")).toHaveText("T01");

  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  expect(errors).toEqual([]);
});
