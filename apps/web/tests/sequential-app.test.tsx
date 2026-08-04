import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSimulationSnapshot } from "../src/editor-model";
import type { WasmProjectSimulatorBinding } from "../src/wasm-client";

const mock = vi.hoisted(() => {
  const snapshot = (): ProjectSimulationSnapshot => ({
    componentOutputs: {},
    inputNets: {},
    diagnostics: [],
    stable: true,
    tickCount: 0,
    compileCount: 1,
  });
  const projectSimulator = {
    loadProject: vi.fn(() => snapshot()),
    updateProject: vi.fn((_project: unknown) => snapshot()),
    switchActive: vi.fn(() => snapshot()),
    setSource: vi.fn(() => snapshot()),
    tick: vi.fn(() => snapshot()),
    snapshot: vi.fn(() => snapshot()),
    metrics: vi.fn(() => ({
      expandedComponents: 0,
      expandedConnections: 0,
      projectionEndpoints: 0,
    })),
  } satisfies WasmProjectSimulatorBinding;
  return { makeSnapshot: snapshot, ...projectSimulator };
});

vi.mock("../src/wasm-client", () => ({
  createWasmRuntime: vi.fn(async () => ({
    apiVersion: 2,
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
        type_id: "source.clock",
        display_name: "Clock",
        category: "source",
        kind: "source",
        ports: [{ id: "out", direction: "output" }],
        truth_table: [],
      },
      {
        type_id: "sequential.dff",
        display_name: "D Flip-Flop",
        category: "sequential",
        kind: "sequential",
        ports: [
          { id: "d", direction: "input" },
          { id: "clk", direction: "input" },
          { id: "en", direction: "input" },
          { id: "rst", direction: "input" },
          { id: "q", direction: "output" },
        ],
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
    projectSimulator: mock,
  })),
  wasmErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  wasmProjectError: (error: unknown) => ({
    name: "SimulationError",
    code: "TEST_ERROR",
    message: error instanceof Error ? error.message : String(error),
    diagnostics: [],
  }),
}));

import { App } from "../src/App";

describe("sequential App controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => cleanup());

  it("shows and triggers one ready Tick, exposes sequential palette, and keeps Clock properties empty", async () => {
    mock.tick.mockImplementationOnce(() => ({ ...mock.makeSnapshot(), tickCount: 1 }));
    render(<App />);

    const tick = await screen.findByRole("button", { name: "单步 Tick" });
    await waitFor(() => expect(tick).not.toBeDisabled());
    expect(screen.getByText("0 TICKS")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "时序" })).toBeInTheDocument();

    fireEvent.click(tick);
    await waitFor(() => expect(screen.getByText("1 TICKS")).toBeInTheDocument());
    expect(mock.tick).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Clock/ }));
    const lastProject = mock.updateProject.mock.calls.at(-1)?.[0] as {
      circuits: Array<{
        id: string;
        components: Array<{ typeId: string; properties: Record<string, unknown> }>;
      }>;
    };
    const clock = lastProject.circuits
      .find((circuit) => circuit.id === "main")
      ?.components.find((component) => component.typeId === "source.clock");
    expect(clock?.properties).toEqual({});
  });
});
