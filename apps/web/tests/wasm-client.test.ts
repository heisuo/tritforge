import { beforeAll, describe, expect, it, vi } from "vitest";

const wasmMock = vi.hoisted(() => {
  class WasmSimulator {}

  return {
    initialize: vi.fn(async () => undefined),
    WasmSimulator,
  };
});

vi.mock("../src/wasm/pkg/sim_wasm", () => ({
  default: wasmMock.initialize,
  apiVersion: () => 1,
  componentCatalog: () => [],
  WasmSimulator: wasmMock.WasmSimulator,
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
    expect(first.apiVersion).toBe(1);
    expect(second.apiVersion).toBe(1);
    expect(first.simulator).toBeInstanceOf(wasmMock.WasmSimulator);
    expect(second.simulator).toBeInstanceOf(wasmMock.WasmSimulator);
  });
});
