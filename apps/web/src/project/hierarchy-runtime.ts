import type { ProjectSimulationSnapshot } from "../editor-model";
import {
  wasmProjectError,
  type WasmProjectError,
  type WasmProjectSimulatorBinding,
} from "../wasm-client";
import type { ProjectDocumentV2 } from "./project-document";
import {
  migrateV2ToV3,
  type ProjectDocumentV3,
  type ProjectWire,
} from "./project-v3";

export type EditableProjectDocument = ProjectDocumentV2 | ProjectDocumentV3;

export interface RuntimeProjectDocument {
  format: "logsim-ternary";
  version: 3;
  rootCircuitId: string;
  circuits: RuntimeProjectCircuit[];
}

export interface RuntimeProjectCircuit {
  id: string;
  name: string;
  kind: "main" | "module";
  components: RuntimeProjectComponent[];
  wires: ProjectWire[];
}

export interface RuntimeProjectComponent {
  id: string;
  typeId: string;
  properties: Record<string, unknown>;
}

export class HierarchyRuntimeError extends Error {
  readonly code: string;
  readonly diagnostics: WasmProjectError["diagnostics"];

  constructor(error: WasmProjectError) {
    super(error.message);
    this.name = error.name;
    this.code = error.code;
    this.diagnostics = error.diagnostics;
  }
}

export class HierarchyRuntime {
  private project: ProjectDocumentV3 | null = null;
  private activeCircuitId: string | null = null;
  private wasmProjectSynchronized = false;
  private projectValid = false;
  private currentSnapshot: ProjectSimulationSnapshot | null = null;

  constructor(private readonly wasm: WasmProjectSimulatorBinding) {}

  load(
    project: EditableProjectDocument,
    activeCircuitId: string,
  ): ProjectSimulationSnapshot {
    const projectV3 = normalizeProject(project);
    try {
      const snapshot = this.wasm.loadProject(
        toRuntimeProject(projectV3),
        activeCircuitId,
      );
      this.project = cloneProject(projectV3);
      this.activeCircuitId = activeCircuitId;
      this.wasmProjectSynchronized = true;
      this.projectValid = true;
      this.currentSnapshot = snapshot;
      return snapshot;
    } catch (error) {
      throw new HierarchyRuntimeError(wasmProjectError(error));
    }
  }

  updateProject(project: EditableProjectDocument): ProjectSimulationSnapshot {
    this.requireLoaded();
    const projectV3 = normalizeProject(project);
    try {
      const snapshot = this.wasm.updateProject(toRuntimeProject(projectV3));
      this.project = cloneProject(projectV3);
      this.wasmProjectSynchronized = true;
      this.projectValid = true;
      this.currentSnapshot = snapshot;
      return snapshot;
    } catch (error) {
      this.wasmProjectSynchronized = false;
      this.projectValid = false;
      this.currentSnapshot = null;
      throw new HierarchyRuntimeError(wasmProjectError(error));
    }
  }

  setSource(
    circuitId: string,
    componentId: string,
    value: string,
  ): ProjectSimulationSnapshot | null {
    const project = this.requireLoaded();
    if (!this.projectValid) {
      throw runtimeSourceError(
        "project simulation is unavailable until validation succeeds",
      );
    }
    if (!/^[T01]+$/.test(value)) {
      throw runtimeSourceError(`'${String(value)}' is not a known ternary source word`);
    }
    const nextProject = withSourceValue(project, circuitId, componentId, value);
    try {
      const snapshot = this.wasm.setSource(circuitId, componentId, value);
      this.project = nextProject;
      this.wasmProjectSynchronized = true;
      this.currentSnapshot = snapshot;
      return snapshot;
    } catch (error) {
      throw new HierarchyRuntimeError(wasmProjectError(error));
    }
  }

  tick(): ProjectSimulationSnapshot {
    this.requireLoaded();
    if (!this.projectValid) {
      throw new HierarchyRuntimeError({
        name: "SimulationError",
        code: "PROJECT_NOT_READY",
        message: "project simulation is unavailable until validation succeeds",
        diagnostics: [],
      });
    }
    try {
      return this.accept(this.wasm.tick());
    } catch (error) {
      throw new HierarchyRuntimeError(wasmProjectError(error));
    }
  }

