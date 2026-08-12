import { createStore, type StoreApi } from "zustand/vanilla";
import type { EditorComponent } from "../editor/circuit-document";
import type {
  ProjectModuleInterfaceResolver,
  ProjectPortResolver,
  ResolvedProjectPort,
} from "../wasm-client";
import {
  type ProjectCircuitV3,
  type ProjectDocumentV3,
  type ProjectWire,
  type WireEndpoint,
} from "./project-v3";
import { assertKnownWord } from "./signal-shape";

export interface ProjectPathEntry {
  circuitId: string;
  instanceId?: string;
}

export interface ProjectSelection {
  componentIds: string[];
  wireIds: string[];
}

export interface ProjectStorePortResolver {
  resolvePorts: ProjectPortResolver;
  resolveModuleInterfaces: ProjectModuleInterfaceResolver;
}

export interface ProjectStoreOptions {
  portResolver?: ProjectStorePortResolver;
  /** Called only after all edit validation succeeds and before the store commits. */
  applyProject?: (project: ProjectDocumentV3) => void;
}

export type ProjectEditErrorCode =
  | "DUPLICATE_COMPONENT"
  | "DUPLICATE_WIRE"
  | "INVALID_WORD"
  | "PORT_RESOLVER_UNAVAILABLE"
  | "UNKNOWN_COMPONENT"
  | "UNKNOWN_PORT"
  | "WIDTH_MISMATCH"
  | string;

export class ProjectEditError extends Error {
  readonly code: ProjectEditErrorCode;

  constructor(code: ProjectEditErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectEditError";
    this.code = code;
  }
}

export interface ProjectEditorState {
  past: ProjectDocumentV3[];
  project: ProjectDocumentV3;
  future: ProjectDocumentV3[];
  activePath: ProjectPathEntry[];
  selectionByCircuit: Record<string, ProjectSelection>;
  structureRevision: number;
  valueRevision: number;
  setPortResolver: (resolver: ProjectStorePortResolver) => void;
  setApplyProject: (
    applyProject: ((project: ProjectDocumentV3) => void) | undefined,
  ) => void;
  resolveComponentPorts: (
    circuitId: string,
    componentId: string,
  ) => ResolvedProjectPort[];
  resolveProjectModuleInterfaces: () => ReturnType<ProjectModuleInterfaceResolver>;
  setCircuit: (
    circuitId: string,
    update: Pick<ProjectCircuitV3, "components" | "wires"> & {
      viewport?: ProjectCircuitV3["viewport"];
    },
  ) => void;
  replaceProject: (project: ProjectDocumentV3) => void;
  openCircuit: (circuitId: string) => void;
  createModule: (name: string) => string;
  renameModule: (circuitId: string, name: string) => void;
  deleteModule: (circuitId: string) => void;
  addComponent: (circuitId: string, component: EditorComponent) => void;
  addWire: (circuitId: string, wire: ProjectWire) => void;
  setComponentProperties: (
    circuitId: string,
    componentId: string,
    properties: Record<string, unknown>,
  ) => void;
  deleteModulePort: (circuitId: string, componentId: string) => void;
  renameModulePort: (
    circuitId: string,
    componentId: string,
    label: string,
  ) => void;
  setSource: (circuitId: string, componentId: string, value: string) => void;
  setViewport: (
    circuitId: string,
    viewport: { x: number; y: number; zoom: number },
  ) => void;
  setSelection: (
    circuitId: string,
    componentIds: string[],
    wireIds: string[],
  ) => void;
  enterInstance: (parentCircuitId: string, instanceId: string) => void;
  navigateToDepth: (depth: number) => void;
  undo: () => void;
  redo: () => void;
}

