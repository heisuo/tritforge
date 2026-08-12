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

async function loadLesson(page: Page) {
  await page.goto("/");
  await expect(page.getByText("WASM v3")).toBeVisible();
  await page.getByRole("button", { name: "示例库" }).click();
  await page
    .getByRole("button", { name: "载入示例：3-trit 总线、分线与本地 Tunnel" })
    .click();
  await expect(
    page.getByText(/已载入示例: 3-trit 总线、分线与本地 Tunnel/),
  ).toBeVisible();
}

test("real WASM reassembles 1T0 through scalar branches and a local tunnel", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("WASM v3")).toBeVisible();

  const result = await page.evaluate(async () => {
    const [{ cloneBusWiringProject }, wasm] = await Promise.all([
      import("../src/examples/bus-wiring"),
      import("../src/wasm/pkg/sim_wasm.js"),
    ]);
    await wasm.default();
    const simulator = new wasm.WasmProjectSimulator();
    const snapshot = simulator.loadProject(cloneBusWiringProject(), "main");
    return {
      stable: snapshot.stable,
      compileCount: snapshot.compileCount,
      final: snapshot.inputNetWords["probe-word"]?.in,
      lst:
        snapshot.inputNets["probe-lst"]?.in ??
        snapshot.inputNetWords["probe-lst"]?.in,
      mid:
        snapshot.inputNets["probe-mid"]?.in ??
        snapshot.inputNetWords["probe-mid"]?.in,
      mst:
        snapshot.inputNets["probe-mst"]?.in ??
        snapshot.inputNetWords["probe-mst"]?.in,
      diagnostics: snapshot.diagnostics,
    };
  });

  expect(result).toEqual({
    stable: true,
    compileCount: 1,
    final: "1T0",
    lst: "0",
    mid: "T",
    mst: "1",
    diagnostics: [],
  });
});

test("loads the basic same-name Tunnel lesson", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors = watchConsoleErrors(page);
  await page.goto("/");
  await expect(page.getByText("WASM v3")).toBeVisible();
  await page.getByRole("button", { name: "清空" }).click();
  for (let index = 0; index < 3; index += 1) {
    await page.getByRole("button", { name: "添加隧道" }).click();
  }
  await expect(page.locator(".wiring-tunnel strong")).toHaveText([
    "tunnel0",
    "tunnel1",
    "tunnel2",
  ]);
  await page.getByRole("button", { name: "示例库" }).click();
  await page
    .getByRole("button", { name: "载入示例：Tunnel 隔空连线入门" })
    .click();

  await expect(node(page, "tunnel-probe").locator(".node-signal")).toHaveText(
    "1",
  );
  await expect(page.locator(".wiring-tunnel strong")).toHaveText([
    "tunnel0",
    "tunnel0",
  ]);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(page.getByText("同名即连接")).toBeVisible();
  await page.screenshot({
    path: "test-results/tunnel-basics-1440x900.png",
    fullPage: true,
  });
  expect(consoleErrors).toEqual([]);
});

