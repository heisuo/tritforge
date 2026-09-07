import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSimulationSnapshot } from "../src/editor-model";
import type {
  TraceFrame,
  WasmProjectSimulatorBinding,
} from "../src/wasm-client";

const runtimeMock = vi.hoisted(() => {
  const snapshot = (): ProjectSimulationSnapshot => ({
    componentOutputs: {},
    inputNets: {},
    componentOutputWords: {},
    inputNetWords: {},
    diagnostics: [],
    stable: true,
    tickCount: 0,
    compileCount: 1,
    clockPhase: "lowStable",
  });
  const projectSimulator = {
    loadProject: vi.fn((_project?: unknown, _active?: string) => snapshot()),
    updateProject: vi.fn((_project?: unknown) => snapshot()),
    switchActive: vi.fn((_active?: string) => snapshot()),
    setSource: vi.fn(
      (_circuit?: string, _component?: string, _value?: string) => snapshot(),
    ),
    tick: vi.fn(snapshot),
    advancePhase: vi.fn(snapshot),
    reset: vi.fn(snapshot),
    setTraceWatches: vi.fn(() => ({
      cycle: 0,
      clockPhase: "lowStable" as const,
      reason: "load" as const,
      values: [],
      diagnostics: [],
    })),
    traceFrames: vi.fn((): TraceFrame[] => []),
    traceWatches: vi.fn(() => []),
    traceDiagnostics: vi.fn(() => []),
    clearTrace: vi.fn(),
    snapshot: vi.fn(snapshot),
    metrics: vi.fn(() => ({
      expandedComponents: 0,
      expandedConnections: 0,
      projectionEndpoints: 0,
    })),
  } satisfies WasmProjectSimulatorBinding;
  const dependencyCycleError = () => ({
    code: "MODULE_DEPENDENCY_CYCLE",
    message: "project operation failed",
    diagnostics: [
      {
        code: "MODULE_DEPENDENCY_CYCLE",
        severity: "error",
        message: "module dependency cycle: loop -> loop",
        primaryLocation: null,
        componentRefs: [],
        connectionRefs: [],
        portRefs: [],
      },
    ],
  });
  const resolveProjectModulePorts = vi.fn(
    (_project: unknown, moduleId: string) => {
      if (moduleId === "loop") {
        throw dependencyCycleError();
      }
      return [];
    },
  );
  const resolveProjectModuleInterfaces = vi.fn((project: unknown) => {
    const circuits = (
      project as {
        circuits: Array<{ id: string; kind: "main" | "module" }>;
      }
    ).circuits;
    if (circuits.some((circuit) => circuit.id === "loop")) {
      throw dependencyCycleError();
    }
    return Object.fromEntries(
      circuits
        .filter((circuit) => circuit.kind === "module")
        .map((circuit) => [circuit.id, []]),
    );
  });
  return {
    makeSnapshot: snapshot,
    dependencyCycleError,
    resolveProjectModuleInterfaces,
    resolveProjectModulePorts,
    ...projectSimulator,
  };
});

