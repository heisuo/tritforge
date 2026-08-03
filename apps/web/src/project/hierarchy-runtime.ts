import type {
  KnownTrit,
  ProjectSimulationSnapshot,
} from "../editor-model";
import {
  wasmProjectError,
  type WasmProjectError,
  type WasmProjectSimulatorBinding,
} from "../wasm-client";
import type {
  ProjectCircuit,
  ProjectDocumentV2,
} from "./project-document";

export interface RuntimeProjectDocument {
  format: "logsim-ternary";
  version: 2;
  rootCircuitId: string;
  circuits: RuntimeProjectCircuit[];
}

export interface RuntimeProjectCircuit {
  id: string;
  name: string;
  kind: "main" | "module";
  components: RuntimeProjectComponent[];
  connections: ProjectCircuit["connections"];
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
  private project: ProjectDocumentV2 | null = null;
  private activeCircuitId: string | null = null;
  private reachableCircuits = new Set<string>();
  private wasmProjectSynchronized = false;
  private projectValid = false;
  private currentSnapshot: ProjectSimulationSnapshot | null = null;

  constructor(private readonly wasm: WasmProjectSimulatorBinding) {}

  load(
    project: ProjectDocumentV2,
    activeCircuitId: string,
  ): ProjectSimulationSnapshot {
    try {
      const snapshot = this.wasm.loadProject(
        toRuntimeProject(project),
        activeCircuitId,
      );
      this.project = cloneProject(project);
      this.activeCircuitId = activeCircuitId;
      this.reachableCircuits = reachableFrom(project, activeCircuitId);
      this.wasmProjectSynchronized = true;
      this.projectValid = true;
      this.currentSnapshot = snapshot;
      return snapshot;
    } catch (error) {
      throw new HierarchyRuntimeError(wasmProjectError(error));
    }
  }

  updateProject(project: ProjectDocumentV2): ProjectSimulationSnapshot {
    this.requireLoaded();
    this.project = cloneProject(project);
    this.reachableCircuits = reachableFrom(project, this.activeCircuitId!);
    try {
      const snapshot = this.wasm.updateProject(toRuntimeProject(project));
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
    value: KnownTrit,
  ): ProjectSimulationSnapshot | null {
    const project = this.requireLoaded();
    if (!this.projectValid) {
      throw runtimeSourceError(
        "project simulation is unavailable until validation succeeds",
      );
    }
    if (value !== "T" && value !== "0" && value !== "1") {
      throw runtimeSourceError(`'${String(value)}' is not a known ternary source value`);
    }
    const nextProject = withSourceValue(project, circuitId, componentId, value);
    if (!this.reachableCircuits.has(circuitId)) {
      this.project = nextProject;
      this.wasmProjectSynchronized = false;
      return this.currentSnapshot;
    }
    try {
      const snapshot = this.wasm.setSource(circuitId, componentId, value);
      this.project = nextProject;
      this.currentSnapshot = snapshot;
      return snapshot;
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
      this.reachableCircuits = reachableFrom(project, activeCircuitId);
      this.currentSnapshot = snapshot;
      return snapshot;
    } catch (error) {
      throw new HierarchyRuntimeError(wasmProjectError(error));
    }
  }

  snapshot(): ProjectSimulationSnapshot | null {
    return this.currentSnapshot;
  }

  private requireLoaded(): ProjectDocumentV2 {
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
  project: ProjectDocumentV2,
): RuntimeProjectDocument {
  return {
    format: project.format,
    version: project.version,
    rootCircuitId: project.rootCircuitId,
    circuits: project.circuits.map((circuit) => {
      const boundaries = circuit.components
        .filter(isBoundary)
        .slice()
        .sort(
          (left, right) =>
            left.position.y - right.position.y || left.id.localeCompare(right.id),
        );
      const ordinary = circuit.components.filter(
        (component) => !isBoundary(component),
      );
      return {
        id: circuit.id,
        name: circuit.name,
        kind: circuit.kind,
        components: (circuit.kind === "module"
          ? [...boundaries, ...ordinary]
          : circuit.components
        ).map((component) => ({
          id: component.id,
          typeId: component.typeId,
          properties: runtimeProperties(component.typeId, component.properties),
        })),
        connections: circuit.connections.map((connection) => ({ ...connection })),
      };
    }),
  };
}

function runtimeProperties(
  typeId: string,
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const cloned = structuredClone(properties);
  if (!typeId.startsWith("project.")) {
    delete cloned.label;
  }
  return cloned;
}

function isBoundary(component: ProjectCircuit["components"][number]): boolean {
  return (
    component.typeId === "project.module_input" ||
    component.typeId === "project.module_output"
  );
}

function reachableFrom(
  project: ProjectDocumentV2,
  activeCircuitId: string,
): Set<string> {
  const circuits = new Map(
    project.circuits.map((circuit) => [circuit.id, circuit]),
  );
  const reachable = new Set<string>();
  const pending = [activeCircuitId];
  while (pending.length > 0) {
    const circuitId = pending.pop()!;
    if (reachable.has(circuitId)) {
      continue;
    }
    reachable.add(circuitId);
    for (const component of circuits.get(circuitId)?.components ?? []) {
      const moduleId = component.properties.moduleId;
      if (
        component.typeId === "project.module_instance" &&
        typeof moduleId === "string"
      ) {
        pending.push(moduleId);
      }
    }
  }
  return reachable;
}

function withSourceValue(
  project: ProjectDocumentV2,
  circuitId: string,
  componentId: string,
  value: KnownTrit,
): ProjectDocumentV2 {
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

function cloneProject(project: ProjectDocumentV2): ProjectDocumentV2 {
  return structuredClone(project);
}
