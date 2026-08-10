import { expect, test, type Page } from "@playwright/test";

type Viewport = { name: string; width: number; height: number };

const VIEWPORTS: Viewport[] = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "compact", width: 900, height: 700 },
  { name: "mobile", width: 390, height: 844 },
];

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

async function waitForSimulator(page: Page) {
  await page.goto("/");
  await expect(page.getByText("WASM v3")).toBeVisible();
}

async function loadHierarchicalAdder(page: Page) {
  const menuToggle = page.getByRole("button", { name: "打开工具菜单" });
  const usesCompactMenu = await menuToggle.isVisible();
  if (usesCompactMenu) await menuToggle.click();
  await page.getByRole("button", { name: "示例库" }).click();
  await page
    .getByRole("button", { name: "载入示例：可展开的层级全加器" })
    .click();
  await expect(page.getByText(/已载入示例: 可展开的层级全加器/)).toBeVisible();
  await expect(node(page, "full-adder-1")).toBeVisible();
  if (usesCompactMenu) await menuToggle.click();
}

test("loads the hierarchical adder, navigates its instances, and protects its interface", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors = watchConsoleErrors(page);
  await waitForSimulator(page);
  await loadHierarchicalAdder(page);

  await expect(node(page, "probe-sum").locator(".node-signal")).toHaveText("T");
  await expect(node(page, "probe-carry").locator(".node-signal")).toHaveText("1");
  await node(page, "input-cin").click();
  await expect(node(page, "probe-sum").locator(".node-signal")).toHaveText("0");
  await expect(node(page, "probe-carry").locator(".node-signal")).toHaveText("1");

  await node(page, "full-adder-1").dblclick();
  const breadcrumbs = page.getByRole("navigation", { name: "层级导航" });
  await expect(breadcrumbs).toContainText("Main");
  await expect(breadcrumbs).toContainText("Full Adder");
  await expect(node(page, "half-adder-1")).toBeVisible();

  await node(page, "half-adder-1").dblclick();
  await expect(breadcrumbs).toContainText("Half Adder");
  await expect(node(page, "sum-gate")).toBeVisible();

  await node(page, "input-a").click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "删除所选" }).click();
  await expect(page.getByText(/删除受保护:.*half-adder\/a-sum/)).toBeVisible();
  await expect(node(page, "input-a")).toBeVisible();

  await breadcrumbs.getByRole("button", { name: "Main" }).click();
  await expect(node(page, "full-adder-1")).toBeVisible();
  await page.getByRole("button", { name: "删除 Full Adder" }).click();
  await expect(page.getByText(/删除受保护:.*1 个引用.*main\/full-adder-1/)).toBeVisible();
  await expect(node(page, "full-adder-1")).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("all 27 known inputs satisfy balanced ternary addition in the real WASM project simulator", async ({
  page,
}) => {
  await waitForSimulator(page);
  const result = await page.evaluate(async () => {
    const [{ cloneHierarchicalAdderProject }, { migrateV2ToV3 }, wasm] = await Promise.all([
      import("../src/examples/hierarchical-adder"),
      import("../src/project/project-v3"),
      import("../src/wasm/pkg/sim_wasm.js"),
    ]);
    await wasm.default();
    const simulator = new wasm.WasmProjectSimulator();
    const project = migrateV2ToV3(cloneHierarchicalAdderProject());
    let snapshot = simulator.loadProject(project, "main");
    const symbols = ["T", "0", "1"] as const;
    const numeric = { T: -1, "0": 0, "1": 1 } as const;
    const failures: Array<Record<string, unknown>> = [];

    for (const a of symbols) {
      for (const b of symbols) {
        for (const cin of symbols) {
          snapshot = simulator.setSource("main", "input-a", a);
          snapshot = simulator.setSource("main", "input-b", b);
          snapshot = simulator.setSource("main", "input-cin", cin);
          const sum = snapshot.inputNets["probe-sum"]?.in;
          const carry = snapshot.inputNets["probe-carry"]?.in;
          const left = numeric[a] + numeric[b] + numeric[cin];
          const right =
            numeric[sum as keyof typeof numeric] +
            3 * numeric[carry as keyof typeof numeric];
          if (!snapshot.stable || left !== right) {
            failures.push({ a, b, cin, sum, carry, left, right, stable: snapshot.stable });
          }
        }
      }
    }

    return {
      cases: 27,
      failures,
      compileCount: snapshot.compileCount,
    };
  });

  expect(result.cases).toBe(27);
  expect(result.failures).toEqual([]);
  expect(result.compileCount).toBe(1);
});

