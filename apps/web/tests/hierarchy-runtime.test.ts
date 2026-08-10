import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { KnownTrit, ProjectSimulationSnapshot } from "../src/editor-model";
import {
  HierarchyRuntimeError,
  HierarchyRuntime,
  toRuntimeProject,
} from "../src/project/hierarchy-runtime";
import type { ProjectDocumentV2 } from "../src/project/project-document";
import type { ProjectDocumentV3 } from "../src/project/project-v3";
import type {
  TraceFrame,
  TraceWatch,
  WasmProjectSimulatorBinding,
} from "../src/wasm-client";

function snapshot(compileCount: number): ProjectSimulationSnapshot {
  return {
    componentOutputs: {},
    inputNets: {},
    componentOutputWords: {},
    inputNetWords: {},
    diagnostics: [],
    stable: true,
    tickCount: 0,
    compileCount,
    clockPhase: "lowStable",
  };
}

const clockWatch = {
  id: "clock",
  signal: {
    kind: "componentPort" as const,
    ref: {
      circuitId: "main",
      instancePath: [],
      componentId: "clock",
      portId: "out",
    },
  },
} satisfies TraceWatch;

const loadFrame = {
  cycle: 0,
  clockPhase: "lowStable" as const,
  reason: "load" as const,
  values: [{ watchId: "clock", value: "0" }],
  diagnostics: [],
} satisfies TraceFrame;

function project(): ProjectDocumentV2 {
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
            id: "half-adder-1",
            typeId: "project.module_instance",
            position: { x: 200, y: 100 },
            properties: { moduleId: "half-adder", label: "HA1" },
          },
        ],
        connections: [],
      },
      {
        id: "half-adder",
        name: "Half Adder",
        kind: "module",
        components: [
          {
            id: "input-b",
            typeId: "project.module_input",
            position: { x: 0, y: 200 },
            properties: { portId: "b", label: "B", previewValue: "0" },
          },
          {
            id: "ordinary",
            typeId: "source.constant",
            position: { x: 100, y: 100 },
            properties: { value: "0", label: "Editor label" },
          },
          {
            id: "input-a",
            typeId: "project.module_input",
            position: { x: 0, y: 20 },
            properties: { portId: "a", label: "A", previewValue: "0" },
          },
        ],
        connections: [],
        viewport: { x: 10, y: 20, zoom: 1.5 },
      },
      {
        id: "spare",
        name: "Spare",
        kind: "module",
        components: [
          {
            id: "constant-1",
            typeId: "source.constant",
            position: { x: 0, y: 0 },
            properties: { value: "0" },
          },
        ],
        connections: [],
      },
    ],
  };
}

function binding() {
  let count = 0;
  return {
    loadProject: vi.fn((_project: unknown, _activeCircuitId: string) => snapshot(++count)),
    updateProject: vi.fn((_project: unknown) => snapshot(++count)),
    switchActive: vi.fn((_activeCircuitId: string) => snapshot(++count)),
    setSource: vi.fn(
      (_circuitId: string, _componentId: string, _value: KnownTrit) =>
        snapshot(count),
    ),
    tick: vi.fn(() => snapshot(count)),
    advancePhase: vi.fn(() => ({ ...snapshot(count), clockPhase: "highStable" as const })),
    reset: vi.fn(() => snapshot(count)),
    setTraceWatches: vi.fn((_watches: TraceWatch[]): TraceFrame => loadFrame),
    traceFrames: vi.fn((): TraceFrame[] => [loadFrame]),
    traceWatches: vi.fn(() => [clockWatch]),
    traceDiagnostics: vi.fn(() => []),
    clearTrace: vi.fn(() => undefined),
    snapshot: vi.fn(() => snapshot(count)),
    metrics: vi.fn(() => ({
      expandedComponents: 0,
      expandedConnections: 0,
      projectionEndpoints: 0,
    })),
  } satisfies WasmProjectSimulatorBinding;
}

