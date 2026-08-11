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
  await expect(
    page.locator('.react-flow__edge[data-id="wire-2"] .wire-bridge-gap'),
  ).toHaveCSS("stroke-width", "7px");
  const selectedPath = page.locator(
    '.react-flow__edge[data-id="wire-2"] .react-flow__edge-path',
  );
  const selectedPoint = await selectedPath.evaluate((element) => {
    const path = element as SVGPathElement;
    const point = path.getPointAtLength(path.getTotalLength() * 0.35);
    const matrix = path.getScreenCTM();
    if (!matrix) throw new Error("Wire has no screen transform");
    return {
      x: matrix.a * point.x + matrix.c * point.y + matrix.e,
      y: matrix.b * point.x + matrix.d * point.y + matrix.f,
    };
  });
  await page.mouse.click(selectedPoint.x, selectedPoint.y);
  await expect(page.locator('.react-flow__edge[data-id="wire-2"]')).toHaveClass(
    /selected/,
  );
  await expect(
    page.locator('.react-flow__edge[data-id="wire-2"] .react-flow__edge-path'),
  ).toHaveCSS("stroke", "rgb(24, 103, 210)");
  await expect(page.getByTestId("wire-label-wire-2")).toHaveClass(/is-selected/);
  await page.screenshot({
    path: "test-results/bus-wiring-selected-wire-1440x900.png",
    fullPage: true,
  });
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

test("rejects a width mismatch during connection preview and reports both widths", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors = watchConsoleErrors(page);
  await waitForSimulator(page);
  await page.getByRole("button", { name: "清空" }).click();
  await place(page, "Trit Input", { x: 180, y: 280 });
  await place(page, "Probe", { x: 650, y: 280 });
  await node(page, "trit-input-1").click();
  await applyWidthAndWord(page, 3, "1T0");

  const source = page.getByTestId("handle-trit-input-1-output-out");
  const target = page.getByTestId("handle-probe-1-input-in");
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

  await expect(target).toHaveClass(/connectingto/);
  await expect(target).not.toHaveClass(/valid/);
  await page.mouse.up();

  await expect(page.getByText(/3 trit -> 1 trit/)).toBeVisible();
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await page.screenshot({
    path: "test-results/bus-wiring-width-mismatch-1440x900.png",
    fullPage: true,
  });
  expect(consoleErrors).toEqual([]);
});

