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
import type { WasmProjectSimulatorBinding } from "../src/wasm-client";

function snapshot(compileCount: number): ProjectSimulationSnapshot {
  return {
    componentOutputs: {},
    inputNets: {},
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
    loadProject: vi.fn(() => snapshot(++count)),
    updateProject: vi.fn(() => snapshot(++count)),
    switchActive: vi.fn(() => snapshot(++count)),
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
    expect(wasm.setSource).toHaveBeenCalledWith(
      "half-adder",
      "ordinary",
      "1",
    );
    expect(wasm.updateProject).toHaveBeenCalledTimes(1);
    expect(wasm.switchActive).toHaveBeenCalledWith("half-adder");
  });

  it("defers a zero-copy source until its module is about to become active", () => {
    const wasm = binding();
    const runtime = new HierarchyRuntime(wasm);
    runtime.load(project(), "main");
    vi.clearAllMocks();

    runtime.setSource("spare", "constant-1", "T");

    expect(wasm.setSource).not.toHaveBeenCalled();
    expect(wasm.updateProject).not.toHaveBeenCalled();
    expect(wasm.switchActive).not.toHaveBeenCalled();

    runtime.switchActive("spare");
    expect(wasm.updateProject).toHaveBeenCalledTimes(1);
    expect(wasm.switchActive).toHaveBeenCalledWith("spare");
  });

  it("sorts boundary ports for Rust and strips editor-only presentation", () => {
    const runtimeProject = toRuntimeProject(project());
    const halfAdder = runtimeProject.circuits.find(
      (circuit) => circuit.id === "half-adder",
    )!;

    expect(halfAdder).not.toHaveProperty("viewport");
    expect(halfAdder.components.map((component) => component.id)).toEqual([
      "input-a",
      "input-b",
      "ordinary",
    ]);
    expect(halfAdder.components.every((component) => !("position" in component))).toBe(
      true,
    );
    expect(halfAdder.components[0].properties.label).toBe("A");
    expect(halfAdder.components[2].properties).not.toHaveProperty("label");
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
