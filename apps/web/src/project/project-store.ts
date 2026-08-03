import { createStore, type StoreApi } from "zustand/vanilla";
import type { KnownTrit } from "../editor-model";
import type {
  EditorComponent,
  EditorConnection,
} from "../editor/circuit-document";
import type {
  ProjectCircuit,
  ProjectDocumentV2,
} from "./project-document";

export interface ProjectPathEntry {
  circuitId: string;
  instanceId?: string;
}

export interface ProjectSelection {
  componentIds: string[];
  connectionIds: string[];
}

export interface ProjectEditorState {
  past: ProjectDocumentV2[];
  project: ProjectDocumentV2;
  future: ProjectDocumentV2[];
  activePath: ProjectPathEntry[];
  selectionByCircuit: Record<string, ProjectSelection>;
  structureRevision: number;
  valueRevision: number;
  setCircuit: (
    circuitId: string,
    update: Pick<ProjectCircuit, "components" | "connections"> & {
      viewport?: ProjectCircuit["viewport"];
    },
  ) => void;
  replaceProject: (project: ProjectDocumentV2) => void;
  openCircuit: (circuitId: string) => void;
  createModule: (name: string) => string;
  renameModule: (circuitId: string, name: string) => void;
  deleteModule: (circuitId: string) => void;
  addComponent: (circuitId: string, component: EditorComponent) => void;
  addConnection: (circuitId: string, connection: EditorConnection) => void;
  deleteModulePort: (circuitId: string, componentId: string) => void;
  renameModulePort: (
    circuitId: string,
    componentId: string,
    label: string,
  ) => void;
  setSource: (
    circuitId: string,
    componentId: string,
    value: KnownTrit,
  ) => void;
  setViewport: (
    circuitId: string,
    viewport: { x: number; y: number; zoom: number },
  ) => void;
  setSelection: (
    circuitId: string,
    componentIds: string[],
    connectionIds: string[],
  ) => void;
  enterInstance: (parentCircuitId: string, instanceId: string) => void;
  navigateToDepth: (depth: number) => void;
  undo: () => void;
  redo: () => void;
}