test("resizes a splitter mapping together with its trunk width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors = watchConsoleErrors(page);
  await waitForSimulator(page);
  await page.getByRole("button", { name: "清空" }).click();
  await place(page, "分线器", { x: 480, y: 260 });
  await node(page, "splitter-1").click();

  await page.getByRole("button", { name: "宽度 6 trit" }).click();
  await expect(page.getByLabel("位映射")).toHaveValue("0, 1, 2, 0, 1, 2");
  await page.getByRole("button", { name: "应用属性" }).click();
  await expect(page.getByText("属性已更新")).toBeVisible();
  await expect(node(page, "splitter-1").locator(".splitter-trunk small")).toHaveText(
    "6t",
  );

  await page.getByRole("button", { name: "宽度 1 trit" }).click();
  await expect(page.getByLabel("分支数量")).toHaveValue("1");
  await expect(page.getByLabel("位映射")).toHaveValue("0");
  await page.getByRole("button", { name: "应用属性" }).click();
  await expect(page.getByText("属性已更新")).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("keeps 27 splitter branches and a 27-trit word inside stable node bounds", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors = watchConsoleErrors(page);
  await waitForSimulator(page);
  await page.getByRole("button", { name: "清空" }).click();
  await place(page, "Trit Input", { x: 120, y: 180 });
  await place(page, "分线器", { x: 430, y: 110 });
  await place(page, "Probe", { x: 820, y: 650 });

  const word = "1T0".repeat(9);
  await node(page, "trit-input-1").click();
  await applyWidthAndWord(page, 27, word);
  await node(page, "splitter-1").click();
  await page.getByRole("spinbutton", { name: "信号宽度", exact: true }).fill("27");
  await page.getByRole("spinbutton", { name: "分支数量", exact: true }).fill("27");
  await page.getByLabel("位映射").fill(
    Array.from({ length: 27 }, (_, index) => index).join(", "),
  );
  await page.getByRole("button", { name: "应用属性" }).click();
  await expect(page.getByText("属性已更新")).toBeVisible();
  await page.getByRole("button", { name: "适应画布" }).click();

  const splitter = node(page, "splitter-1");
  const branches = splitter.locator(".splitter-branch");
  await expect(branches).toHaveCount(27);
  const geometry = await splitter.evaluate((element) => {
    const nodeRect = element.getBoundingClientRect();
    const rows = Array.from(element.querySelectorAll<HTMLElement>(".splitter-branch"));
    const handles = Array.from(
      element.querySelectorAll<HTMLElement>('[data-testid*="output-branch"]'),
    );
    return {
      node: { top: nodeRect.top, bottom: nodeRect.bottom },
      rows: rows.map((row) => {
        const rect = row.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom };
      }),
      handles: handles.map((handle) => {
        const rect = handle.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          pointerEvents: getComputedStyle(handle).pointerEvents,
        };
      }),
    };
  });
  expect(geometry.rows).toHaveLength(27);
  expect(geometry.handles).toHaveLength(27);
  for (let index = 0; index < geometry.rows.length; index += 1) {
    expect(geometry.rows[index].top).toBeGreaterThanOrEqual(geometry.node.top - 1);
    expect(geometry.rows[index].bottom).toBeLessThanOrEqual(geometry.node.bottom + 1);
    if (index > 0) {
      expect(geometry.rows[index].top).toBeGreaterThanOrEqual(
        geometry.rows[index - 1].bottom,
      );
    }
  }
  for (const handle of geometry.handles) {
    expect(handle.top).toBeGreaterThanOrEqual(geometry.node.top - 1);
    expect(handle.bottom).toBeLessThanOrEqual(geometry.node.bottom + 1);
    expect(handle.width).toBeGreaterThan(3);
    expect(handle.height).toBeGreaterThan(3);
    expect(handle.pointerEvents).toBe("all");
  }

  const sourceSignal = node(page, "trit-input-1").locator(".node-signal");
  await expect(sourceSignal).toHaveText(word);
  const containment = await sourceSignal.evaluate((element) => {
    const signal = element as HTMLElement;
    const parent = signal.closest<HTMLElement>(".circuit-node");
    const signalRect = signal.getBoundingClientRect();
    const parentRect = parent?.getBoundingClientRect();
    return {
      scrollWidth: signal.scrollWidth,
      clientWidth: signal.clientWidth,
      letterSpacing: getComputedStyle(signal).letterSpacing,
      inside:
        !!parentRect &&
        signalRect.left >= parentRect.left &&
        signalRect.right <= parentRect.right,
    };
  });
  expect(containment.scrollWidth).toBeLessThanOrEqual(containment.clientWidth);
  expect(["0px", "normal"]).toContain(containment.letterSpacing);
  expect(containment.inside).toBe(true);

  await node(page, "trit-input-1").dispatchEvent("click", { detail: 2 });
  const inspector = page.getByRole("complementary", { name: "检查器" });
  const signalColumns = inspector.locator(".signal-columns");
  const outputColumn = signalColumns.locator(".signal-group").nth(1);
  const inspectorWord = outputColumn.locator(".signal-row strong", {
    hasText: word,
  });
  await expect(inspectorWord).toHaveText(word);
  const inspectorGeometry = await inspectorWord.evaluate((element) => {
    const value = element as HTMLElement;
    const inspectorElement = value.closest<HTMLElement>(".inspector");
    const column = value.closest<HTMLElement>(".signal-group");
    const columns = value.closest<HTMLElement>(".signal-columns");
    const inspectorRect = inspectorElement?.getBoundingClientRect();
    const columnRect = column?.getBoundingClientRect();
    const columnsRect = columns?.getBoundingClientRect();
    const valueRect = value.getBoundingClientRect();
    return {
      scrollWidth: value.scrollWidth,
      clientWidth: value.clientWidth,
      columnScrollWidth: column?.scrollWidth ?? 0,
      columnClientWidth: column?.clientWidth ?? 0,
      columnsScrollWidth: columns?.scrollWidth ?? 0,
      columnsClientWidth: columns?.clientWidth ?? 0,
      text: value.textContent,
      insideInspector:
        !!inspectorRect &&
        valueRect.left >= inspectorRect.left &&
        valueRect.right <= inspectorRect.right,
      insideColumn:
        !!columnRect &&
        valueRect.left >= columnRect.left &&
        valueRect.right <= columnRect.right,
      columnInsideGrid:
        !!columnRect &&
        !!columnsRect &&
        columnRect.left >= columnsRect.left &&
        columnRect.right <= columnsRect.right,
      columnInsideViewport:
        !!columnRect && columnRect.left >= 0 && columnRect.right <= innerWidth,
    };
  });
  expect(inspectorGeometry.text).toBe(word);
  expect(inspectorGeometry.scrollWidth).toBeLessThanOrEqual(
    inspectorGeometry.clientWidth,
  );
  expect(inspectorGeometry.insideInspector).toBe(true);
  expect(inspectorGeometry.insideColumn).toBe(true);
  expect(inspectorGeometry.columnScrollWidth).toBeLessThanOrEqual(
    inspectorGeometry.columnClientWidth,
  );
  expect(inspectorGeometry.columnsScrollWidth).toBeLessThanOrEqual(
    inspectorGeometry.columnsClientWidth,
  );
  expect(inspectorGeometry.columnInsideGrid).toBe(true);
  expect(inspectorGeometry.columnInsideViewport).toBe(true);

  await connect(
    page,
    "handle-trit-input-1-output-out",
    "handle-splitter-1-input-trunk",
  );
  await connect(
    page,
    "handle-splitter-1-output-branch26",
    "handle-probe-1-input-in",
  );
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(node(page, "probe-1").locator(".node-signal")).toHaveText("1");
  await expect(
    page.locator('.react-flow__edge[data-id="wire-1"] .react-flow__edge-path'),
  ).toHaveCSS("stroke-width", "6px");
  await expect(
    page.locator('.react-flow__edge[data-id="wire-1"] .react-flow__edge-path'),
  ).toHaveCSS("stroke", "rgb(66, 106, 112)");
  await expect(page.getByTestId("wire-label-wire-1")).toHaveCSS(
    "border-color",
    "rgb(66, 106, 112)",
  );
  await expect(page.getByTestId("wire-label-wire-1").locator("strong")).toHaveCSS(
    "color",
    "rgb(66, 106, 112)",
  );
  await page.screenshot({
    path: "test-results/bus-wiring-27-limits-1440x900.png",
    fullPage: true,
  });
  expect(consoleErrors).toEqual([]);
});