  switchActive(activeCircuitId: string): ProjectSimulationSnapshot {
    const project = this.requireLoaded();
    if (!this.wasmProjectSynchronized) {
      try {
        this.currentSnapshot = this.wasm.updateProject(toRuntimeProject(project));
        this.wasmProjectSynchronized = true;
        this.projectValid = true;
      } catch (error) {
        this.projectValid = false;
        this.currentSnapshot = null;
        throw new HierarchyRuntimeError(wasmProjectError(error));
      }
    }
    try {
      const snapshot = this.wasm.switchActive(activeCircuitId);
      this.activeCircuitId = activeCircuitId;
      this.currentSnapshot = snapshot;
      return snapshot;
    } catch (error) {
      throw new HierarchyRuntimeError(wasmProjectError(error));
    }
  }

  snapshot(): ProjectSimulationSnapshot | null {
    return this.currentSnapshot;
  }

  private accept(snapshot: ProjectSimulationSnapshot): ProjectSimulationSnapshot {
    this.currentSnapshot = snapshot;
    return snapshot;
  }

  private requireLoaded(): ProjectDocumentV3 {
    if (!this.project || !this.activeCircuitId) {
      throw new HierarchyRuntimeError({
        name: "SimulationError",
        code: "SIMULATOR_NOT_LOADED",
        message: "load must be called before project simulation",
        diagnostics: [],
      });
    }
    return this.project;
  }
}

export function toRuntimeProject(
  project: EditableProjectDocument,
): RuntimeProjectDocument {
  const projectV3 = normalizeProject(project);
  return {
    format: projectV3.format,
    version: projectV3.version,
    rootCircuitId: projectV3.rootCircuitId,
    circuits: projectV3.circuits.map((circuit) => ({
      id: circuit.id,
      name: circuit.name,
      kind: circuit.kind,
      components: circuit.components.map((component) => ({
        id: component.id,
        typeId: component.typeId,
        properties: structuredClone(component.properties),
      })),
      wires: circuit.wires.map((wire) => ({
        id: wire.id,
        endpointA: { ...wire.endpointA },
        endpointB: { ...wire.endpointB },
      })),
    })),
  };
}

function withSourceValue(
  project: ProjectDocumentV3,
  circuitId: string,
  componentId: string,
  value: string,
): ProjectDocumentV3 {
  let foundCircuit = false;
  let foundSource = false;
  const circuits = project.circuits.map((circuit) => {
    if (circuit.id !== circuitId) {
      return circuit;
    }
    foundCircuit = true;
    return {
      ...circuit,
      components: circuit.components.map((component) => {
        if (component.id !== componentId) {
          return component;
        }
        const valueKey =
          component.typeId === "project.module_input"
            ? "previewValue"
            : component.typeId === "source.trit_input" ||
                component.typeId === "source.constant"
              ? "value"
              : null;
        if (!valueKey) {
          throw runtimeSourceError(`Component '${componentId}' is not a source`);
        }
        foundSource = true;
        return {
          ...component,
          properties: { ...component.properties, [valueKey]: value },
        };
      }),
    };
  });
  if (!foundCircuit) {
    throw runtimeSourceError(`Unknown circuit: ${circuitId}`);
  }
  if (!foundSource) {
    throw runtimeSourceError(`Unknown source component: ${componentId}`);
  }
  return { ...project, circuits };
}

function runtimeSourceError(message: string): HierarchyRuntimeError {
  return new HierarchyRuntimeError({
    name: "SimulationError",
    code: "INVALID_SOURCE_UPDATE",
    message,
    diagnostics: [],
  });
}

function normalizeProject(project: EditableProjectDocument): ProjectDocumentV3 {
  return project.version === 3
    ? cloneProject(project)
    : migrateV2ToV3(project);
}

function cloneProject(project: ProjectDocumentV3): ProjectDocumentV3 {
  return structuredClone(project);
}