describe("hierarchy runtime", () => {
  it("routes load, reachable values, structures, and navigation to WASM", () => {
    const wasm = binding();
    const runtime = new HierarchyRuntime(wasm);
    const value = project();

    runtime.load(value, "main");
    runtime.setSource("half-adder", "ordinary", "1");
    runtime.updateProject(value);
    runtime.switchActive("half-adder");

    expect(wasm.loadProject).toHaveBeenCalledTimes(1);
    expect(wasm.loadProject.mock.calls[0][0]).toMatchObject({
      format: "logsim-ternary",
      version: 3,
    });
    expect(wasm.loadProject.mock.calls[0][0]).not.toHaveProperty(
      "circuits.0.connections",
    );
    expect(wasm.setSource).toHaveBeenCalledWith(
      "half-adder",
      "ordinary",
      "1",
    );
    expect(wasm.updateProject).toHaveBeenCalledTimes(1);
    expect(wasm.switchActive).toHaveBeenCalledWith("half-adder");
  });

  it("ticks through WASM and accepts the returned tick count", () => {
    const wasm = binding();
    const runtime = new HierarchyRuntime(wasm);
    runtime.load(project(), "main");
    const ticked = { ...snapshot(1), tickCount: 3 };
    wasm.tick.mockReturnValueOnce(ticked);

    expect(runtime.tick()).toBe(ticked);
    expect(wasm.tick).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot()).toBe(ticked);
    expect(runtime.snapshot()?.tickCount).toBe(3);
  });

  it("exposes phase, reset, and trace lifecycle without changing watch order", () => {
    const wasm = binding();
    const runtime = new HierarchyRuntime(wasm);
    runtime.load(project(), "main");

    expect(runtime.setTraceWatches([clockWatch])).toBe(loadFrame);
    expect(runtime.traceWatches()).toEqual([clockWatch]);
    expect(runtime.traceFrames()).toEqual([loadFrame]);
    expect(runtime.traceDiagnostics()).toEqual([]);
    expect(runtime.advancePhase().clockPhase).toBe("highStable");
    expect(runtime.reset().clockPhase).toBe("lowStable");
    runtime.clearTrace();

    expect(wasm.setTraceWatches).toHaveBeenCalledWith([clockWatch]);
    expect(wasm.advancePhase).toHaveBeenCalledTimes(1);
    expect(wasm.reset).toHaveBeenCalledTimes(1);
    expect(wasm.clearTrace).toHaveBeenCalledTimes(1);
  });

  it("keeps the last snapshot and exposes a fault frame after a boundary error", () => {
    const wasm = binding();
    const runtime = new HierarchyRuntime(wasm);
    const previous = runtime.load(project(), "main");
    const fault = {
      ...loadFrame,
      reason: "fault" as const,
      diagnostics: [
        {
          code: "NON_CONVERGENT_COMBINATIONAL_LOOP",
          severity: "error" as const,
          message: "did not converge",
          primaryLocation: null,
          componentRefs: [],
          connectionRefs: [],
          portRefs: [],
        },
      ],
    };
    wasm.advancePhase.mockImplementationOnce(() => {
      throw {
        code: "NON_CONVERGENT_COMBINATIONAL_LOOP",
        message: "did not converge",
        diagnostics: fault.diagnostics,
      };
    });
    wasm.traceFrames.mockReturnValueOnce([loadFrame, fault]);

    expect(() => runtime.advancePhase()).toThrow(/did not converge/i);
    expect(runtime.snapshot()).toBe(previous);
    expect(runtime.traceFrames()).toEqual([loadFrame, fault]);
  });

  it("does not alter runtime trace state after invalid watch replacement", () => {
    const wasm = binding();
    const runtime = new HierarchyRuntime(wasm);
    runtime.load(project(), "main");
    runtime.setTraceWatches([clockWatch]);
    wasm.setTraceWatches.mockImplementationOnce(() => {
      throw {
        code: "TRACE_SIGNAL_UNAVAILABLE",
        message: "signal is unavailable",
        diagnostics: [],
      };
    });

    expect(() =>
      runtime.setTraceWatches([
        {
          ...clockWatch,
          id: "missing",
          signal: {
            ...clockWatch.signal,
            ref: { ...clockWatch.signal.ref, componentId: "missing" },
          },
        },
      ]),
    ).toThrow(/unavailable/i);
    expect(runtime.traceWatches()).toEqual([clockWatch]);
    expect(runtime.snapshot()?.clockPhase).toBe("lowStable");
  });

  it("validates and synchronizes a zero-copy source through Rust immediately", () => {
    const wasm = binding();
    const runtime = new HierarchyRuntime(wasm);
    runtime.load(project(), "main");
    vi.clearAllMocks();

    runtime.setSource("spare", "constant-1", "T");

    expect(wasm.setSource).toHaveBeenCalledWith("spare", "constant-1", "T");
    expect(wasm.updateProject).not.toHaveBeenCalled();
    expect(wasm.switchActive).not.toHaveBeenCalled();

    runtime.switchActive("spare");
    expect(wasm.updateProject).not.toHaveBeenCalled();
    expect(wasm.switchActive).toHaveBeenCalledWith("spare");
  });

  it("sends an existing v3 document directly with undirected wires intact", () => {
    const wasm = binding();
    const runtime = new HierarchyRuntime(wasm);
    const value: ProjectDocumentV3 = {
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
              id: "word",
              typeId: "source.trit_input",
              position: { x: 0, y: 0 },
              properties: { width: 3, value: "1T0" },
            },
            {
              id: "probe",
              typeId: "sink.probe",
              position: { x: 100, y: 0 },
              properties: { width: 3 },
            },
            {
              id: "tunnel",
              typeId: "wiring.tunnel",
              position: { x: 50, y: 80 },
              properties: { width: 3, label: "DATA" },
            },
          ],
          wires: [
            {
              id: "data",
              endpointA: { componentId: "probe", portId: "in" },
              endpointB: { componentId: "word", portId: "out" },
            },
          ],
        },
      ],
    };

    runtime.load(value, "main");
    runtime.setSource("main", "word", "T01");

    expect(wasm.loadProject.mock.calls[0][0]).toMatchObject({
      version: 3,
      circuits: [
        {
          wires: [
            {
              id: "data",
              endpointA: { componentId: "probe", portId: "in" },
              endpointB: { componentId: "word", portId: "out" },
            },
          ],
        },
      ],
    });
    expect(wasm.setSource).toHaveBeenCalledWith("main", "word", "T01");
    expect(
      (wasm.loadProject.mock.calls[0][0] as {
        circuits: Array<{ components: Array<{ id: string; properties: Record<string, unknown> }> }>;
      }).circuits[0].components.find((component) => component.id === "tunnel")?.properties,
    ).toEqual({ width: 3, label: "DATA" });
  });

  it("strips editor metadata without assigning coordinate-based port semantics", () => {
    const runtimeProject = toRuntimeProject(project());
    const halfAdder = runtimeProject.circuits.find(
      (circuit) => circuit.id === "half-adder",
    )!;

    expect(halfAdder).not.toHaveProperty("viewport");
    expect(runtimeProject.version).toBe(3);
    expect(halfAdder).toHaveProperty("wires");
    expect(halfAdder).not.toHaveProperty("connections");
    expect(halfAdder.components.map((component) => component.id)).toEqual([
      "input-b",
      "ordinary",
      "input-a",
    ]);
    expect(halfAdder.components.every((component) => !("position" in component))).toBe(
      true,
    );
    expect(halfAdder.components[0].properties.label).toBe("B");
    expect(halfAdder.components[1].properties.label).toBe("Editor label");
    expect(halfAdder.components[2].properties.label).toBe("A");
  });

  it("contains no TypeScript gate equations or hierarchy flattener", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/project/hierarchy-runtime.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/mod_sum|consensus|truth[_ ]table/i);
    expect(source).not.toMatch(/flatten(?:Project|Module|Circuit)|flatComponents/);
  });

  it("returns structured local source errors and rejects runtime meta values", () => {
    const wasm = binding();
    const runtime = new HierarchyRuntime(wasm);
    runtime.load(project(), "main");

    for (const operation of [
      () => runtime.setSource("missing", "constant-1", "0"),
      () => runtime.setSource("spare", "missing", "0"),
      () => runtime.setSource("spare", "constant-1", "X" as KnownTrit),
    ]) {
      try {
        operation();
        throw new Error("expected source update to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(HierarchyRuntimeError);
        expect((error as HierarchyRuntimeError).code).toBe(
          "INVALID_SOURCE_UPDATE",
        );
      }
    }
  });

  it("preserves the last valid runtime after a rejected project update", () => {
    const wasm = binding();
    const runtime = new HierarchyRuntime(wasm);
    const previous = runtime.load(project(), "main");
    wasm.updateProject.mockImplementationOnce(() => {
      throw {
        code: "UNKNOWN_MODULE",
        message: "broken project",
        diagnostics: [],
      };
    });

    expect(() => runtime.updateProject(project())).toThrow(/broken project/i);
    expect(runtime.snapshot()).toBe(previous);
    expect(runtime.setSource("spare", "constant-1", "1")).toEqual(snapshot(1));
    expect(runtime.tick()).toEqual(snapshot(1));
    expect(wasm.setSource).toHaveBeenCalledWith("spare", "constant-1", "1");
    expect(wasm.tick).toHaveBeenCalledTimes(1);
  });

  it("preserves the previous snapshot when an active switch fails", () => {
    const wasm = binding();
    const runtime = new HierarchyRuntime(wasm);
    const previous = runtime.load(project(), "main");
    wasm.switchActive.mockImplementationOnce(() => {
      throw {
        code: "INVALID_ACTIVE_CIRCUIT",
        message: "unknown active circuit",
        diagnostics: [],
      };
    });

    expect(() => runtime.switchActive("missing")).toThrow(/unknown active/i);
    expect(runtime.snapshot()).toBe(previous);
  });
});