export function createProjectStore(
  initialProject: ProjectDocumentV3,
  options: ProjectStoreOptions = {},
): StoreApi<ProjectEditorState> {
  let portResolver = options.portResolver;
  let applyProject = options.applyProject;
  const portShapeCache = new Map<string, ResolvedProjectPort[]>();
  let interfaceCache:
    | {
        key: string;
        value: ReturnType<ProjectModuleInterfaceResolver>;
      }
    | undefined;

  return createStore<ProjectEditorState>((set, get) => {
    const requireResolver = (): ProjectStorePortResolver => {
      if (!portResolver) {
        throw new ProjectEditError(
          "PORT_RESOLVER_UNAVAILABLE",
          "Rust/WASM port resolver is not installed",
        );
      }
      return portResolver;
    };

    const resolvePorts = (
      typeId: string,
      properties: Record<string, unknown>,
    ): ResolvedProjectPort[] => {
      const key = `${typeId}\0${stableStringify(properties)}`;
      const cached = portShapeCache.get(key);
      if (cached) return cached.map((port) => ({ ...port }));
      try {
        const ports = requireResolver().resolvePorts(typeId, properties);
        portShapeCache.set(key, ports.map((port) => ({ ...port })));
        return ports.map((port) => ({ ...port }));
      } catch (error) {
        throw normalizeResolverError(error);
      }
    };

    const resolveInterfaces = (
      project: ProjectDocumentV3,
    ): ReturnType<ProjectModuleInterfaceResolver> => {
      const key = moduleInterfaceFingerprint(project);
      if (interfaceCache?.key === key) return structuredClone(interfaceCache.value);
      if (!project.circuits.some((circuit) => circuit.kind === "module")) {
        interfaceCache = { key, value: {} };
        return {};
      }
      try {
        const value = requireResolver().resolveModuleInterfaces(project);
        interfaceCache = { key, value: structuredClone(value) };
        return structuredClone(value);
      } catch (error) {
        throw normalizeResolverError(error);
      }
    };

    const resolveEndpoint = (
      project: ProjectDocumentV3,
      circuit: ProjectCircuitV3,
      endpoint: WireEndpoint,
      interfaces?: ReturnType<ProjectModuleInterfaceResolver>,
    ): { component: EditorComponent; port: ResolvedProjectPort } => {
      const component = circuit.components.find(
        (item) => item.id === endpoint.componentId,
      );
      if (!component) {
        throw new ProjectEditError(
          "UNKNOWN_COMPONENT",
          `Wire endpoint references missing component '${endpoint.componentId}'`,
        );
      }
      const ports =
        component.typeId === "project.module_instance"
          ? moduleInstancePorts(component, interfaces ?? resolveInterfaces(project))
          : resolvePorts(component.typeId, component.properties);
      const port = ports.find((item) => item.id === endpoint.portId);
      if (!port) {
        throw new ProjectEditError(
          "UNKNOWN_PORT",
          `Component '${endpoint.componentId}' has no resolved port '${endpoint.portId}'`,
        );
      }
      return { component, port };
    };

    const commit = (
      nextProject: ProjectDocumentV3,
      commitOptions: { applyRuntime?: boolean } = {},
    ): void => {
      const current = get().project;
      const normalized = cloneProject(nextProject);
      if (documentsEqual(current, normalized)) return;
      if (commitOptions.applyRuntime !== false) applyProject?.(cloneProject(normalized));
      const revisions = changedRevisions(current, normalized, get());
      set((state) => ({
        past: [...state.past, cloneProject(current)],
        project: normalized,
        future: [],
        selectionByCircuit: sanitizeSelections(
          state.selectionByCircuit,
          normalized,
        ),
        ...revisions,
      }));
    };

    const validateProjectSemantics = (project: ProjectDocumentV3): void => {
      requireResolver();
      try {
        let moduleInterfaces: ReturnType<ProjectModuleInterfaceResolver> | undefined;
        const portIndex = new Map<string, Map<string, ResolvedProjectPort>>();
        for (const circuit of project.circuits) {
          for (const component of circuit.components) {
            let ports: ResolvedProjectPort[];
            if (component.typeId === "project.module_instance") {
              moduleInterfaces ??= resolveInterfaces(project);
              const moduleId = component.properties.moduleId;
              if (
                typeof moduleId !== "string" ||
                !moduleInterfaces[moduleId]
              ) {
                throw new ProjectEditError(
                  "UNKNOWN_MODULE",
                  `Module instance '${component.id}' references an unknown module`,
                );
              }
              ports = moduleInterfaces[moduleId].map(
                ({ id, direction, width }) => ({ id, direction, width }),
              );
            } else {
              ports = resolvePorts(component.typeId, component.properties);
            }
            portIndex.set(
              componentPortIndexKey(circuit.id, component.id),
              new Map(ports.map((port) => [port.id, port])),
            );
          }
          for (const wire of circuit.wires) {
            const left = indexedPort(portIndex, circuit.id, wire.endpointA);
            const right = indexedPort(portIndex, circuit.id, wire.endpointB);
            if (left.width !== right.width) {
              throw new ProjectEditError(
                "WIDTH_MISMATCH",
                `Wire '${wire.id}' connects width ${left.width} to width ${right.width}`,
              );
            }
          }
        }
      } catch (error) {
        throw normalizeResolverError(error);
      }
    };

    const updateCircuit = (
      circuitId: string,
      update: (circuit: ProjectCircuitV3) => ProjectCircuitV3,
      validateSemantics = false,
    ): void => {
      const project = get().project;
      const index = project.circuits.findIndex((circuit) => circuit.id === circuitId);
      if (index < 0) throw new Error(`Unknown circuit: ${circuitId}`);
      const circuits = [...project.circuits];
      circuits[index] = update(circuits[index]);
      const next = cloneProject({ ...project, circuits });
      const semanticsChanged =
        semanticProjectFingerprint(project) !== semanticProjectFingerprint(next);
      if (validateSemantics && semanticsChanged && !applyProject) {
        validateProjectSemantics(next);
      }
      commit(next, {
        applyRuntime: semanticsChanged,
      });
    };

    return {
      past: [],
      project: cloneProject(initialProject),
      future: [],
      activePath: initialPath(initialProject),
      selectionByCircuit: {},
      structureRevision: 0,
      valueRevision: 0,
      setPortResolver: (resolver) => {
        portResolver = resolver;
        portShapeCache.clear();
        interfaceCache = undefined;
      },
      setApplyProject: (nextApplyProject) => {
        applyProject = nextApplyProject;
      },
      resolveComponentPorts: (circuitId, componentId) => {
        const project = get().project;
        const circuit = requireCircuit(project, circuitId);
        const component = circuit.components.find((item) => item.id === componentId);
        if (!component) {
          throw new ProjectEditError(
            "UNKNOWN_COMPONENT",
            `Unknown component: ${componentId}`,
          );
        }
        return component.typeId === "project.module_instance"
          ? moduleInstancePorts(component, resolveInterfaces(project))
          : resolvePorts(component.typeId, component.properties);
      },
      resolveProjectModuleInterfaces: () => resolveInterfaces(get().project),
      setCircuit: (circuitId, update) => {
        updateCircuit(
          circuitId,
          (circuit) => ({
            ...circuit,
            components: update.components.map(cloneComponent),
            wires: update.wires.map(normalizeWire),
            ...(update.viewport
              ? { viewport: { ...update.viewport } }
              : circuit.viewport
                ? { viewport: { ...circuit.viewport } }
                : {}),
          }),
          true,
        );
      },
      replaceProject: (project) => {
        const normalized = cloneProject(project);
        if (documentsEqual(get().project, normalized)) return;
        if (portResolver && !applyProject) validateProjectSemantics(normalized);
        commit(normalized);
        set({ activePath: initialPath(normalized), selectionByCircuit: {} });
      },
      openCircuit: (circuitId) => {
        const project = get().project;
        const circuit = requireCircuit(project, circuitId);
        set({
          activePath:
            circuit.kind === "main"
              ? [{ circuitId }]
              : [{ circuitId: project.rootCircuitId }, { circuitId }],
        });
      },
      createModule: (name) => {
        const trimmedName = name.trim();
        if (!trimmedName) throw new Error("Module name must not be empty");
        const project = get().project;
        const id = allocateModuleId(trimmedName, project);
        commit({
          ...project,
          circuits: [
            ...project.circuits,
            {
              id,
              name: trimmedName,
              kind: "module",
              components: [],
              wires: [],
            },
          ],
        });
        return id;
      },
      renameModule: (circuitId, name) => {
        const trimmedName = name.trim();
        if (!trimmedName) throw new Error("Module name must not be empty");
        updateCircuit(circuitId, (circuit) => ({ ...circuit, name: trimmedName }));
      },
      deleteModule: (circuitId) => {
        const project = get().project;
        const circuit = requireCircuit(project, circuitId);
        if (circuit.kind !== "module") throw new Error("The main circuit cannot be deleted");
        const references = project.circuits.flatMap((owner) =>
          owner.components
            .filter(
              (component) =>
                component.typeId === "project.module_instance" &&
                component.properties.moduleId === circuitId,
            )
            .map((component) => `${owner.id}/${component.id}`),
        );
        if (references.length > 0) {
          throw new Error(
            `Module '${circuitId}' is referenced (${references.length} 个引用): ${references.join(", ")}`,
          );
        }
        const next = {
          ...project,
          circuits: project.circuits.filter((item) => item.id !== circuitId),
        };
        commit(next);
        set({ activePath: sanitizePath(get().activePath, next) });
      },
      addComponent: (circuitId, component) => {
        if (component.typeId === "project.module_instance") {
          validateModuleInstance(get().project, circuitId, component);
          moduleInstancePorts(component, resolveInterfaces(get().project));
        } else if (portResolver) {
          resolvePorts(component.typeId, component.properties);
        }
        updateCircuit(
          circuitId,
          (circuit) => {
            if (circuit.components.some((item) => item.id === component.id)) {
              throw new ProjectEditError(
                "DUPLICATE_COMPONENT",
                `Duplicate component ID: ${component.id}`,
              );
            }
            return {
              ...circuit,
              components: [...circuit.components, cloneComponent(component)],
            };
          },
          false,
        );
      },
      addWire: (circuitId, wire) => {
        const project = get().project;
        const circuit = requireCircuit(project, circuitId);
        if (circuit.wires.some((item) => item.id === wire.id)) {
          throw new ProjectEditError("DUPLICATE_WIRE", `Duplicate wire ID: ${wire.id}`);
        }
        requireResolver();
        const endpointA = resolveEndpoint(
          project,
          circuit,
          wire.endpointA,
        );
        const endpointB = resolveEndpoint(
          project,
          circuit,
          wire.endpointB,
        );
        if (endpointA.port.width !== endpointB.port.width) {
          throw new ProjectEditError(
            "WIDTH_MISMATCH",
            `Wire '${wire.id}' connects width ${endpointA.port.width} to width ${endpointB.port.width}`,
          );
        }
        const normalized = normalizeWire(wire);
        updateCircuit(
          circuitId,
          (current) => ({
            ...current,
            wires: [...current.wires, normalized],
          }),
          false,
        );
      },
      setComponentProperties: (circuitId, componentId, properties) => {
        const project = get().project;
        const circuit = requireCircuit(project, circuitId);
        const component = circuit.components.find((item) => item.id === componentId);
        if (!component) {
          throw new ProjectEditError(
            "UNKNOWN_COMPONENT",
            `Unknown component: ${componentId}`,
          );
        }
        const nextComponent = {
          ...component,
          properties: structuredClone(properties),
        };
        const nextProject = cloneProject({
          ...project,
          circuits: project.circuits.map((item) =>
            item.id === circuitId
              ? {
                  ...item,
                  components: item.components.map((candidate) =>
                    candidate.id === componentId ? nextComponent : candidate,
                  ),
                }
              : item,
          ),
        });
        const nextCircuit = requireCircuit(nextProject, circuitId);
        const nextPorts =
          nextComponent.typeId === "project.module_instance"
            ? moduleInstancePorts(nextComponent, resolveInterfaces(nextProject))
            : resolvePorts(nextComponent.typeId, nextComponent.properties);
        for (const wire of nextCircuit.wires.filter((candidate) =>
          wireUsesComponent(candidate, componentId),
        )) {
          const editedEndpoint =
            wire.endpointA.componentId === componentId
              ? wire.endpointA
              : wire.endpointB;
          const peerEndpoint =
            editedEndpoint === wire.endpointA ? wire.endpointB : wire.endpointA;
          const editedPort = nextPorts.find(
            (port) => port.id === editedEndpoint.portId,
          );
          if (!editedPort) {
            throw new ProjectEditError(
              "UNKNOWN_PORT",
              `Component '${componentId}' has no resolved port '${editedEndpoint.portId}'`,
            );
          }
          const peer = resolveEndpoint(nextProject, nextCircuit, peerEndpoint);
          if (editedPort.width !== peer.port.width) {
            throw new ProjectEditError(
              "WIDTH_MISMATCH",
              `Wire '${wire.id}' connects width ${editedPort.width} to width ${peer.port.width}`,
            );
          }
        }
        updateCircuit(
          circuitId,
          (circuit) => {
            return {
              ...circuit,
              components: circuit.components.map((component) =>
                component.id === componentId
                  ? { ...component, properties: structuredClone(properties) }
                  : component,
              ),
            };
          },
          false,
        );
      },
      deleteModulePort: (circuitId, componentId) => {
        const project = get().project;
        const circuit = requireCircuit(project, circuitId);
        const boundary = circuit.components.find(
          (component) => component.id === componentId,
        );
        if (!boundary || !isBoundary(boundary)) {
          throw new Error(`Unknown module port component: ${componentId}`);
        }
        const portId = String(boundary.properties.portId ?? "");
        const usageLocations = circuit.wires
          .filter((wire) => wireUsesComponent(wire, componentId))
          .map((wire) => `${circuit.id}/${wire.id}`);
        for (const owner of project.circuits) {
          const instanceIds = new Set(
            owner.components
              .filter(
                (component) =>
                  component.typeId === "project.module_instance" &&
                  component.properties.moduleId === circuitId,
              )
              .map((component) => component.id),
          );
          usageLocations.push(
            ...owner.wires
              .filter((wire) => wireUsesInstancePort(wire, instanceIds, portId))
              .map((wire) => `${owner.id}/${wire.id}`),
          );
        }
        if (usageLocations.length > 0) {
          throw new Error(
            `Module port '${portId}' is connected at ${usageLocations.join(", ")}`,
          );
        }
        updateCircuit(circuitId, (current) => ({
          ...current,
          components: current.components.filter(
            (component) => component.id !== componentId,
          ),
        }));
      },
      renameModulePort: (circuitId, componentId, label) => {
        const nextLabel = label.trim();
        if (!nextLabel) throw new Error("Module port label must not be empty");
        const target = requireCircuit(get().project, circuitId).components.find(
          (component) => component.id === componentId && isBoundary(component),
        );
        if (!target) throw new Error(`Unknown module port component: ${componentId}`);
        updateCircuit(circuitId, (circuit) => ({
          ...circuit,
          components: circuit.components.map((component) =>
            component.id === componentId && isBoundary(component)
              ? {
                  ...component,
                  properties: { ...component.properties, label: nextLabel },
                }
              : component,
          ),
        }));
      },
      setSource: (circuitId, componentId, value) => {
        const project = get().project;
        const circuit = requireCircuit(project, circuitId);
        const component = circuit.components.find((item) => item.id === componentId);
        if (!component) throw new Error(`Unknown source component: ${componentId}`);
        const valueKey =
          component.typeId === "project.module_input"
            ? "previewValue"
            : component.typeId === "source.trit_input" ||
                component.typeId === "source.constant"
              ? "value"
              : null;
        if (!valueKey) throw new Error(`Component '${componentId}' is not a source`);
        let ports: ResolvedProjectPort[];
        try {
          ports = resolvePorts(component.typeId, component.properties);
        } catch (error) {
          throw normalizeResolverError(error);
        }
        const output = ports.find((port) => port.direction !== "input");
        if (!output) {
          throw new ProjectEditError(
            "UNKNOWN_PORT",
            `Source component '${componentId}' has no resolved output port`,
          );
        }
        try {
          assertKnownWord(value, output.width);
        } catch (error) {
          throw new ProjectEditError("INVALID_WORD", String((error as Error).message), {
            cause: error,
          });
        }
        updateCircuit(circuitId, (current) => ({
          ...current,
          components: current.components.map((item) =>
            item.id === componentId
              ? {
                  ...item,
                  properties: { ...item.properties, [valueKey]: value },
                }
              : item,
          ),
        }));
      },
      setViewport: (circuitId, viewport) => {
        if (
          !Number.isFinite(viewport.x) ||
          !Number.isFinite(viewport.y) ||
          !Number.isFinite(viewport.zoom) ||
          viewport.zoom <= 0
        ) {
          throw new Error("Viewport must contain finite coordinates and positive zoom");
        }
        const project = get().project;
        requireCircuit(project, circuitId);
        set({
          project: {
            ...project,
            circuits: project.circuits.map((circuit) =>
              circuit.id === circuitId
                ? { ...circuit, viewport: { ...viewport } }
                : circuit,
            ),
          },
        });
      },
      setSelection: (circuitId, componentIds, wireIds) => {
        requireCircuit(get().project, circuitId);
        set((state) => ({
          selectionByCircuit: {
            ...state.selectionByCircuit,
            [circuitId]: {
              componentIds: [...componentIds],
              wireIds: [...wireIds],
            },
          },
        }));
      },
      enterInstance: (parentCircuitId, instanceId) => {
        const state = get();
        const active = state.activePath.at(-1);
        if (active?.circuitId !== parentCircuitId) {
          throw new Error(`Circuit '${parentCircuitId}' is not active`);
        }
        const parent = requireCircuit(state.project, parentCircuitId);
        const instance = parent.components.find(
          (component) =>
            component.id === instanceId &&
            component.typeId === "project.module_instance",
        );
        const moduleId = instance?.properties.moduleId;
        if (typeof moduleId !== "string") {
          throw new Error(`Unknown module instance: ${instanceId}`);
        }
        const target = requireCircuit(state.project, moduleId);
        if (target.kind !== "module") {
          throw new Error(`Instance '${instanceId}' does not reference a module`);
        }
        set({
          activePath: [
            ...state.activePath,
            { circuitId: moduleId, instanceId },
          ],
        });
      },
      navigateToDepth: (depth) => {
        const path = get().activePath;
        if (!Number.isInteger(depth) || depth < 0 || depth >= path.length) {
          throw new Error(`Invalid hierarchy depth: ${depth}`);
        }
        set({ activePath: path.slice(0, depth + 1) });
      },
      undo: () => {
        const state = get();
        const previous = state.past.at(-1);
        if (!previous) return;
        const project = mergeCurrentViewports(cloneProject(previous), state.project);
        applyProject?.(cloneProject(project));
        set({
          past: state.past.slice(0, -1),
          project,
          future: [cloneProject(state.project), ...state.future],
          activePath: sanitizePath(state.activePath, project),
          selectionByCircuit: sanitizeSelections(state.selectionByCircuit, project),
          ...changedRevisions(state.project, project, state),
        });
      },
      redo: () => {
        const state = get();
        const next = state.future[0];
        if (!next) return;
        const project = mergeCurrentViewports(cloneProject(next), state.project);
        applyProject?.(cloneProject(project));
        set({
          past: [...state.past, cloneProject(state.project)],
          project,
          future: state.future.slice(1),
          activePath: sanitizePath(state.activePath, project),
          selectionByCircuit: sanitizeSelections(state.selectionByCircuit, project),
          ...changedRevisions(state.project, project, state),
        });
      },
    };
  });
}