test("desktop loads the editable lesson without node or page overlap", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors = watchConsoleErrors(page);
  await loadLesson(page);

  await expect(node(page, "probe-lst").locator(".node-signal")).toHaveText("0");
  await expect(node(page, "probe-mid").locator(".node-signal")).toHaveText("T");
  await expect(node(page, "probe-mst").locator(".node-signal")).toHaveText("1");
  await expect(node(page, "probe-word").locator(".node-signal")).toHaveText(
    "1T0",
  );
  await expect(page.getByText("字序与位序")).toBeVisible();
  await expect(page.getByText("本地 Tunnel", { exact: true })).toBeVisible();

  await node(page, "word-input").click();
  await page.getByLabel("源字值").fill("T01");
  await page.getByRole("button", { name: "应用属性" }).click();
  await expect(page.getByText("属性已更新")).toBeVisible();
  await expect(node(page, "probe-lst").locator(".node-signal")).toHaveText("1");
  await expect(node(page, "probe-mid").locator(".node-signal")).toHaveText("0");
  await expect(node(page, "probe-mst").locator(".node-signal")).toHaveText("T");
  await expect(node(page, "probe-word").locator(".node-signal")).toHaveText(
    "T01",
  );
  const headings = await page.locator(".react-flow__node").evaluateAll((elements) =>
    Object.fromEntries(
      elements.map((element) => [
        element.getAttribute("data-id"),
        element
          .querySelector(
            ".node-heading span, .splitter-title strong, .wiring-tunnel strong",
          )
          ?.textContent?.trim() ?? "",
      ]),
    ),
  );
  expect(headings).toMatchObject({
    "word-input": "三位输入",
    "split-word": "拆分总线",
    "probe-lst": "branch0 / LST",
    "tunnel-send": "DATA_MID",
    "tunnel-receive": "DATA_MID",
    "probe-mid": "branch1",
    "probe-mst": "branch2 / MST",
    "join-word": "重组三位总线",
    "probe-word": "重组输出",
  });
  expect(Object.values(headings).join(" ")).not.toMatch(
    /1T0|=\s*(?:0|T|1)(?:\s|$)/,
  );

  await page.getByLabel("源字值").fill("1T0");
  await page.getByRole("button", { name: "应用属性" }).click();
  await expect(node(page, "probe-word").locator(".node-signal")).toHaveText(
    "1T0",
  );

  const geometry = await page.locator(".react-flow").evaluate((flow) => {
    const rectangles = Array.from(
      flow.querySelectorAll<HTMLElement>(".react-flow__node"),
    ).map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        id: element.getAttribute("data-id"),
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      };
    });
    const labels = Array.from(
      flow.querySelectorAll<HTMLElement>(".wire-label"),
    ).map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        id: element.getAttribute("data-testid"),
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      };
    });
    const collides = (
      left: (typeof rectangles)[number],
      right: (typeof rectangles)[number],
      margin: number,
    ) =>
      left.left - margin < right.right &&
      left.right + margin > right.left &&
      left.top - margin < right.bottom &&
      left.bottom + margin > right.top;
    const nodeOverlaps: string[] = [];
    for (let left = 0; left < rectangles.length; left += 1) {
      for (let right = left + 1; right < rectangles.length; right += 1) {
        const a = rectangles[left];
        const b = rectangles[right];
        if (collides(a, b, 1)) nodeOverlaps.push(`${a.id}/${b.id}`);
      }
    }
    const labelNodeCollisions = labels.flatMap((label) =>
      rectangles
        .filter((rectangle) => collides(label, rectangle, 3))
        .map((rectangle) => `${label.id}/${rectangle.id}`),
    );
    const labelCollisions: string[] = [];
    for (let left = 0; left < labels.length; left += 1) {
      for (let right = left + 1; right < labels.length; right += 1) {
        if (collides(labels[left], labels[right], 3)) {
          labelCollisions.push(`${labels[left].id}/${labels[right].id}`);
        }
      }
    }
    const viewport = flow.querySelector<HTMLElement>(".react-flow__viewport");
    const scale = viewport
      ? new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a
      : 0;
    return {
      nodeOverlaps,
      labelNodeCollisions,
      labelCollisions,
      count: rectangles.length,
      labelCount: labels.length,
      minimumReadableNodeWidth: Math.min(
        ...rectangles
          .filter((rectangle) => rectangle.id !== "lst-junction")
          .map((rectangle) => rectangle.right - rectangle.left),
      ),
      scale,
      pageClientWidth: document.documentElement.clientWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
      pageClientHeight: document.documentElement.clientHeight,
      pageScrollHeight: document.documentElement.scrollHeight,
    };
  });

  expect(geometry.count).toBe(10);
  expect(geometry.labelCount).toBe(10);
  expect(geometry.nodeOverlaps).toEqual([]);
  expect(geometry.labelNodeCollisions).toEqual([]);
  expect(geometry.labelCollisions).toEqual([]);
  expect(geometry.minimumReadableNodeWidth).toBeGreaterThanOrEqual(56);
  expect(geometry.scale).toBeGreaterThanOrEqual(0.55);
  expect(geometry.pageScrollWidth).toBeLessThanOrEqual(geometry.pageClientWidth);
  expect(geometry.pageScrollHeight).toBeLessThanOrEqual(geometry.pageClientHeight);
  await page.screenshot({
    path: "test-results/bus-tunnel-teaching-1440x900.png",
    fullPage: true,
  });
  expect(consoleErrors).toEqual([]);
});
