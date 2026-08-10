import type {
  CatalogComponent,
  CircuitDefinition,
  KnownTrit,
  ProjectSimulationDiagnostic,
  ProjectSimulationSnapshot,
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
  tick_count: number;
}

export interface WasmSimulatorBinding {
  loadCircuit(definition: CircuitDefinition): SimulationSnapshot;
  setInput(componentId: string, value: KnownTrit): SimulationSnapshot;
  reset(): SimulationSnapshot;
  tick(): SimulationSnapshot;
  snapshot(): SimulationSnapshot;
}

export interface WasmProjectSimulatorBinding {
  loadProject(
    project: unknown,
    activeCircuitId: string,
  ): ProjectSimulationSnapshot;
  updateProject(project: unknown): ProjectSimulationSnapshot;
  switchActive(activeCircuitId: string): ProjectSimulationSnapshot;
  setSource(
    circuitId: string,
    componentId: string,
    value: string,
  ): ProjectSimulationSnapshot;
  tick(): ProjectSimulationSnapshot;
  snapshot(): ProjectSimulationSnapshot;
  metrics(): ProjectCompileMetrics;
}

export interface ProjectCompileMetrics {
  expandedComponents: number;
  expandedConnections: number;
  projectionEndpoints: number;
}

export interface ResolvedProjectPort {
  id: string;
  direction: "input" | "output" | "inout";
  width: number;
}

export interface ResolvedProjectModulePort {
  id: string;
  label: string;
  direction: "input" | "output";
  width: number;
}

export type ProjectPortResolver = (
  typeId: string,
  properties: Record<string, unknown>,
) => ResolvedProjectPort[];

/** Returns Rust-validated logical module ports in canonical port-ID order. */
export type ProjectModulePortResolver = (
  project: unknown,
  moduleId: string,
) => ResolvedProjectModulePort[];

export type ProjectModuleInterfaces = Record<
  string,
  ResolvedProjectModulePort[]
>;

/** Resolves every Rust-validated module interface with one project validation. */
export type ProjectModuleInterfaceResolver = (
  project: unknown,
) => ProjectModuleInterfaces;

export interface WasmRuntime {
  apiVersion: number;
  catalog: CatalogComponent[];
  resolveProjectPorts: ProjectPortResolver;
  resolveProjectModulePorts: ProjectModulePortResolver;
  resolveProjectModuleInterfaces: ProjectModuleInterfaceResolver;
  simulator: WasmSimulatorBinding;
  projectSimulator: WasmProjectSimulatorBinding;
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
    resolveProjectPorts: wasm.resolveProjectPorts as ProjectPortResolver,
    resolveProjectModulePorts:
      wasm.resolveProjectModulePorts as ProjectModulePortResolver,
    resolveProjectModuleInterfaces:
      wasm.resolveProjectModuleInterfaces as ProjectModuleInterfaceResolver,
    simulator: new wasm.WasmSimulator() as WasmSimulatorBinding,
    projectSimulator:
      new wasm.WasmProjectSimulator() as WasmProjectSimulatorBinding,
  };
}

export interface WasmProjectError {
  name: "SimulationError";
  code: string;
  message: string;
  diagnostics: ProjectSimulationDiagnostic[];
}

export function wasmProjectError(error: unknown): WasmProjectError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return {
      name: "SimulationError",
      code: error.code,
      message:
        "message" in error && typeof error.message === "string"
          ? error.message
          : "Project simulation failed",
      diagnostics:
        "diagnostics" in error && Array.isArray(error.diagnostics)
          ? (error.diagnostics as ProjectSimulationDiagnostic[])
          : [],
    };
  }
  return {
    name: "SimulationError",
    code: "WASM_PROJECT_ERROR",
    message: wasmErrorMessage(error),
    diagnostics: [],
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