function normalizeResolverError(error: unknown): ProjectEditError {
  if (error instanceof ProjectEditError) return error;
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "PORT_RESOLUTION_FAILED";
  const message = error instanceof Error ? error.message : String(error);
  return new ProjectEditError(code, message, { cause: error });
}

function componentPortIndexKey(circuitId: string, componentId: string): string {
  return `${circuitId}\0${componentId}`;
}

function indexedPort(
  index: ReadonlyMap<string, ReadonlyMap<string, ResolvedProjectPort>>,
  circuitId: string,
  endpoint: WireEndpoint,
): ResolvedProjectPort {
  const ports = index.get(componentPortIndexKey(circuitId, endpoint.componentId));
  if (!ports) {
    throw new ProjectEditError(
      "UNKNOWN_COMPONENT",
      `Wire endpoint references missing component '${endpoint.componentId}'`,
    );
  }
  const port = ports.get(endpoint.portId);
  if (!port) {
    throw new ProjectEditError(
      "UNKNOWN_PORT",
      `Component '${endpoint.componentId}' has no resolved port '${endpoint.portId}'`,
    );
  }
  return port;
}

function moduleInstancePorts(
  component: EditorComponent,
  interfaces: ReturnType<ProjectModuleInterfaceResolver>,
): ResolvedProjectPort[] {
  const moduleId = component.properties.moduleId;
  if (typeof moduleId !== "string" || !interfaces[moduleId]) {
    throw new ProjectEditError(
      "UNKNOWN_MODULE",
      `Module instance '${component.id}' references an unknown module`,
    );
  }
  return interfaces[moduleId].map(({ id, direction, width }) => ({
    id,
    direction,
    width,
  }));
}