vi.mock("../src/wasm-client", () => ({
  createWasmRuntime: vi.fn(async () => ({
    apiVersion: 3,
    resolveProjectPorts: (
      typeId: string,
      properties: Record<string, unknown>,
    ) => {
      const width = typeof properties.width === "number" ? properties.width : 1;
      if (typeId === "gate.neg") {
        return [
          { id: "a", direction: "input", width: 1 },
          { id: "y", direction: "output", width: 1 },
        ];
      }
      if (typeId === "sink.probe" || typeId === "project.module_output") {
        return [{ id: "in", direction: "input", width }];
      }
      if (typeId === "wiring.junction" || typeId === "wiring.tunnel") {
        return [{ id: "net", direction: "inout", width }];
      }
      if (typeId === "wiring.splitter") {
        const branchCount = Number(properties.branchCount);
        const mapping = properties.mapping;
        if (
          !Number.isInteger(branchCount) ||
          branchCount < 1 ||
          branchCount > width ||
          !Array.isArray(mapping) ||
          mapping.length !== width ||
          mapping.some(
            (branch) =>
              !Number.isInteger(branch) ||
              Number(branch) < 0 ||
              Number(branch) >= branchCount,
          )
        ) {
          throw Object.assign(new Error("invalid splitter mapping"), {
            code: "INVALID_SPLITTER_MAP",
          });
        }
        const branchWidths = Array.from({ length: branchCount }, () => 0);
        mapping.forEach((branch) => {
          branchWidths[Number(branch)] += 1;
        });
        if (branchWidths.some((branchWidth) => branchWidth === 0)) {
          throw Object.assign(new Error("empty splitter branch"), {
            code: "INVALID_SPLITTER_MAP",
          });
        }
        return [
          { id: "trunk", direction: "inout", width },
          ...branchWidths.map((branchWidth, index) => ({
            id: `branch${index}`,
            direction: "inout" as const,
            width: branchWidth,
          })),
        ];
      }
      return [{ id: "out", direction: "output", width }];
    },
    resolveProjectModulePorts: runtimeMock.resolveProjectModulePorts,
    resolveProjectModuleInterfaces: runtimeMock.resolveProjectModuleInterfaces,
    catalog: [
      {
        type_id: "source.trit_input",
        display_name: "Trit Input",
        category: "source",
        kind: "source",
        ports: [{ id: "out", direction: "output", width: 1 }],
        truth_table: [],
      },
      {
        type_id: "gate.neg",
        display_name: "NEG",
        category: "gate",
        kind: "gate",
        ports: [
          { id: "a", direction: "input", width: 1 },
          { id: "y", direction: "output", width: 1 },
        ],
        truth_table: [],
      },
      {
        type_id: "sink.probe",
        display_name: "Probe",
        category: "sink",
        kind: "sink",
        ports: [{ id: "in", direction: "input", width: 1 }],
        truth_table: [],
      },
    ],
    simulator: {},
    projectSimulator: runtimeMock,
  })),
  wasmErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  wasmProjectError: (error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error) {
      return {
        name: "SimulationError",
        code: String(error.code),
        message:
          "message" in error
            ? String(error.message)
            : "Project simulation failed",
        diagnostics:
          "diagnostics" in error && Array.isArray(error.diagnostics)
            ? error.diagnostics
            : [],
      };
    }
    return {
      name: "SimulationError",
      code: "TEST_ERROR",
      message: error instanceof Error ? error.message : String(error),
      diagnostics: [],
    };
  },
}));

import { App } from "../src/App";

function referencedProject() {
  return {
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
            id: "identity-1",
            typeId: "project.module_instance",
            position: { x: 200, y: 100 },
            properties: { moduleId: "identity", label: "Identity 1" },
          },
        ],
        connections: [],
      },
      {
        id: "identity",
        name: "Identity",
        kind: "module",
        components: [
          {
            id: "input",
            typeId: "project.module_input",
            position: { x: 0, y: 100 },
            properties: { portId: "a", label: "A", previewValue: "0" },
          },
          {
            id: "output",
            typeId: "project.module_output",
            position: { x: 300, y: 100 },
            properties: { portId: "y", label: "Y" },
          },
        ],
        connections: [
          {
            id: "wire-1",
            sourceComponentId: "input",
            sourcePortId: "out",
            targetComponentId: "output",
            targetPortId: "in",
          },
        ],
      },
    ],
  };
}

function nestedReferencedProject() {
  const project = referencedProject();
  project.circuits[0].components = [
    {
      id: "wrapper-1",
      typeId: "project.module_instance",
      position: { x: 200, y: 100 },
      properties: { moduleId: "wrapper", label: "Wrapper 1" },
    },
  ];
  project.circuits.push({
    id: "wrapper",
    name: "Wrapper",
    kind: "module",
    components: [
      {
        id: "identity-1",
        typeId: "project.module_instance",
        position: { x: 200, y: 100 },
        properties: { moduleId: "identity", label: "Identity 1" },
      },
    ],
    connections: [],
  });
  return project;
}