test("one Half Adder definition update reaches both instances without source recompilation", async ({
  page,
}) => {
  await waitForSimulator(page);
  const result = await page.evaluate(async () => {
    const [{ cloneHierarchicalAdderProject }, { migrateV2ToV3 }, wasm] = await Promise.all([
      import("../src/examples/hierarchical-adder"),
      import("../src/project/project-v3"),
      import("../src/wasm/pkg/sim_wasm.js"),
    ]);
    await wasm.default();
    const simulator = new wasm.WasmProjectSimulator();
    const project = migrateV2ToV3(cloneHierarchicalAdderProject());
    simulator.loadProject(project, "full-adder");
    simulator.setSource("full-adder", "input-a", "1");
    simulator.setSource("full-adder", "input-b", "T");
    const before = simulator.setSource("full-adder", "input-cin", "1");

    const halfAdder = project.circuits.find((circuit) => circuit.id === "half-adder")!;
    const sumGate = halfAdder.components.find((component) => component.id === "sum-gate")!;
    sumGate.typeId = "gate.min";
    const fullAdder = project.circuits.find((circuit) => circuit.id === "full-adder")!;
    for (const [componentId, previewValue] of [
      ["input-a", "1"],
      ["input-b", "T"],
      ["input-cin", "1"],
    ] as const) {
      const boundary = fullAdder.components.find(
        (component) => component.id === componentId,
      )!;
      boundary.properties.previewValue = previewValue;
    }
    const after = simulator.updateProject(project);

    return {
      before: [
        before.componentOutputs["half-adder-1"]?.sum,
        before.componentOutputs["half-adder-2"]?.sum,
      ],
      after: [
        after.componentOutputs["half-adder-1"]?.sum,
        after.componentOutputs["half-adder-2"]?.sum,
      ],
      compileCountBeforeUpdate: before.compileCount,
      compileCountAfterUpdate: after.compileCount,
    };
  });

  expect(result.before).toEqual(["0", "1"]);
  expect(result.after).toEqual(["T", "T"]);
  expect(result.compileCountBeforeUpdate).toBe(1);
  expect(result.compileCountAfterUpdate).toBe(2);
});

test("exports v3, clears, and reimports it while reporting recursive v2 imports", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForSimulator(page);
  await loadHierarchicalAdder(page);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出工程" }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const exported = Buffer.concat(chunks);
  const document = JSON.parse(exported.toString("utf8")) as {
    version: number;
    circuits: Array<{
      id: string;
      wires: unknown[];
      connections?: unknown[];
    }>;
  };
  expect(document.version).toBe(3);
  expect(document.circuits.every((circuit) => Array.isArray(circuit.wires))).toBe(true);
  expect(document.circuits.every((circuit) => circuit.connections === undefined)).toBe(true);
  expect(document.circuits.map((circuit) => circuit.id)).toEqual([
    "main",
    "full-adder",
    "half-adder",
  ]);

  await page.getByRole("button", { name: "清空" }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await page.getByLabel("选择三进制工程文件").setInputFiles({
    name: "hierarchical-adder.json",
    mimeType: "application/json",
    buffer: exported,
  });
  await expect(node(page, "full-adder-1")).toBeVisible();
  await expect(node(page, "probe-sum").locator(".node-signal")).toHaveText("T");
  await node(page, "full-adder-1").dblclick();
  await expect(page.locator(".react-flow__node")).toHaveCount(8);
  await expect(page.locator(".react-flow__edge")).toHaveCount(8);
  await node(page, "half-adder-1").dblclick();
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  await expect(page.locator(".react-flow__edge")).toHaveCount(6);
  await expect(page.getByRole("navigation", { name: "层级导航" })).toContainText(
    "Half Adder",
  );

  const recursiveProject = {
    format: "logsim-ternary",
    version: 2,
    rootCircuitId: "main",
    circuits: [
      {
        id: "main",
        name: "Main",
        kind: "main",
        components: [
          {
            id: "loop-1",
            typeId: "project.module_instance",
            position: { x: 100, y: 100 },
            properties: { moduleId: "loop", label: "Loop" },
          },
        ],
        connections: [],
      },
      {
        id: "loop",
        name: "Loop",
        kind: "module",
        components: [
          {
            id: "self-1",
            typeId: "project.module_instance",
            position: { x: 100, y: 100 },
            properties: { moduleId: "loop", label: "Self" },
          },
        ],
        connections: [],
      },
    ],
  };
  await page.getByLabel("选择三进制工程文件").setInputFiles({
    name: "recursive.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(recursiveProject)),
  });
  await expect(page.getByText(/工程加载失败: project operation failed/i)).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: /MODULE_DEPENDENCY_CYCLE module dependency cycle: loop -> loop/i,
    }),
  ).toBeVisible();
});