export function normalizeWire(wire: ProjectWire): ProjectWire {
  const left = endpointSortKey(wire.endpointA);
  const right = endpointSortKey(wire.endpointB);
  return left <= right
    ? cloneWire(wire)
    : {
        id: wire.id,
        endpointA: { ...wire.endpointB },
        endpointB: { ...wire.endpointA },
      };
}

function endpointSortKey(endpoint: WireEndpoint): string {
  return `${endpoint.componentId}\0${endpoint.portId}`;
}

function wireUsesComponent(wire: ProjectWire, componentId: string): boolean {
  return (
    wire.endpointA.componentId === componentId ||
    wire.endpointB.componentId === componentId
  );
}

function wireUsesInstancePort(
  wire: ProjectWire,
  instanceIds: ReadonlySet<string>,
  portId: string,
): boolean {
  return [wire.endpointA, wire.endpointB].some(
    (endpoint) =>
      instanceIds.has(endpoint.componentId) && endpoint.portId === portId,
  );
}

function initialPath(project: ProjectDocumentV3): ProjectPathEntry[] {
  return [{ circuitId: project.rootCircuitId }];
}

function sanitizePath(
  path: ProjectPathEntry[],
  project: ProjectDocumentV3,
): ProjectPathEntry[] {
  const root = project.circuits.find(
    (circuit) => circuit.id === project.rootCircuitId && circuit.kind === "main",
  );
  if (!root) return initialPath(project);
  const valid: ProjectPathEntry[] = [{ circuitId: root.id }];
  for (const entry of path.slice(1)) {
    const target = project.circuits.find((item) => item.id === entry.circuitId);
    if (!entry.instanceId) {
      if (valid.length === 1 && target?.kind === "module") {
        valid.push({ circuitId: entry.circuitId });
      }
      continue;
    }
    const parent = requireCircuit(project, valid.at(-1)!.circuitId);
    const instance = parent.components.find(
      (component) =>
        component.id === entry.instanceId &&
        component.typeId === "project.module_instance" &&
        component.properties.moduleId === entry.circuitId,
    );
    if (!instance || !target) {
      break;
    }
    valid.push({ circuitId: entry.circuitId, instanceId: entry.instanceId });
  }
  return valid;
}

