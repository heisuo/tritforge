import type {
  CatalogComponent,
  CircuitDefinition,
  KnownTrit,
  TritSymbol,
} from "./editor-model";

export interface SimulationDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  component_ids: string[];
  connection_ids: string[];
  port_ids: string[];
}

export interface SimulationSnapshot {
  api_version: number;
  stable: boolean;
  component_outputs: Record<string, Record<string, TritSymbol>>;
  input_nets: Record<string, Record<string, TritSymbol>>;
  diagnostics: SimulationDiagnostic[];
  processed_events: number;
}

interface WasmSimulatorBinding {
  loadCircuit(definition: CircuitDefinition): SimulationSnapshot;
  setInput(componentId: string, value: KnownTrit): SimulationSnapshot;
  reset(): SimulationSnapshot;
  snapshot(): SimulationSnapshot;
}

export interface WasmRuntime {
  apiVersion: number;
  catalog: CatalogComponent[];
  simulator: WasmSimulatorBinding;
}

type WasmModule = typeof import("./wasm/pkg/sim_wasm");

let wasmModulePromise: Promise<WasmModule> | null = null;

function initializedWasmModule(): Promise<WasmModule> {
  if (!wasmModulePromise) {
    wasmModulePromise = import("./wasm/pkg/sim_wasm").then(async (wasm) => {
      await wasm.default();
      return wasm;
    });
  }
  return wasmModulePromise;
}

export async function createWasmRuntime(): Promise<WasmRuntime> {
  const wasm = await initializedWasmModule();

  return {
    apiVersion: wasm.apiVersion(),
    catalog: wasm.componentCatalog() as CatalogComponent[],
    simulator: new wasm.WasmSimulator() as WasmSimulatorBinding,
  };
}

export function wasmErrorMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
