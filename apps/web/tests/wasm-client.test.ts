import { beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";

import type {
  SimulationSnapshot,
  WasmProjectSimulatorBinding,
  WasmSimulatorBinding,
} from "../src/wasm-client";
import type { ProjectSimulationSnapshot } from "../src/editor-model";

const wasmMock = vi.hoisted(() => {
  const flatSnapshot = {
    api_version: 3,
    stable: true,
    component_outputs: { dff: { q: "1" } },
    input_nets: { dff: { clk: "0" } },
    diagnostics: [],
    processed_events: 6,
    tick_count: 1,
  };
  const projectSnapshot = {
    componentOutputs: { dff: { q: "1" } },
    inputNets: { dff: { clk: "0" } },
    componentOutputWords: { dff: { q: "1" } },
    inputNetWords: { dff: { clk: "0" } },
    diagnostics: [],
    stable: true,
    tickCount: 1,
    compileCount: 1,
  };
  class WasmSimulator {
    tick() {
      return flatSnapshot;
    }
  }
  class WasmProjectSimulator {
    tick() {
      return projectSnapshot;
    }
  }

  return {
    flatSnapshot,
    initialize: vi.fn(async () => undefined),
    projectSnapshot,
    WasmSimulator,
    WasmProjectSimulator,
  };
});

vi.mock("../src/wasm/pkg/sim_wasm", () => ({
  default: wasmMock.initialize,
  apiVersion: () => 3,
  componentCatalog: () => [],
  resolveProjectPorts: (_typeId: string, properties: unknown) => [
    { id: "out", direction: "output", width: (properties as { width?: number }).width ?? 1 },
  ],
  resolveProjectModulePorts: (_project: unknown, moduleId: string) => [
    { id: `${moduleId}-in`, direction: "input", width: 3 },
  ],
  WasmSimulator: wasmMock.WasmSimulator,
  WasmProjectSimulator: wasmMock.WasmProjectSimulator,
}));

describe("WASM runtime initialization", () => {
  beforeAll(() => {
    wasmMock.initialize.mockClear();
  });

  it("initializes the shared WASM module once for concurrent callers", async () => {
    const { createWasmRuntime } = await import("../src/wasm-client");

    const [first, second] = await Promise.all([
      createWasmRuntime(),
      createWasmRuntime(),
    ]);

    expect(wasmMock.initialize).toHaveBeenCalledTimes(1);
    expect(first.apiVersion).toBe(3);
    expect(second.apiVersion).toBe(3);
    expect(first.simulator).toBeInstanceOf(wasmMock.WasmSimulator);
    expect(second.simulator).toBeInstanceOf(wasmMock.WasmSimulator);
    expect(first.projectSimulator).toBeInstanceOf(
      wasmMock.WasmProjectSimulator,
    );
  });

  it("exposes API v3 words and a synchronous dynamic-port resolver", async () => {
    const { createWasmRuntime } = await import("../src/wasm-client");
    const runtime = await createWasmRuntime();

    const flat = runtime.simulator.tick();
    const project = runtime.projectSimulator.tick();

    expect(flat).toEqual(wasmMock.flatSnapshot);
    expect(flat.tick_count).toBe(1);
    expect(project).toEqual(wasmMock.projectSnapshot);
    expect(project.tickCount).toBe(1);
    expect(project.componentOutputWords.dff.q).toBe("1");
    expect(runtime.resolveProjectPorts("source.constant", { width: 3 })).toEqual([
      { id: "out", direction: "output", width: 3 },
    ]);
    expect(runtime.resolveProjectModulePorts({ version: 3 }, "word")).toEqual([
      { id: "word-in", direction: "input", width: 3 },
    ]);
    expectTypeOf(flat).toEqualTypeOf<SimulationSnapshot>();
    expectTypeOf(project).toEqualTypeOf<ProjectSimulationSnapshot>();
    expectTypeOf(runtime.simulator).toMatchTypeOf<WasmSimulatorBinding>();
    expectTypeOf(runtime.projectSimulator).toMatchTypeOf<WasmProjectSimulatorBinding>();
  });
});

describe("WASM error decoding", () => {
  it("preserves a structured project-not-ready tick error", async () => {
    const { wasmProjectError } = await import("../src/wasm-client");
    const diagnostic = {
      code: "PROJECT_NOT_READY",
      severity: "error" as const,
      message: "project simulation is unavailable until validation succeeds",
      primaryLocation: null,
      componentRefs: [],
      connectionRefs: [],
      portRefs: [],
    };

    expect(
      wasmProjectError({
        code: "PROJECT_NOT_READY",
        message: diagnostic.message,
        diagnostics: [diagnostic],
      }),
    ).toEqual({
      name: "SimulationError",
      code: "PROJECT_NOT_READY",
      message: diagnostic.message,
      diagnostics: [diagnostic],
    });
  });
});