function allocateModuleId(name: string, project: ProjectDocumentV3): string {
  const stem =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "module";
  const used = new Set(project.circuits.map((circuit) => circuit.id));
  let suffix = 1;
  while (used.has(`${stem}-${suffix}`)) suffix += 1;
  return `${stem}-${suffix}`;
}

function requireCircuit(
  project: ProjectDocumentV3,
  circuitId: string,
): ProjectCircuitV3 {
  const circuit = project.circuits.find((item) => item.id === circuitId);
  if (!circuit) throw new Error(`Unknown circuit: ${circuitId}`);
  return circuit;
}

function isBoundary(component: EditorComponent): boolean {
  return (
    component.typeId === "project.module_input" ||
    component.typeId === "project.module_output"
  );
}

function validateModuleInstance(
  project: ProjectDocumentV3,
  ownerCircuitId: string,
  component: EditorComponent,
): void {
  const owner = requireCircuit(project, ownerCircuitId);
  const moduleId = component.properties.moduleId;
  if (typeof moduleId !== "string") {
    throw new Error("Module instance must reference a module");
  }
  const target = project.circuits.find((circuit) => circuit.id === moduleId);
  if (!target || target.kind !== "module") throw new Error(`Unknown module: ${moduleId}`);
  if (owner.kind === "module" && reachesCircuit(project, moduleId, ownerCircuitId)) {
    throw new Error(
      `Module instance '${component.id}' would create a dependency cycle`,
    );
  }
}