export function createProjectStore(
  initialProject: ProjectDocumentV2,
): StoreApi<ProjectEditorState> {
  return createStore<ProjectEditorState>((set, get) => {
    const commit = (nextProject: ProjectDocumentV2): void => {
      const current = get().project;
      if (documentsEqual(current, nextProject)) {
        return;
      }
      const revisions = changedRevisions(current, nextProject, get());
      set((state) => ({
        past: [...state.past, cloneProject(current)],
        project: cloneProject(nextProject),
        future: [],
        ...revisions,
      }));
    };

    const updateCircuit = (
      circuitId: string,
      update: (circuit: ProjectCircuit) => ProjectCircuit,
    ): void => {
      const project = get().project;
      const index = project.circuits.findIndex((circuit) => circuit.id === circuitId);
      if (index < 0) {
        throw new Error(`Unknown circuit: ${circuitId}`);
      }
      const circuits = [...project.circuits];
      circuits[index] = update(circuits[index]);
      commit({ ...project, circuits });
    };

    return {
      past: [],
      project: cloneProject(initialProject),
      future: [],
      activePath: initialPath(initialProject),
      selectionByCircuit: {},
      structureRevision: 0,
      valueRevision: 0,
      setCircuit: (circuitId, update) => {
        updateCircuit(circuitId, (circuit) => ({
          ...circuit,
          components: update.components.map(cloneComponent),
          connections: update.connections.map((connection) => ({ ...connection })),
          ...(update.viewport
            ? { viewport: { ...update.viewport } }
            : circuit.viewport
              ? { viewport: { ...circuit.viewport } }
              : {}),
        }));
      },
      replaceProject: (project) => {
        commit(project);
        set({
          activePath: initialPath(project),
          selectionByCircuit: {},
        });
      },
      openCircuit: (circuitId) => {
        const project = get().project;
        const circuit = requireCircuit(project, circuitId);
        set({
          activePath:
            circuit.kind === "main"
              ? [{ circuitId }]
              : [
                  { circuitId: project.rootCircuitId },
                  { circuitId },
                ],
        });
      },
      createModule: (name) => {
        const trimmedName = name.trim();
        if (!trimmedName) {
          throw new Error("Module name must not be empty");
        }
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
              connections: [],
            },
          ],
        });
        return id;
      },
      renameModule: (circuitId, name) => {
        const trimmedName = name.trim();
        if (!trimmedName) {
          throw new Error("Module name must not be empty");
        }
        updateCircuit(circuitId, (circuit) => ({ ...circuit, name: trimmedName }));
      },
      deleteModule: (circuitId) => {
        const project = get().project;
        const circuit = requireCircuit(project, circuitId);
        if (circuit.kind !== "module") {
          throw new Error("The main circuit cannot be deleted");
        }
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
        }
        updateCircuit(circuitId, (circuit) => {
          if (circuit.components.some((item) => item.id === component.id)) {
            throw new Error(`Duplicate component ID: ${component.id}`);
          }
          return {
            ...circuit,
            components: [...circuit.components, cloneComponent(component)],
          };
        });
      },
      addConnection: (circuitId, connection) => {
        updateCircuit(circuitId, (circuit) => {
          if (circuit.connections.some((item) => item.id === connection.id)) {
            throw new Error(`Duplicate connection ID: ${connection.id}`);
          }
          const componentIds = new Set(
            circuit.components.map((component) => component.id),
          );
          if (
            !componentIds.has(connection.sourceComponentId) ||
            !componentIds.has(connection.targetComponentId)
          ) {
            throw new Error("Connection references a missing component");
          }
          return {
            ...circuit,
            connections: [...circuit.connections, { ...connection }],
          };
        });
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
        const usageLocations = circuit.connections
          .filter(
            (connection) =>
              connection.sourceComponentId === componentId ||
              connection.targetComponentId === componentId,
          )
          .map((connection) => `${circuit.id}/${connection.id}`);
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
            ...owner.connections
              .filter(
                (connection) =>
                  (instanceIds.has(connection.sourceComponentId) &&
                    connection.sourcePortId === portId) ||
                  (instanceIds.has(connection.targetComponentId) &&
                    connection.targetPortId === portId),
              )
              .map((connection) => `${owner.id}/${connection.id}`),
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
        if (!nextLabel) {
          throw new Error("Module port label must not be empty");
        }
        const target = requireCircuit(get().project, circuitId).components.find(
          (component) => component.id === componentId && isBoundary(component),
        );
        if (!target) {
          throw new Error(`Unknown module port component: ${componentId}`);
        }
        updateCircuit(circuitId, (circuit) => ({
          ...circuit,
          components: circuit.components.map((component) => {
            if (component.id !== componentId || !isBoundary(component)) {
              return component;
            }
            return {
              ...component,
              properties: { ...component.properties, label: nextLabel },
            };
          }),
        }));
      },
      setSource: (circuitId, componentId, value) => {
        updateCircuit(circuitId, (circuit) => {
          let found = false;
          const components = circuit.components.map((component) => {
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
              throw new Error(`Component '${componentId}' is not a source`);
            }
            found = true;
            return {
              ...component,
              properties: { ...component.properties, [valueKey]: value },
            };
          });
          if (!found) {
            throw new Error(`Unknown source component: ${componentId}`);
          }
          return { ...circuit, components };
        });
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
      setSelection: (circuitId, componentIds, connectionIds) => {
        requireCircuit(get().project, circuitId);
        set((state) => ({
          selectionByCircuit: {
            ...state.selectionByCircuit,
            [circuitId]: {
              componentIds: [...componentIds],
              connectionIds: [...connectionIds],
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
        if (!previous) {
          return;
        }
        const project = mergeCurrentViewports(cloneProject(previous), state.project);
        set({
          past: state.past.slice(0, -1),
          project,
          future: [cloneProject(state.project), ...state.future],
          activePath: sanitizePath(state.activePath, project),
          ...changedRevisions(state.project, project, state),
        });
      },
      redo: () => {
        const state = get();
        const next = state.future[0];
        if (!next) {
          return;
        }
        const project = mergeCurrentViewports(cloneProject(next), state.project);
        set({
          past: [...state.past, cloneProject(state.project)],
          project,
          future: state.future.slice(1),
          activePath: sanitizePath(state.activePath, project),
          ...changedRevisions(state.project, project, state),
        });
      },
    };
  });
}

function initialPath(project: ProjectDocumentV2): ProjectPathEntry[] {
  return [{ circuitId: project.rootCircuitId }];
}

function sanitizePath(
  path: ProjectPathEntry[],
  project: ProjectDocumentV2,
): ProjectPathEntry[] {
  const root = project.circuits.find(
    (circuit) => circuit.id === project.rootCircuitId && circuit.kind === "main",
  );
  if (!root) {
    return initialPath(project);
  }
  const valid: ProjectPathEntry[] = [{ circuitId: root.id }];
  for (const entry of path.slice(1)) {
    const parent = requireCircuit(project, valid.at(-1)!.circuitId);
    const instance = parent.components.find(
      (component) =>
        component.id === entry.instanceId &&
        component.typeId === "project.module_instance" &&
        component.properties.moduleId === entry.circuitId,
    );
    if (!instance || !project.circuits.some((item) => item.id === entry.circuitId)) {
      break;
    }
    valid.push({ circuitId: entry.circuitId, instanceId: entry.instanceId });
  }
  return valid;
}

function allocateModuleId(name: string, project: ProjectDocumentV2): string {
  const stem =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "module";
  const used = new Set(project.circuits.map((circuit) => circuit.id));
  let suffix = 1;
  while (used.has(`${stem}-${suffix}`)) {
    suffix += 1;
  }
  return `${stem}-${suffix}`;
}

function requireCircuit(
  project: ProjectDocumentV2,
  circuitId: string,
): ProjectCircuit {
  const circuit = project.circuits.find((item) => item.id === circuitId);
  if (!circuit) {
    throw new Error(`Unknown circuit: ${circuitId}`);
  }
  return circuit;
}

function isBoundary(component: EditorComponent): boolean {
  return (
    component.typeId === "project.module_input" ||
    component.typeId === "project.module_output"
  );
}

function validateModuleInstance(
  project: ProjectDocumentV2,
  ownerCircuitId: string,
  component: EditorComponent,
): void {
  const owner = requireCircuit(project, ownerCircuitId);
  const moduleId = component.properties.moduleId;
  if (typeof moduleId !== "string") {
    throw new Error("Module instance must reference a module");
  }
  const target = project.circuits.find((circuit) => circuit.id === moduleId);
  if (!target || target.kind !== "module") {
    throw new Error(`Unknown module: ${moduleId}`);
  }
  if (owner.kind === "module" && reachesCircuit(project, moduleId, ownerCircuitId)) {
    throw new Error(
      `Module instance '${component.id}' would create a dependency cycle`,
    );
  }
}

function reachesCircuit(
  project: ProjectDocumentV2,
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
    if (currentId === target) {
      return true;
    }
    if (visited.has(currentId)) {
      continue;
    }
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
  restored: ProjectDocumentV2,
  current: ProjectDocumentV2,
): ProjectDocumentV2 {
  const currentById = new Map(
    current.circuits.map((circuit) => [circuit.id, circuit]),
  );
  return {
    ...restored,
    circuits: restored.circuits.map((circuit) => {
      const currentCircuit = currentById.get(circuit.id);
      if (!currentCircuit) {
        return circuit;
      }
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

function cloneProject(project: ProjectDocumentV2): ProjectDocumentV2 {
  return {
    ...project,
    circuits: project.circuits.map((circuit) => ({
      ...circuit,
      components: circuit.components.map(cloneComponent),
      connections: circuit.connections.map((connection) => ({ ...connection })),
      ...(circuit.viewport ? { viewport: { ...circuit.viewport } } : {}),
    })),
  };
}

function documentsEqual(
  left: ProjectDocumentV2,
  right: ProjectDocumentV2,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changedRevisions(
  previous: ProjectDocumentV2,
  next: ProjectDocumentV2,
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

function structureFingerprint(project: ProjectDocumentV2): string {
  return JSON.stringify({
    ...project,
    circuits: project.circuits.map(({ viewport: _viewport, ...circuit }) => ({
      ...circuit,
      components: circuit.components.map((component) => ({
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

function valueFingerprint(project: ProjectDocumentV2): string {
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
