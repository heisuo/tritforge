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

async function place(page: Page, name: string, position: { x: number; y: number }) {
  await page
    .getByRole("button", { name: `添加${name}` })
    .dragTo(page.getByRole("region", { name: "电路画布" }), {
      targetPosition: position,
    });
}

async function expectConnectionPreviewOrigin(page: Page, handleTestId: string) {
  const handle = page.getByTestId(handleTestId);
  const box = await handle.boundingBox();
  if (!box) throw new Error("Connection handle is not visible");
  const expected = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(expected.x, expected.y);
  await page.mouse.down();
  await page.mouse.move(expected.x + 120, expected.y + 70, { steps: 4 });
  const offset = await page.locator(".react-flow__connection-path").evaluate((path) => {
    const geometry = path as SVGGeometryElement;
    const point = geometry.getPointAtLength(0);
    const matrix = geometry.getScreenCTM();
    if (!matrix) return Number.POSITIVE_INFINITY;
    const screenPoint = new DOMPoint(point.x, point.y).matrixTransform(matrix);
    const handle = document.querySelector<HTMLElement>("[data-testid='handle-tunnel-1-output-net']")!;
    const handleBox = handle.getBoundingClientRect();
    return Math.hypot(
      screenPoint.x - (handleBox.x + handleBox.width / 2),
      screenPoint.y - (handleBox.y + handleBox.height / 2),
    );
  });
  await page.mouse.up();
  expect(offset).toBeLessThanOrEqual(4);
}

test("runs, steps, watches, clears, collapses, and resizes the chronogram", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors = watchConsoleErrors(page);
  await waitForSimulator(page);

  const shell = page.getByRole("main", { name: "TritForge 编辑器" });
  const dock = page.getByRole("region", { name: "时序图" });
  const statusbar = page.locator(".statusbar");
  await expect(dock).toBeVisible();
  await expectInside(dock, shell);
  await expectInside(statusbar, shell);

  await place(page, "Trit Input", { x: 500, y: 180 });
  await page.locator('.react-flow__node[data-id="trit-input-1"]').click();
  await page.getByRole("button", { name: "宽度 3 trit" }).click();
  await page.getByLabel("源字值").fill("1T0");
  await page.getByRole("button", { name: "应用属性" }).click();
  await place(page, "隧道", { x: 760, y: 180 });

  const signalSelect = page.getByLabel("可观察信号");
  const scalarValue = await signalSelect.locator("option").filter({ hasText: "[1t]" }).first().getAttribute("value");
  if (!scalarValue) throw new Error("No scalar trace signal available");
  await signalSelect.selectOption(scalarValue);
  await page.getByRole("button", { name: "添加观察信号" }).click();
  const busValue = await signalSelect.locator("option").filter({ hasText: "[3t]" }).first().getAttribute("value");
  if (!busValue) throw new Error("No bus trace signal available");
  await signalSelect.selectOption(busValue);
  await page.getByRole("button", { name: "添加观察信号" }).click();
  await expect(page.getByTestId("watch-label")).toHaveCount(2);

  await page.getByRole("button", { name: "推进一个相位" }).click();
  await page.getByRole("button", { name: "推进一个完整 Tick" }).click();
  await expect(page.getByTestId("chronogram-viewport")).toHaveAttribute(
    "data-frame-count",
    "4",
  );
  await page.getByLabel("时序图游标").fill("3");
  await expect(page.getByTestId("chronogram-cursor-values")).toContainText("1T0");

  const waveform = page.getByRole("img", { name: "三进制时序波形" });
  const paintedPixels = await waveform.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] < 235 || data[index + 1] < 235 || data[index + 2] < 235) painted += 1;
    }
    return painted;
  });
  expect(paintedPixels).toBeGreaterThan(100);

  await page.getByLabel("自动时钟速度").selectOption("20");
  await page.getByRole("button", { name: "运行自动时钟" }).click();
  await expect(page.getByRole("button", { name: "暂停自动时钟" })).toBeVisible();
  await expect.poll(async () => Number(
    await page.getByTestId("chronogram-viewport").getAttribute("data-frame-count"),
  )).toBeGreaterThan(4);
  await page.getByRole("button", { name: "暂停自动时钟" }).click();

  await expectConnectionPreviewOrigin(page, "handle-tunnel-1-output-net");

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
  await expectConnectionPreviewOrigin(page, "handle-tunnel-1-output-net");
  await page.getByRole("button", { name: "展开时序图" }).click();

  await page.screenshot({
    path: "test-results/chronogram-1440x900.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "清除波形历史" }).click();
  await expect(page.getByTestId("chronogram-viewport")).toHaveAttribute(
    "data-frame-count",
    "0",
  );
  expect(consoleErrors).toEqual([]);
});

test("keeps the compact chronogram and status bar unobstructed", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  const consoleErrors = watchConsoleErrors(page);
  await waitForSimulator(page);

  const shell = page.getByRole("main", { name: "TritForge 编辑器" });
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