function reachesCircuit(
  project: ProjectDocumentV3,
  start: string,
  target: string,
): boolean {
  const circuitsById = new Map(
    project.circuits.map((circuit) => [circuit.id, circuit]),
  );
  const pending = [start];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const currentId = pending.pop()!;
    if (currentId === target) return true;
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    const current = circuitsById.get(currentId);
    for (const instance of current?.components ?? []) {
      if (
        instance.typeId === "project.module_instance" &&
        typeof instance.properties.moduleId === "string"
      ) {
        pending.push(instance.properties.moduleId);
      }
    }
  }
  return false;
}

function mergeCurrentViewports(
  restored: ProjectDocumentV3,
  current: ProjectDocumentV3,
): ProjectDocumentV3 {
  const currentById = new Map(
    current.circuits.map((circuit) => [circuit.id, circuit]),
  );
  return {
    ...restored,
    circuits: restored.circuits.map((circuit) => {
      const currentCircuit = currentById.get(circuit.id);
      if (!currentCircuit) return circuit;
      const { viewport: _restoredViewport, ...withoutViewport } = circuit;
      const viewport = currentCircuit.viewport;
      return {
        ...withoutViewport,
        ...(viewport ? { viewport: { ...viewport } } : {}),
      };
    }),
  };
}

function cloneComponent(component: EditorComponent): EditorComponent {
  return {
    ...component,
    position: { ...component.position },
    properties: structuredClone(component.properties),
  };
}

