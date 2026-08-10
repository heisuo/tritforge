import { expect, test, type Locator, type Page } from "@playwright/test";

function watchConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function waitForSimulator(page: Page) {
  await page.goto("/");
  await expect(page.getByText("WASM v3")).toBeVisible();
}

function node(page: Page, id: string) {
  return page.locator(`.react-flow__node[data-id="${id}"]`);
}

async function place(
  page: Page,
  name: string,
  position: { x: number; y: number },
) {
  await page
    .getByRole("button", { name: `添加${name}` })
    .dragTo(page.getByRole("region", { name: "电路画布" }), {
      targetPosition: position,
    });
}

async function connect(page: Page, sourceId: string, targetId: string) {
  const source = page.getByTestId(sourceId);
  const target = page.getByTestId(targetId);
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("Connection handle is not visible");
  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2,
    sourceBox.y + sourceBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
}

async function applyWidthAndWord(page: Page, width: number, word: string) {
  await page.getByRole("button", { name: `宽度 ${width} trit` }).click();
  await page.getByLabel("源字值").fill(word);
  await page.getByRole("button", { name: "应用属性" }).click();
  await expect(page.getByText("属性已更新")).toBeVisible();
}

async function setTunnelName(page: Page, id: string, name: string) {
  await node(page, id).click();
  await page.getByLabel("隧道名称").fill(name);
  await page.getByRole("button", { name: "应用属性" }).click();
  await expect(page.getByText("属性已更新")).toBeVisible();
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

test("places, configures, and simulates a split bus with junction and tunnels", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors = watchConsoleErrors(page);
  await waitForSimulator(page);
  await page.getByRole("button", { name: "清空" }).click();

  await place(page, "Trit Input", { x: 80, y: 180 });
  await place(page, "分线器", { x: 320, y: 220 });
  await place(page, "Probe", { x: 780, y: 120 });
  await place(page, "Probe", { x: 780, y: 300 });
  await place(page, "Probe", { x: 780, y: 480 });
  await place(page, "连接点", { x: 500, y: 100 });
  await place(page, "隧道", { x: 610, y: 100 });
  await place(page, "隧道", { x: 610, y: 230 });
  await node(page, "trit-input-1").click();
  await applyWidthAndWord(page, 3, "1T0");
  await setTunnelName(page, "tunnel-1", "DATA0");
  await setTunnelName(page, "tunnel-2", "DATA0");

  await connect(
    page,
    "handle-trit-input-1-output-out",
    "handle-splitter-1-input-trunk",
  );
  await connect(
    page,
    "handle-splitter-1-output-branch0",
    "handle-junction-1-input-net",
  );
  await connect(
    page,
    "handle-junction-1-output-net",
    "handle-tunnel-1-input-net",
  );
  await connect(
    page,
    "handle-tunnel-2-output-net",
    "handle-probe-1-input-in",
  );
  await connect(
    page,
    "handle-splitter-1-output-branch1",
    "handle-probe-2-input-in",
  );
  await connect(
    page,
    "handle-splitter-1-output-branch2",
    "handle-probe-3-input-in",
  );

  await expect(page.locator(".react-flow__edge")).toHaveCount(6);
  await expect(node(page, "probe-1").locator(".node-signal")).toHaveText("0");
  await expect(node(page, "probe-2").locator(".node-signal")).toHaveText("T");
  await expect(node(page, "probe-3").locator(".node-signal")).toHaveText("1");
  await expect(page.getByTestId("wire-label-wire-1")).toContainText("3t");
  await expect(page.getByTestId("wire-label-wire-1")).toContainText("1T0");
  await expect(
    page.locator(".wire-label").filter({ hasText: "DATA0" }),
  ).toHaveCount(2);
  await expect(
    page.locator('.react-flow__edge[data-id="wire-1"] .react-flow__edge-path'),
  ).toHaveCSS("stroke-width", "6px");
  await expect(
    page.locator('.react-flow__edge[data-id="wire-2"] .react-flow__edge-path'),
  ).toHaveCSS("stroke-width", "2px");
  await expect(node(page, "junction-1").locator(".junction-dot")).toBeVisible();

  await node(page, "trit-input-1").click();
  await page.getByRole("button", { name: "宽度 6 trit" }).click();
  await page.getByLabel("源字值").fill("000000");
  await page.getByRole("button", { name: "应用属性" }).click();
  await expect(page.getByRole("alert")).toContainText("WIDTH_MISMATCH");
  await expect(page.locator(".react-flow__edge")).toHaveCount(6);
  const state = JSON.parse(
    (await page.getByRole("region", { name: "电路画布" }).getAttribute("data-wire-state")) ??
      "[]",
  ) as Array<{ id: string; width: number; signal: string }>;
  expect(state.find((wire) => wire.id === "wire-1")).toMatchObject({
    width: 3,
    signal: "1T0",
  });

  await page.screenshot({
    path: "test-results/bus-wiring-1440x900.png",
    fullPage: true,
  });
  expect(consoleErrors).toEqual([]);
});

test("keeps compact drawers and status controls usable at 1024x720", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  const consoleErrors = watchConsoleErrors(page);
  await waitForSimulator(page);

  const shell = page.getByRole("main", { name: "Logsim Ternary 编辑器" });
  const status = page.locator(".statusbar");
  await expect(status).toBeVisible();
  await expectInside(status, shell);

  await page.getByRole("button", { name: "切换元件库" }).click();
  const palette = page.getByRole("complementary", { name: "元件库" });
  await expect(palette).toHaveClass(/is-open/);
  await expect(page.getByRole("button", { name: "添加分线器" })).toBeVisible();
  await expectInside(palette, shell);
  await page.getByRole("button", { name: "关闭侧栏" }).click();

  await page.getByRole("button", { name: "切换检查器" }).click();
  const inspector = page.getByRole("complementary", { name: "检查器" });
  await expect(inspector).toHaveClass(/is-open/);
  await expectInside(inspector, shell);
  await expect(status).toBeVisible();
  await page.screenshot({
    path: "test-results/bus-wiring-1024x720.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await page.getByRole("button", { name: "打开工具菜单" }).click();
  await expect(page.getByRole("button", { name: "单步 Tick" })).toBeVisible();

  const overflow = await page.evaluate(() => ({
    horizontal:
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    vertical:
      document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }));
  expect(overflow).toEqual({ horizontal: 0, vertical: 0 });
  expect(consoleErrors).toEqual([]);
});