function recursiveProject() {
  return {
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
}

function reversedEndpointProject(width = 1) {
  const sourceValue = width === 3 ? "1T0" : "1";
  const circuit = (id: string, kind: "main" | "module") => ({
    id,
    name: kind === "main" ? "Main" : "Reversed Module",
    kind,
    components: [
      {
        id: "z-source",
        typeId: "source.trit_input",
        position: { x: 80, y: 100 },
        properties: { width, value: sourceValue, label: "Word Source" },
      },
      {
        id: "a-probe",
        typeId: "sink.probe",
        position: { x: 500, y: 100 },
        properties: { width, label: "Word Probe" },
      },
    ],
    wires: [
      {
        id: `wire-${id}`,
        endpointA: { componentId: "z-source", portId: "out" },
        endpointB: { componentId: "a-probe", portId: "in" },
      },
    ],
  });
  return {
    format: "logsim-ternary",
    version: 3,
    rootCircuitId: "main",
    circuits: [
      {
        ...circuit("main", "main"),
        components: [
          ...circuit("main", "main").components,
          {
            id: "module-1",
            typeId: "project.module_instance",
            position: { x: 300, y: 300 },
            properties: { moduleId: "reversed", label: "Reversed Module" },
          },
        ],
      },
      circuit("reversed", "module"),
    ],
  };
}

function sameDirectionProject() {
  return {
    format: "logsim-ternary",
    version: 3,
    rootCircuitId: "main",
    circuits: [
      {
        id: "main",
        name: "Main",
        kind: "main",
        components: [
          {
            id: "a-probe",
            typeId: "sink.probe",
            position: { x: 400, y: 80 },
            properties: {},
          },
          {
            id: "b-probe",
            typeId: "sink.probe",
            position: { x: 400, y: 220 },
            properties: {},
          },
          {
            id: "y-source",
            typeId: "source.trit_input",
            position: { x: 80, y: 80 },
            properties: { value: "0" },
          },
          {
            id: "z-source",
            typeId: "source.trit_input",
            position: { x: 80, y: 220 },
            properties: { value: "1" },
          },
        ],
        wires: [
          {
            id: "input-input",
            endpointA: { componentId: "b-probe", portId: "in" },
            endpointB: { componentId: "a-probe", portId: "in" },
          },
          {
            id: "output-output",
            endpointA: { componentId: "z-source", portId: "out" },
            endpointB: { componentId: "y-source", portId: "out" },
          },
        ],
      },
    ],
  };
}

async function importProject(project: object, filename = "project.json") {
  const input = screen.getByLabelText("选择三进制工程文件");
  const file = new File([JSON.stringify(project)], filename, {
    type: "application/json",
  });
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByText(`已导入工程: ${filename}`);
}

describe("App", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens directly into the editor shell", () => {
    render(<App />);
    expect(
      screen.getByRole("main", { name: "TritForge 编辑器" }),
    ).toBeInTheDocument();
  });

  it("creates and enters a module, then adds fixed boundary handles", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("Demo Module");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "新建模块" }));

    expect(
      screen.getByRole("navigation", { name: "层级导航" }),
    ).toHaveTextContent("Demo Module");
    fireEvent.click(screen.getByRole("button", { name: "添加模块输入" }));
    fireEvent.click(screen.getByRole("button", { name: "添加模块输出" }));
    expect(
      await screen.findByTestId("handle-module-input-1-output-out"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("handle-module-output-1-input-in"),
    ).toBeInTheDocument();
  });

  it("offers place/edit tools, enters instances on double click, and returns by breadcrumb", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("Reusable");
    const { container } = render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "新建模块" }));
    fireEvent.click(screen.getByRole("button", { name: "返回上级" }));

    const place = screen.getByRole("button", { name: "放置 Reusable" });
    const edit = screen.getByRole("button", { name: "编辑 Reusable" });
    expect(place).toHaveAttribute("title", "放置模块实例");
    expect(edit).toHaveAttribute("title", "编辑模块定义");
    fireEvent.click(place);
    const instanceNode = container.querySelector(
      '.react-flow__node[data-id="reusable-1"]',
    );
    expect(instanceNode).not.toBeNull();

    fireEvent.doubleClick(instanceNode!);
    expect(
      screen.getByRole("navigation", { name: "层级导航" }),
    ).toHaveTextContent("Reusable");
    fireEvent.click(screen.getByRole("button", { name: "返回上级" }));
    expect(
      screen.getByRole("navigation", { name: "层级导航" }),
    ).toHaveTextContent("Main");
  });

  it("keeps UI and runtime inside a module when importing the exact same project", async () => {
    render(<App />);
    const base = referencedProject();
    const project = {
      ...base,
      circuits: base.circuits.map((circuit) => ({
        ...circuit,
        viewport: { x: 0, y: 0, zoom: 1 },
      })),
    };
    await importProject(project, "same-project-1.json");
    fireEvent.click(screen.getByRole("button", { name: "编辑 Identity" }));
    await waitFor(() =>
      expect(
        screen.getByRole("navigation", { name: "层级导航" }),
      ).toHaveTextContent("Identity"),
    );
    const loadsBefore = runtimeMock.loadProject.mock.calls.length;
    const switchesBefore = runtimeMock.switchActive.mock.calls.length;

    await importProject(project, "same-project-2.json");

    expect(
      screen.getByRole("navigation", { name: "层级导航" }),
    ).toHaveTextContent("Identity");
    expect(runtimeMock.loadProject).toHaveBeenCalledTimes(loadsBefore);
    expect(runtimeMock.switchActive).toHaveBeenCalledTimes(switchesBefore);
  });

  it("reports connected-port and referenced-module deletion locations", async () => {
    const { container } = render(<App />);
    await importProject(referencedProject());

    fireEvent.click(screen.getByRole("button", { name: "编辑 Identity" }));
    const inputNode = container.querySelector(
      '.react-flow__node[data-id="input"]',
    );
    fireEvent.click(inputNode!);
    fireEvent.click(screen.getByRole("button", { name: "删除所选" }));
    expect(await screen.findByText(/identity\/wire-1/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "返回上级" }));
    fireEvent.click(screen.getByRole("button", { name: "删除 Identity" }));
    expect(
      await screen.findByText(/1 个引用.*main\/identity-1/),
    ).toBeInTheDocument();
  });

  it("keeps module controls inside the mobile palette drawer", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    render(<App />);
    const palette = document.getElementById("component-palette")!;
    const toggle = screen.getByRole("button", { name: "切换元件库" });

    expect(palette).toHaveTextContent("新建模块");
    await waitFor(() => expect(palette).toHaveAttribute("inert"));
    expect(toggle).toHaveAttribute("aria-controls", "component-palette");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(palette).toHaveClass("is-open");
      expect(palette).not.toHaveAttribute("inert");
      expect(toggle).toHaveAttribute("aria-expanded", "true");
    });
  });

  it("enters a selected module instance with Enter", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("Keyboard Module");
    const { container } = render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "新建模块" }));
    fireEvent.click(screen.getByRole("button", { name: "返回上级" }));
    fireEvent.click(
      screen.getByRole("button", { name: "放置 Keyboard Module" }),
    );
    const instance = container.querySelector(
      '.react-flow__node[data-id="keyboard-module-1"]',
    );
    fireEvent.click(instance!);
    fireEvent.keyDown(screen.getByRole("application"), { key: "Enter" });

    await waitFor(() =>
      expect(
        screen.getByRole("navigation", { name: "层级导航" }),
      ).toHaveTextContent("Keyboard Module"),
    );
  });

  it("disables module placements that would create a recursive hierarchy", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("Recursive");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "新建模块" }));

    expect(
      screen.getByRole("button", { name: "放置 Recursive" }),
    ).toBeDisabled();
  });

  it("renames modules without changing their stable identity", async () => {
    vi.spyOn(window, "prompt")
      .mockReturnValueOnce("Reusable")
      .mockReturnValueOnce("Renamed Module");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "新建模块" }));
    fireEvent.click(screen.getByRole("button", { name: "返回上级" }));
    fireEvent.click(screen.getByRole("button", { name: "重命名 Reusable" }));

    expect(
      screen.getByRole("button", { name: "编辑 Renamed Module" }),
    ).toBeInTheDocument();
  });

  it("reloads the runtime at main when deleting the active module", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("Disposable");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "新建模块" }));
    fireEvent.click(screen.getByRole("button", { name: "删除 Disposable" }));

    await waitFor(() => {
      expect(
        screen.getByRole("navigation", { name: "层级导航" }),
      ).toHaveTextContent("Main");
      expect(runtimeMock.loadProject).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps the previous circuit visible when runtime navigation fails", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("Blocked");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "新建模块" }));
    fireEvent.click(screen.getByRole("button", { name: "返回上级" }));
    runtimeMock.switchActive.mockImplementationOnce(() => {
      throw new Error("navigation blocked");
    });

    fireEvent.click(screen.getByRole("button", { name: "编辑 Blocked" }));
    expect(await screen.findByText(/navigation blocked/)).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "层级导航" }),
    ).not.toHaveTextContent("Blocked");
  });

  it("keeps the Workbench and last valid catalog when project-aware port resolution fails", async () => {
    render(<App />);
    await importProject(referencedProject());
    expect(screen.getByText("7 COMPONENTS")).toBeInTheDocument();
    expect(screen.getByText("1 COMPILES")).toBeInTheDocument();
    runtimeMock.resolveProjectModuleInterfaces.mockClear();
    runtimeMock.resolveProjectModulePorts.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "编辑 Identity" }));
    await waitFor(() => {
      expect(
        screen.getByRole("navigation", { name: "层级导航" }),
      ).toHaveTextContent("Identity");
    });
    fireEvent.click(screen.getByRole("button", { name: "返回上级" }));
    expect(runtimeMock.resolveProjectModuleInterfaces).not.toHaveBeenCalled();

    const input = screen.getByLabelText("选择三进制工程文件");
    runtimeMock.loadProject.mockImplementationOnce(() => {
      throw runtimeMock.dependencyCycleError();
    });
    const file = new File(
      [JSON.stringify(recursiveProject())],
      "recursive.json",
      {
        type: "application/json",
      },
    );
    fireEvent.change(input, { target: { files: [file] } });

    expect(
      await screen.findByText(/工程加载失败: project operation failed/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /MODULE_DEPENDENCY_CYCLE\s*module dependency cycle: loop -> loop/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("main", { name: "TritForge 编辑器" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("application")).toBeInTheDocument();
    expect(screen.getByText("7 COMPONENTS")).toBeInTheDocument();
    expect(screen.getByText("1 COMPILES")).toBeInTheDocument();
    expect(runtimeMock.resolveProjectModuleInterfaces).not.toHaveBeenCalled();
    expect(runtimeMock.resolveProjectModulePorts).not.toHaveBeenCalled();
  });

  it("does not commit an input when the runtime transaction rejects its update", async () => {
    runtimeMock.updateProject.mockImplementationOnce(() => {
      throw new Error("source blocked");
    });
    const { container } = render(<App />);
    await screen.findByText(/层级模拟器已就绪/);
    const input = await waitFor(() => {
      const node = container.querySelector(
        '.react-flow__node[data-id="input-1"]',
      );
      expect(node).not.toBeNull();
      return node!;
    });
    fireEvent.click(input);

    expect(await screen.findByText(/source blocked/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();
  });

  it("orients normalized wires from resolved output to input across import, navigation, and undo", async () => {
    const signalSnapshot = (active?: string): ProjectSimulationSnapshot => ({
      ...runtimeMock.makeSnapshot(),
      componentOutputs: { "z-source": { out: "1" } },
      inputNets: { "a-probe": { in: "T" } },
      componentOutputWords: { "z-source": { out: "1" } },
      inputNetWords: { "a-probe": { in: "T" } },
      tickCount: active === "reversed" ? 2 : 1,
    });
    runtimeMock.loadProject.mockImplementation(
      (_project?: unknown, active?: string) => signalSnapshot(active),
    );
    runtimeMock.switchActive.mockImplementation((active?: string) =>
      signalSnapshot(active),
    );
    runtimeMock.updateProject.mockImplementation(() =>
      signalSnapshot("reversed"),
    );
    const { container } = render(<App />);
    await importProject(reversedEndpointProject());

    const assertWire = (id: string) => {
      const state = JSON.parse(
        screen
          .getByRole("region", { name: "电路画布" })
          .getAttribute("data-wire-state") ?? "[]",
      ) as Array<Record<string, string>>;
      expect(state.find((wire) => wire.id === id)).toEqual({
        id,
        source: "z-source",
        sourcePort: "out",
        target: "a-probe",
        targetPort: "in",
        signal: "T",
        width: 1,
      });
    };
    await waitFor(() => assertWire("wire-main"));

    fireEvent.click(
      screen.getByRole("button", { name: "编辑 Reversed Module" }),
    );
    await waitFor(() => assertWire("wire-reversed"));
    runtimeMock.updateProject.mockClear();
    fireEvent.click(
      container.querySelector('.react-flow__node[data-id="z-source"]')!,
    );
    await waitFor(() =>
      expect(runtimeMock.updateProject).toHaveBeenCalledTimes(1),
    );
    await screen.findByText(/输入 z-source:/);
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() => assertWire("wire-reversed"));
  });

  it("renders imported same-direction wires with both handle roles on one port row", async () => {
    const { container } = render(<App />);
    await importProject(sameDirectionProject());

    expect(screen.getByTestId("handle-a-probe-input-in")).toBeInTheDocument();
    expect(screen.getByTestId("handle-a-probe-output-in")).toBeInTheDocument();
    expect(
      screen.getByTestId("handle-y-source-output-out"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("handle-y-source-input-out")).toBeInTheDocument();
    expect(
      container.querySelectorAll(
        '.react-flow__node[data-id="a-probe"] .port-row',
      ),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll(
        '.react-flow__node[data-id="y-source"] .port-row',
      ),
    ).toHaveLength(1);
    const wires = JSON.parse(
      screen
        .getByRole("region", { name: "电路画布" })
        .getAttribute("data-wire-state") ?? "[]",
    ) as Array<Record<string, string>>;
    expect(wires).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "input-input",
          source: "a-probe",
          sourcePort: "in",
          target: "b-probe",
          targetPort: "in",
        }),
        expect.objectContaining({
          id: "output-output",
          source: "y-source",
          sourcePort: "out",
          target: "z-source",
          targetPort: "out",
        }),
      ]),
    );
  });

  it("clears local node and wire selection when clearing the circuit", async () => {
    const { container } = render(<App />);
    await screen.findByText(/层级模拟器已就绪/);
    fireEvent.click(
      container.querySelector('.react-flow__node[data-id="input-1"]')!,
    );
    expect(screen.getByRole("button", { name: "删除所选" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "清空" }));

    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "删除所选" })).toBeDisabled();
  });

  it("keeps width-3 source words valid when clicking the scalar-compatible source UI", async () => {
    const { container } = render(<App />);
    await importProject(reversedEndpointProject(3));
    runtimeMock.updateProject.mockClear();

    fireEvent.click(
      container.querySelector('.react-flow__node[data-id="z-source"]')!,
    );

    await waitFor(() =>
      expect(runtimeMock.updateProject).toHaveBeenCalledTimes(1),
    );
    const candidate = runtimeMock.updateProject.mock.calls[0][0] as {
      circuits: Array<{
        components: Array<{ id: string; properties: { value?: string } }>;
      }>;
    };
    expect(
      candidate.circuits[0].components.find((item) => item.id === "z-source")
        ?.properties.value,
    ).toBe("T01");
    expect(runtimeMock.setSource).not.toHaveBeenCalled();
  });

  it("cancels the delayed cycle when a width property commit wins the click race", async () => {
    const { container } = render(<App />);
    await screen.findByText(/层级模拟器已就绪/);
    fireEvent.click(screen.getByRole("button", { name: "添加Trit Input" }));
    runtimeMock.updateProject.mockClear();
    vi.useFakeTimers();

    fireEvent.click(
      container.querySelector('.react-flow__node[data-id="trit-input-1"]')!,
      { detail: 1 },
    );
    fireEvent.click(screen.getByRole("button", { name: "宽度 3 trit" }));
    fireEvent.change(screen.getByLabelText("源字值"), {
      target: { value: "1T0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用属性" }));
    expect(runtimeMock.updateProject).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(220);
    });

    expect(runtimeMock.updateProject).toHaveBeenCalledTimes(1);
    const candidate = runtimeMock.updateProject.mock.calls[0][0] as {
      circuits: Array<{
        components: Array<{
          id: string;
          properties: { width?: number; value?: string };
        }>;
      }>;
    };
    expect(
      candidate.circuits[0].components.find(
        (item) => item.id === "trit-input-1",
      )?.properties,
    ).toMatchObject({ width: 3, value: "1T0" });
    expect(screen.queryByText(/输入更新失败/)).not.toBeInTheDocument();
  });

  it("keeps source double-click rename while canceling its pending single-click cycle", async () => {
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("Renamed Input");
    const { container } = render(<App />);
    await screen.findByText(/层级模拟器已就绪/);
    fireEvent.click(screen.getByRole("button", { name: "添加Trit Input" }));
    runtimeMock.updateProject.mockClear();
    vi.useFakeTimers();
    const source = container.querySelector(
      '.react-flow__node[data-id="trit-input-1"]',
    )!;

    fireEvent.click(source, { detail: 1 });
    fireEvent.doubleClick(source, { detail: 2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(220);
    });

    expect(prompt).toHaveBeenCalledWith("修改模块名称", "Trit Input");
    expect(runtimeMock.updateProject).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector(
        '.react-flow__node[data-id="trit-input-1"] .node-heading span',
      ),
    ).toHaveTextContent("Renamed Input");
    expect(
      screen.getByRole("heading", { name: "Renamed Input" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^输入 trit-input-1:/)).not.toBeInTheDocument();
  });

  it("keeps structural edits atomic when runtime rejects and transacts source undo and redo once", async () => {
    const { container } = render(<App />);
    await screen.findByText(/层级模拟器已就绪/);
    runtimeMock.updateProject.mockClear();
    runtimeMock.updateProject.mockImplementationOnce(() => {
      throw new Error("structure blocked");
    });

    fireEvent.click(screen.getByRole("button", { name: /NEG/ }));
    expect(await screen.findByText(/structure blocked/)).toBeInTheDocument();
    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();

    runtimeMock.updateProject.mockImplementation((_project?: unknown) =>
      runtimeMock.makeSnapshot(),
    );
    runtimeMock.updateProject.mockClear();
    fireEvent.click(
      container.querySelector('.react-flow__node[data-id="input-1"]')!,
    );
    await waitFor(() =>
      expect(runtimeMock.updateProject).toHaveBeenCalledTimes(1),
    );
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() =>
      expect(runtimeMock.updateProject).toHaveBeenCalledTimes(2),
    );
    fireEvent.click(screen.getByRole("button", { name: "重做" }));
    await waitFor(() =>
      expect(runtimeMock.updateProject).toHaveBeenCalledTimes(3),
    );
    expect(runtimeMock.setSource).not.toHaveBeenCalled();
  });

  it("offers wiring helpers and renders Rust-resolved splitter ports", async () => {
    const { container } = render(<App />);
    await screen.findByText(/层级模拟器已就绪/);

    expect(
      screen.getByRole("button", { name: /添加连接点/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /添加隧道/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /添加分线器/ }));

    expect(
      await screen.findByTestId("handle-splitter-1-output-trunk"),
    ).toHaveAttribute("aria-label", "trunk，双向，3 trit");
    expect(
      screen.getByTestId("handle-splitter-1-output-trunk"),
    ).toHaveAttribute("title", "trunk，双向，3 trit");
    expect(
      screen.getByTestId("handle-splitter-1-output-branch0"),
    ).toHaveAttribute("aria-label", "branch0，双向，1 trit");
    expect(
      screen.getByTestId("handle-splitter-1-output-branch2"),
    ).toBeInTheDocument();
    expect(
      container.querySelector('.react-flow__node[data-id="splitter-1"]'),
    ).toHaveClass("wiring-node-shell");
  });

  it("assigns sequential local names to newly placed tunnels", async () => {
    const { container } = render(<App />);
    await screen.findByText(/层级模拟器已就绪/);

    fireEvent.click(screen.getByRole("button", { name: /添加隧道/ }));
    fireEvent.click(screen.getByRole("button", { name: /添加隧道/ }));
    fireEvent.click(screen.getByRole("button", { name: /添加隧道/ }));

    expect(
      Array.from(container.querySelectorAll(".wiring-tunnel strong")).map(
        (element) => element.textContent,
      ),
    ).toEqual(["tunnel0", "tunnel1", "tunnel2"]);
  });

  it("edits a selected width-aware source atomically and displays word widths", async () => {
    render(<App />);
    await screen.findByText(/层级模拟器已就绪/);
    fireEvent.click(screen.getByRole("button", { name: "添加Trit Input" }));

    fireEvent.click(screen.getByRole("button", { name: "宽度 3 trit" }));
    fireEvent.change(screen.getByLabelText("源字值"), {
      target: { value: "1T0" },
    });
    runtimeMock.updateProject.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "应用属性" }));

    await waitFor(() =>
      expect(runtimeMock.updateProject).toHaveBeenCalledTimes(1),
    );
    expect((await screen.findAllByText("3t")).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("源字值")).toHaveValue("1T0");
  });

  it("renders six-state words and semantic bus metadata without scalar IDs", async () => {
    runtimeMock.loadProject.mockImplementation(() => ({
      ...runtimeMock.makeSnapshot(),
      componentOutputWords: { "z-source": { out: "1XZ" } },
      inputNetWords: { "a-probe": { in: "1XE" } },
    }));
    const { container } = render(<App />);
    await importProject(reversedEndpointProject(3), "six-state-word.json");

    expect(
      container.querySelector(
        '.react-flow__node[data-id="a-probe"] .node-signal',
      ),
    ).toHaveTextContent("1XE");
    const wires = JSON.parse(
      screen
        .getByRole("region", { name: "电路画布" })
        .getAttribute("data-wire-state") ?? "[]",
    ) as Array<Record<string, unknown>>;
    expect(wires.find((wire) => wire.id === "wire-main")).toMatchObject({
      signal: "1XE",
      width: 3,
    });
    expect(JSON.stringify(wires)).not.toContain("scalar");
  });

  it("switches multi-trit canvas nodes and wire labels to decimal display", async () => {
    runtimeMock.loadProject.mockImplementation(() => ({
      ...runtimeMock.makeSnapshot(),
      componentOutputWords: { "z-source": { out: "1T0" } },
      inputNetWords: { "a-probe": { in: "1T0" } },
    }));
    const { container } = render(<App />);
    await importProject(reversedEndpointProject(3), "decimal-canvas.json");

    const probe = container.querySelector(
      '.react-flow__node[data-id="a-probe"] .node-signal',
    );
    expect(probe).toHaveTextContent("1T0");
    fireEvent.change(screen.getByLabelText("画布显示模式"), {
      target: { value: "decimal" },
    });

    expect(probe).toHaveTextContent("6");
    const canvas = screen.getByRole("region", { name: "电路画布" });
    expect(canvas).toHaveAttribute("data-display-mode", "decimal");
  });

  it("follows qualified diagnostic instance paths", async () => {
    runtimeMock.loadProject.mockImplementation((project?: unknown) => {
      const result = runtimeMock.makeSnapshot();
      const circuitCount =
        typeof project === "object" &&
        project !== null &&
        "circuits" in project &&
        Array.isArray(project.circuits)
          ? project.circuits.length
          : 0;
      return circuitCount === 3
        ? {
            ...result,
            diagnostics: [
              {
                code: "QUALIFIED_TEST",
                severity: "error",
                message: "nested fault",
                primaryLocation: {
                  kind: "component",
                  ref: {
                    circuitId: "identity",
                    instancePath: ["wrapper-1", "identity-1"],
                    componentId: "input",
                  },
                },
                componentRefs: [],
                connectionRefs: [],
                portRefs: [],
              },
            ],
          }
        : result;
    });
    render(<App />);
    await importProject(nestedReferencedProject());
    fireEvent.click(
      await screen.findByRole("button", { name: /QUALIFIED_TEST/ }),
    );

    await waitFor(() => {
      const navigation = screen.getByRole("navigation", { name: "层级导航" });
      expect(navigation).toHaveTextContent("Wrapper");
      expect(navigation).toHaveTextContent("Identity");
    });
  });

  it("pauses automatic execution while retaining the runtime fault frame", async () => {
    const faultDiagnostic = {
      code: "NON_CONVERGENT",
      severity: "error" as const,
      message: "simulation did not converge",
      primaryLocation: null,
      componentRefs: [],
      connectionRefs: [],
      portRefs: [],
    };
    runtimeMock.advancePhase.mockImplementationOnce(() => {
      throw {
        code: "NON_CONVERGENT",
        message: "simulation did not converge",
        diagnostics: [faultDiagnostic],
      };
    });
    runtimeMock.traceFrames.mockImplementation(() =>
      runtimeMock.advancePhase.mock.calls.length > 0
        ? [
            {
              cycle: 0,
              clockPhase: "highStable" as const,
              reason: "fault" as const,
              values: [],
              diagnostics: [faultDiagnostic],
            },
          ]
        : [],
    );

    render(<App />);
    await screen.findByText(/层级模拟器已就绪/);
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText("自动时钟速度"), {
      target: { value: "20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "运行自动时钟" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });

    expect(runtimeMock.advancePhase).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "运行自动时钟" })).toBeVisible();
    expect(
      screen.getByText(/自动时钟已暂停: simulation did not converge/),
    ).toBeInTheDocument();
    expect(screen.getByTestId("chronogram-viewport")).toHaveAttribute(
      "data-frame-count",
      "1",
    );
  });
});
