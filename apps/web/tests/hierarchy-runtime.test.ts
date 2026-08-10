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
import type { WasmProjectSimulatorBinding } from "../src/wasm-client";

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
  };
}

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

  it("sorts boundary ports for Rust while preserving v3 component properties", () => {
    const runtimeProject = toRuntimeProject(project());
    const halfAdder = runtimeProject.circuits.find(
      (circuit) => circuit.id === "half-adder",
    )!;

    expect(halfAdder).not.toHaveProperty("viewport");
    expect(runtimeProject.version).toBe(3);
    expect(halfAdder).toHaveProperty("wires");
    expect(halfAdder).not.toHaveProperty("connections");
    expect(halfAdder.components.map((component) => component.id)).toEqual([
      "input-a",
      "input-b",
      "ordinary",
    ]);
    expect(halfAdder.components.every((component) => !("position" in component))).toBe(
      true,
    );
    expect(halfAdder.components[0].properties.label).toBe("A");
    expect(halfAdder.components[2].properties.label).toBe("Editor label");
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

  it("blocks every source update while project validation is failing", () => {
    const wasm = binding();
    const runtime = new HierarchyRuntime(wasm);
    runtime.load(project(), "main");
    wasm.updateProject.mockImplementationOnce(() => {
      throw {
        code: "UNKNOWN_MODULE",
        message: "broken project",
        diagnostics: [],
      };
    });

    expect(() => runtime.updateProject(project())).toThrow(/broken project/i);
    expect(() => runtime.setSource("spare", "constant-1", "1")).toThrow(
      /unavailable/i,
    );
    expect(wasm.setSource).not.toHaveBeenCalled();
    expect(runtime.snapshot()).toBeNull();
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