function cloneWire(wire: ProjectWire): ProjectWire {
  return {
    id: wire.id,
    endpointA: { ...wire.endpointA },
    endpointB: { ...wire.endpointB },
  };
}

function cloneProject(project: ProjectDocumentV3): ProjectDocumentV3 {
  return {
    ...project,
    circuits: project.circuits.map((circuit) => ({
      ...circuit,
      components: circuit.components.map(cloneComponent),
      wires: circuit.wires.map(normalizeWire),
      ...(circuit.viewport ? { viewport: { ...circuit.viewport } } : {}),
    })),
  };
}

function sanitizeSelections(
  selections: Record<string, ProjectSelection>,
  project: ProjectDocumentV3,
): Record<string, ProjectSelection> {
  const sanitized: Record<string, ProjectSelection> = {};
  for (const circuit of project.circuits) {
    const selection = selections[circuit.id];
    if (!selection) continue;
    const componentIds = new Set(circuit.components.map((component) => component.id));
    const wireIds = new Set(circuit.wires.map((wire) => wire.id));
    sanitized[circuit.id] = {
      componentIds: selection.componentIds.filter((id) => componentIds.has(id)),
      wireIds: selection.wireIds.filter((id) => wireIds.has(id)),
    };
  }
  return sanitized;
}

