import { expect, test, type Locator, type Page } from "@playwright/test";

function watchConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function expectInside(inner: Locator, outer: Locator) {
  await expect.poll(async () => {
    const innerBox = await inner.boundingBox();
    const outerBox = await outer.boundingBox();
    if (!innerBox || !outerBox) return false;
    return (
      innerBox.x >= outerBox.x &&
      innerBox.y >= outerBox.y &&
      innerBox.x + innerBox.width <= outerBox.x + outerBox.width + 1 &&
      innerBox.y + innerBox.height <= outerBox.y + outerBox.height + 1
    );
  }).toBe(true);
}

async function waitForSimulator(page: Page) {
  await page.goto("/");
  await expect(page.getByText("WASM v3")).toBeVisible();
}

test("runs, steps, watches, clears, collapses, and resizes the chronogram", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors = watchConsoleErrors(page);
  await waitForSimulator(page);

  const shell = page.getByRole("main", { name: "Logsim Ternary 编辑器" });
  const dock = page.getByRole("region", { name: "时序图" });
  const statusbar = page.locator(".statusbar");
  await expect(dock).toBeVisible();
  await expectInside(dock, shell);
  await expectInside(statusbar, shell);

  await page
    .getByLabel("可观察信号")
    .selectOption({ label: "Trit Input.out [1t]" });
  await page.getByRole("button", { name: "添加观察信号" }).click();
  await expect(page.getByTestId("watch-label")).toHaveText("Trit Input.out");

  await page.getByRole("button", { name: "推进一个相位" }).click();
  await page.getByRole("button", { name: "推进一个完整 Tick" }).click();
  await expect(page.getByTestId("chronogram-viewport")).toHaveAttribute(
    "data-frame-count",
    "4",
  );
  await page.getByLabel("时序图游标").fill("3");
  await expect(page.getByTestId("chronogram-cursor-values")).toContainText(
    "Trit Input.out",
  );

  await page.getByLabel("自动时钟速度").selectOption("20");
  await page.getByRole("button", { name: "运行自动时钟" }).click();
  await expect(page.getByRole("button", { name: "暂停自动时钟" })).toBeVisible();
  await expect.poll(async () => Number(
    await page.getByTestId("chronogram-viewport").getAttribute("data-frame-count"),
  )).toBeGreaterThan(4);
  await page.getByRole("button", { name: "暂停自动时钟" }).click();

  const initialHeight = (await dock.boundingBox())?.height ?? 0;
  const resizeHandle = page.getByRole("separator", { name: "调整时序图高度" });
  await resizeHandle.focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(async () => (await dock.boundingBox())?.height ?? 0).toBeGreaterThan(
    initialHeight,
  );

  await page.getByRole("button", { name: "折叠时序图" }).click();
  await expect(dock).toHaveClass(/is-collapsed/);
  await expect(statusbar).toBeVisible();
  await page.getByRole("button", { name: "展开时序图" }).click();
  await page.getByRole("button", { name: "清空时序记录" }).click();
  await expect(page.getByTestId("chronogram-viewport")).toHaveAttribute(
    "data-frame-count",
    "0",
  );

  await page.screenshot({
    path: "test-results/chronogram-1440x900.png",
    fullPage: true,
  });
  expect(consoleErrors).toEqual([]);
});

test("keeps the compact chronogram and status bar unobstructed", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  const consoleErrors = watchConsoleErrors(page);
  await waitForSimulator(page);

  const shell = page.getByRole("main", { name: "Logsim Ternary 编辑器" });
  const dock = page.getByRole("region", { name: "时序图" });
  const statusbar = page.locator(".statusbar");
  await expectInside(dock, shell);
  await expectInside(statusbar, shell);
  await expect(page.getByRole("button", { name: "运行自动时钟" })).toBeVisible();
  await expect(page.getByLabel("自动时钟速度")).toBeVisible();

  const overlap = await page.evaluate(() => {
    const dock = document.querySelector(".chronogram")!.getBoundingClientRect();
    const status = document.querySelector(".statusbar")!.getBoundingClientRect();
    return Math.max(0, dock.bottom - status.top);
  });
  expect(overlap).toBe(0);
  await page.screenshot({
    path: "test-results/chronogram-1024x720.png",
    fullPage: true,
  });
  expect(consoleErrors).toEqual([]);
});
