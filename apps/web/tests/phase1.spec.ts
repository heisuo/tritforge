import { expect, test, type Page } from "@playwright/test";

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
  await expect(page.getByText("WASM v2")).toBeVisible();
}

function node(page: Page, id: string) {
  return page.locator(`.react-flow__node[data-id="${id}"]`);
}

async function connect(page: Page, sourceTestId: string, targetTestId: string) {
  const source = page.getByTestId(sourceTestId);
  const target = page.getByTestId(targetTestId);
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

test("edits and simulates a ternary circuit through Rust/WASM", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors = watchConsoleErrors(page);
  await waitForSimulator(page);

  await expect(node(page, "input-1").locator(".node-signal")).toHaveText("0");
  await expect(node(page, "probe-1").locator(".node-signal")).toHaveText("0");
  for (const [input, output] of [
    ["1", "T"],
    ["T", "1"],
    ["0", "0"],
  ] as const) {
    await node(page, "input-1").click();
    await expect(node(page, "input-1").locator(".node-signal")).toHaveText(input);
    await expect(node(page, "probe-1").locator(".node-signal")).toHaveText(output);
  }

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出工程" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("logsim-ternary-circuit.json");
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  await page.getByRole("button", { name: "清空" }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await page
    .getByLabel("选择三进制工程文件")
    .setInputFiles(downloadPath!);
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await page.getByRole("button", { name: "清空" }).click();
  await page.getByRole("button", { name: "撤销" }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await page.getByRole("button", { name: "重做" }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);

  const canvas = page.getByRole("region", { name: "电路画布" });
  const inputItem = page.locator(".palette-item").filter({ hasText: "Trit Input" });
  const minItem = page.locator(".palette-item").filter({ hasText: /^MIN/ });
  const probeItem = page.locator(".palette-item").filter({ hasText: "Probe" });
  await inputItem.dragTo(canvas, { targetPosition: { x: 80, y: 160 } });
  const widthBeforeZoom =
    (await node(page, "trit-input-1").boundingBox())?.width ?? 0;
  await canvas.hover({ position: { x: 440, y: 320 } });
  await page.mouse.wheel(0, 600);
  await expect
    .poll(async () => (await node(page, "trit-input-1").boundingBox())?.width ?? 0)
    .toBeLessThan(widthBeforeZoom * 0.9);
  await inputItem.dragTo(canvas, { targetPosition: { x: 80, y: 430 } });
  await minItem.dragTo(canvas, { targetPosition: { x: 600, y: 290 } });
  await probeItem.dragTo(canvas, { targetPosition: { x: 800, y: 290 } });
  await expect(page.locator(".react-flow__node")).toHaveCount(4);

  await node(page, "trit-input-2").click();
  await expect(node(page, "trit-input-2").locator(".node-signal")).toHaveText("1");
  await connect(
    page,
    "handle-trit-input-1-output-out",
    "handle-min-1-input-a",
  );
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await connect(
    page,
    "handle-trit-input-2-output-out",
    "handle-min-1-input-b",
  );
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await connect(page, "handle-min-1-output-y", "handle-probe-1-input-in");
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);
  await expect(node(page, "probe-1").locator(".node-signal")).toHaveText("0");

  await connect(
    page,
    "handle-trit-input-2-output-out",
    "handle-probe-1-input-in",
  );
  await expect(node(page, "probe-1").locator(".node-signal")).toHaveText("E");
  await page.locator('.react-flow__edge[data-id="wire-4"]').click({ force: true });
  await page.getByRole("button", { name: "删除所选" }).click();
  await expect(node(page, "probe-1").locator(".node-signal")).toHaveText("0");
  expect(consoleErrors).toEqual([]);
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 900, drawers: false },
  { name: "compact", width: 900, height: 700, drawers: true },
  { name: "mobile", width: 390, height: 844, drawers: true },
]) {
  test(`${viewport.name} workbench has no page overflow`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const consoleErrors = watchConsoleErrors(page);
    await waitForSimulator(page);
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);

    if (viewport.drawers) {
      await page.getByRole("button", { name: "切换元件库" }).click();
      await expect(page.getByRole("complementary", { name: "元件库" })).toHaveClass(
        /is-open/,
      );
      await page.getByRole("button", { name: "关闭侧栏" }).click();
      await page.getByRole("button", { name: "切换检查器" }).click();
      await expect(page.getByRole("complementary", { name: "检查器" })).toHaveClass(
        /is-open/,
      );
    }
    expect(consoleErrors).toEqual([]);
  });
}

test("200 components and 400 connections propagate within the phase-one baseline", async ({
  page,
}) => {
  await waitForSimulator(page);
  const result = await page.evaluate(async () => {
    const wasm = await import("../src/wasm/pkg/sim_wasm.js");
    await wasm.default();
    const simulator = new wasm.WasmSimulator();
    const components = Array.from({ length: 200 }, (_, index) => ({
      id: `component-${index}`,
      type_id:
        index === 0
          ? "source.trit_input"
          : index % 2 === 0
            ? "gate.buf"
            : "gate.neg",
      properties: index === 0 ? { value: "0" } : {},
    }));
    const connections: Array<{
      id: string;
      source_component_id: string;
      source_port_id: string;
      target_component_id: string;
      target_port_id: string;
    }> = [];
    for (let index = 1; index < 200; index += 1) {
      connections.push({
        id: `wire-${connections.length}`,
        source_component_id: `component-${index - 1}`,
        source_port_id: index - 1 === 0 ? "out" : "y",
        target_component_id: `component-${index}`,
        target_port_id: "a",
      });
      if (index >= 2) {
        connections.push({
          id: `wire-${connections.length}`,
          source_component_id: `component-${index - 2}`,
          source_port_id: index - 2 === 0 ? "out" : "y",
          target_component_id: `component-${index}`,
          target_port_id: "a",
        });
      }
    }
    for (const target of [197, 198, 199]) {
      connections.push({
        id: `wire-${connections.length}`,
        source_component_id: "component-0",
        source_port_id: "out",
        target_component_id: `component-${target}`,
        target_port_id: "a",
      });
    }
    simulator.loadCircuit({ components, connections });
    const start = performance.now();
    const snapshot = simulator.setInput("component-0", "1");
    const durationMs = performance.now() - start;
    return {
      componentCount: components.length,
      connectionCount: connections.length,
      durationMs,
      stable: snapshot.stable,
    };
  });
  const thresholdMs = process.env.CI ? 150 : 50;
  console.info({ ...result, localTargetMs: 50, ciThresholdMs: 150 });
  expect(result.componentCount).toBe(200);
  expect(result.connectionCount).toBe(400);
  expect(result.stable).toBe(true);
  expect(result.durationMs).toBeLessThan(thresholdMs);
});