for (const viewport of VIEWPORTS) {
  test(`${viewport.name} hierarchy has no console errors or page overflow`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const consoleErrors = watchConsoleErrors(page);
    await waitForSimulator(page);
    await loadHierarchicalAdder(page);
    await node(page, "full-adder-1").dblclick();
    await expect(node(page, "half-adder-1")).toBeVisible();

    if (viewport.width < 1080) {
      await page.getByRole("button", { name: "切换元件库" }).click();
      await expect(page.locator("#component-palette")).toHaveClass(/is-open/);
    }

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
}

test("100 Full Adders compile and propagate within the phase 2B v3 budget", async ({
  page,
}) => {
  await waitForSimulator(page);
  const result = await page.evaluate(async () => {
    const [{ cloneHierarchicalAdderProject }, { migrateV2ToV3 }, wasm] = await Promise.all([
      import("../src/examples/hierarchical-adder"),
      import("../src/project/project-v3"),
      import("../src/wasm/pkg/sim_wasm.js"),
    ]);
    await wasm.default();
    const project = cloneHierarchicalAdderProject();
    const main = project.circuits.find((circuit) => circuit.id === "main")!;
    main.components = [
      {
        id: "shared-a",
        typeId: "source.trit_input",
        position: { x: 0, y: 0 },
        properties: { value: "0", label: "Shared A" },
      },
      {
        id: "shared-b",
        typeId: "source.trit_input",
        position: { x: 0, y: 150 },
        properties: { value: "1", label: "Shared B" },
      },
      {
        id: "shared-cin",
        typeId: "source.trit_input",
        position: { x: 0, y: 300 },
        properties: { value: "T", label: "Shared CIN" },
      },
    ];
    main.connections = [];

    for (let index = 0; index < 100; index += 1) {
      const instanceId = `full-adder-${index}`;
      main.components.push({
        id: instanceId,
        typeId: "project.module_instance",
        position: {
          x: 300 + (index % 10) * 240,
          y: Math.floor(index / 10) * 180,
        },
        properties: { moduleId: "full-adder", label: `FA ${index}` },
      });
      for (const [source, targetPort] of [
        ["shared-a", "a"],
        ["shared-b", "b"],
        ["shared-cin", "cin"],
      ] as const) {
        main.connections.push({
          id: `wire-${main.connections.length}`,
          sourceComponentId: source,
          sourcePortId: "out",
          targetComponentId: instanceId,
          targetPortId: targetPort,
        });
      }
    }

    for (const index of [0, 99]) {
      for (const port of ["sum", "carry"] as const) {
        const probeId = `probe-${port}-${index}`;
        main.components.push({
          id: probeId,
          typeId: "sink.probe",
          position: { x: 2900, y: index * 12 + (port === "sum" ? 0 : 80) },
          properties: { label: `${port.toUpperCase()} ${index}` },
        });
        main.connections.push({
          id: `wire-${main.connections.length}`,
          sourceComponentId: `full-adder-${index}`,
          sourcePortId: port,
          targetComponentId: probeId,
          targetPortId: "in",
        });
      }
    }
    const runtimeProject = migrateV2ToV3(project);

    // Exclude one-time browser WebAssembly JIT from the steady-state compile budget.
    for (let warmupIndex = 0; warmupIndex < 2; warmupIndex += 1) {
      const warmup = new wasm.WasmProjectSimulator();
      warmup.loadProject(runtimeProject, "main");
      warmup.free();
    }
    const compileSamples: number[] = [];
    let simulator = new wasm.WasmProjectSimulator();
    let compiled = simulator.loadProject(runtimeProject, "main");
    simulator.free();
    for (let sampleIndex = 0; sampleIndex < 3; sampleIndex += 1) {
      simulator = new wasm.WasmProjectSimulator();
      const compileStart = performance.now();
      compiled = simulator.loadProject(runtimeProject, "main");
      compileSamples.push(performance.now() - compileStart);
      if (sampleIndex < 2) simulator.free();
    }
    const compileMs = [...compileSamples].sort((left, right) => left - right)[1];
    const metrics = simulator.metrics();
    const compileCountBeforeInputs = compiled.compileCount;
    const propagateStart = performance.now();
    const propagated = simulator.setSource("main", "shared-a", "1");
    const propagateMs = performance.now() - propagateStart;
    simulator.free();

    return {
      fullAdderInstances: main.components.filter(
        (component) => component.typeId === "project.module_instance",
      ).length,
      ...metrics,
      compileMs,
      compileSamples,
      propagateMs,
      compileCountBeforeInputs,
      compileCountAfterInputs: propagated.compileCount,
      stable: propagated.stable,
      before: [
        compiled.componentOutputs["full-adder-0"],
        compiled.componentOutputs["full-adder-99"],
      ],
      after: [
        propagated.componentOutputs["full-adder-0"],
        propagated.componentOutputs["full-adder-99"],
      ],
    };
  });

  const thresholdMs = process.env.CI ? 150 : 100;
  console.info({ ...result, localTargetMs: 100, ciThresholdMs: 150 });
  expect(result.fullAdderInstances).toBe(100);
  expect(result.expandedComponents).toBe(507);
  expect(result.expandedConnections).toBe(1004);
  expect(result.projectionEndpoints).toBe(3811);
  expect(result.stable).toBe(true);
  expect(result.before).toEqual([
    { carry: "0", sum: "0" },
    { carry: "0", sum: "0" },
  ]);
  expect(result.after).toEqual([
    { carry: "0", sum: "1" },
    { carry: "0", sum: "1" },
  ]);
  expect(result.compileMs).toBeLessThan(thresholdMs);
  expect(result.propagateMs).toBeLessThan(thresholdMs);
  expect(result.compileCountAfterInputs).toBe(result.compileCountBeforeInputs);
});
