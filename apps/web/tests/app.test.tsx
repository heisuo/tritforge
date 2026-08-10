import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSimulationSnapshot } from "../src/editor-model";
import type { WasmProjectSimulatorBinding } from "../src/wasm-client";

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
  });
  const projectSimulator = {
    loadProject: vi.fn((_project?: unknown, _active?: string) => snapshot()),
    updateProject: vi.fn((_project?: unknown) => snapshot()),
    switchActive: vi.fn((_active?: string) => snapshot()),
    setSource: vi.fn(
      (_circuit?: string, _component?: string, _value?: string) => snapshot(),
    ),
    tick: vi.fn(snapshot),
    snapshot: vi.fn(snapshot),
    metrics: vi.fn(() => ({
      expandedComponents: 0,
      expandedConnections: 0,
      projectionEndpoints: 0,
    })),
  } satisfies WasmProjectSimulatorBinding;
  return {
    makeSnapshot: snapshot,
    ...projectSimulator,
  };
});

vi.mock("../src/wasm-client", () => ({
  createWasmRuntime: vi.fn(async () => ({
    apiVersion: 3,
    resolveProjectPorts: (typeId: string, properties: Record<string, unknown>) => [
      {
        id: typeId === "project.module_output" ? "in" : "out",
        direction: typeId === "project.module_output" ? "input" : "output",
        width: typeof properties.width === "number" ? properties.width : 1,
      },
    ],
    catalog: [
      {
        type_id: "source.trit_input",
        display_name: "Trit Input",
        category: "source",
        kind: "source",
        ports: [{ id: "out", direction: "output" }],
        truth_table: [],
      },
      {
        type_id: "gate.neg",
        display_name: "NEG",
        category: "gate",
        kind: "gate",
        ports: [
          { id: "a", direction: "input" },
          { id: "y", direction: "output" },
        ],
        truth_table: [],
      },
      {
        type_id: "sink.probe",
        display_name: "Probe",
        category: "sink",
        kind: "sink",
        ports: [{ id: "in", direction: "input" }],
        truth_table: [],
      },
    ],
    simulator: {},
    projectSimulator: runtimeMock,
  })),
  wasmErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  wasmProjectError: (error: unknown) => ({
    name: "SimulationError",
    code: "TEST_ERROR",
    message: error instanceof Error ? error.message : String(error),
    diagnostics: [],
  }),
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

async function importProject(project: object) {
  const input = screen.getByLabelText("选择三进制工程文件");
  const file = new File([JSON.stringify(project)], "project.json", {
    type: "application/json",
  });
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByText(/已导入工程/);
}

describe("App", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens directly into the editor shell", () => {
    render(<App />);
    expect(screen.getByRole("main", { name: "Logsim Ternary 编辑器" }))
      .toBeInTheDocument();
  });

  it("creates and enters a module, then adds fixed boundary handles", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("Demo Module");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "新建模块" }));

    expect(screen.getByRole("navigation", { name: "层级导航" })).toHaveTextContent(
      "Demo Module",
    );
    fireEvent.click(screen.getByRole("button", { name: "添加模块输入" }));
    fireEvent.click(screen.getByRole("button", { name: "添加模块输出" }));
    expect(await screen.findByTestId("handle-module-input-1-output-out"))
      .toBeInTheDocument();
    expect(screen.getByTestId("handle-module-output-1-input-in"))
      .toBeInTheDocument();
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
    expect(screen.getByRole("navigation", { name: "层级导航" })).toHaveTextContent(
      "Reusable",
    );
    fireEvent.click(screen.getByRole("button", { name: "返回上级" }));
    expect(screen.getByRole("navigation", { name: "层级导航" })).toHaveTextContent(
      "Main",
    );
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
    expect(await screen.findByText(/1 个引用.*main\/identity-1/)).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "放置 Keyboard Module" }));
    const instance = container.querySelector(
      '.react-flow__node[data-id="keyboard-module-1"]',
    );
    fireEvent.click(instance!);
    fireEvent.keyDown(screen.getByRole("application"), { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByRole("navigation", { name: "层级导航" }))
        .toHaveTextContent("Keyboard Module"),
    );
  });

  it("disables module placements that would create a recursive hierarchy", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("Recursive");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "新建模块" }));

    expect(screen.getByRole("button", { name: "放置 Recursive" })).toBeDisabled();
  });

  it("renames modules without changing their stable identity", async () => {
    vi.spyOn(window, "prompt")
      .mockReturnValueOnce("Reusable")
      .mockReturnValueOnce("Renamed Module");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "新建模块" }));
    fireEvent.click(screen.getByRole("button", { name: "返回上级" }));
    fireEvent.click(screen.getByRole("button", { name: "重命名 Reusable" }));

    expect(screen.getByRole("button", { name: "编辑 Renamed Module" }))
      .toBeInTheDocument();
  });

  it("reloads the runtime at main when deleting the active module", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("Disposable");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "新建模块" }));
    fireEvent.click(screen.getByRole("button", { name: "删除 Disposable" }));

    await waitFor(() => {
      expect(screen.getByRole("navigation", { name: "层级导航" }))
        .toHaveTextContent("Main");
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
    expect(screen.getByRole("navigation", { name: "层级导航" }))
      .not.toHaveTextContent("Blocked");
  });

  it("does not commit an input when the runtime rejects its update", async () => {
    runtimeMock.setSource.mockImplementationOnce(() => {
      throw new Error("source blocked");
    });
    const { container } = render(<App />);
    await screen.findByText(/层级模拟器已就绪/);
    const input = container.querySelector('.react-flow__node[data-id="input-1"]');
    fireEvent.click(input!);

    expect(await screen.findByText(/source blocked/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();
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
    fireEvent.click(await screen.findByRole("button", { name: /QUALIFIED_TEST/ }));

    await waitFor(() => {
      const navigation = screen.getByRole("navigation", { name: "层级导航" });
      expect(navigation).toHaveTextContent("Wrapper");
      expect(navigation).toHaveTextContent("Identity");
    });
  });
});