function semanticProjectFingerprint(project: ProjectDocumentV3): string {
  return stableStringify({
    ...project,
    circuits: project.circuits.map(({ viewport: _viewport, ...circuit }) => ({
      ...circuit,
      components: circuit.components.map(
        ({ position: _position, rotation: _rotation, ...component }) => component,
      ),
    })),
  });
}

function moduleInterfaceFingerprint(project: ProjectDocumentV3): string {
  return stableStringify(
    project.circuits.map((circuit) => ({
      id: circuit.id,
      kind: circuit.kind,
      components: circuit.components
        .filter(
          (component) =>
            isBoundary(component) ||
            component.typeId === "project.module_instance",
        )
        .map((component) => ({
          id: component.id,
          typeId: component.typeId,
          properties: component.properties,
        })),
    })),
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

function documentsEqual(
  left: ProjectDocumentV3,
  right: ProjectDocumentV3,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changedRevisions(
  previous: ProjectDocumentV3,
  next: ProjectDocumentV3,
  state: Pick<ProjectEditorState, "structureRevision" | "valueRevision">,
): Pick<ProjectEditorState, "structureRevision" | "valueRevision"> {
  const structureChanged =
    structureFingerprint(previous) !== structureFingerprint(next);
  const valueChanged =
    !structureChanged && valueFingerprint(previous) !== valueFingerprint(next);
  return {
    structureRevision: state.structureRevision + (structureChanged ? 1 : 0),
    valueRevision: state.valueRevision + (valueChanged ? 1 : 0),
  };
}

function structureFingerprint(project: ProjectDocumentV3): string {
  return JSON.stringify({
    ...project,
    circuits: project.circuits.map(({ viewport: _viewport, ...circuit }) => ({
      ...circuit,
      components: circuit.components.map(({ rotation: _rotation, ...component }) => ({
        ...component,
        properties: Object.fromEntries(
          Object.entries(component.properties).filter(
            ([key]) => key !== "value" && key !== "previewValue",
          ),
        ),
      })),
    })),
  });
}

function valueFingerprint(project: ProjectDocumentV3): string {
  return JSON.stringify(
    project.circuits.map((circuit) => [
      circuit.id,
      circuit.components.map((component) => [
        component.id,
        component.properties.value,
        component.properties.previewValue,
      ]),
    ]),
  );
}
