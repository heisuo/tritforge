import type { EditorComponent } from "../editor/circuit-document";
import {
  parseProjectDocument,
  type ProjectCircuit,
  type ProjectDocumentV2,
} from "./project-document";

export interface ProjectDocumentV3 {
  format: "logsim-ternary";
  version: 3;
  rootCircuitId: string;
  circuits: ProjectCircuitV3[];
}

export interface ProjectCircuitV3 {
  id: string;
  name: string;
  kind: "main" | "module";
  components: EditorComponent[];
  wires: ProjectWire[];
  viewport?: NonNullable<ProjectCircuit["viewport"]>;
}

export interface ProjectWire {
  id: string;
  endpointA: WireEndpoint;
  endpointB: WireEndpoint;
}

export interface WireEndpoint {
  componentId: string;
  portId: string;
}

const PROJECT_KEYS = new Set([
  "format",
  "version",
  "rootCircuitId",
  "circuits",
]);
const CIRCUIT_KEYS = new Set([
  "id",
  "name",
  "kind",
  "components",
  "wires",
  "viewport",
]);
const COMPONENT_KEYS = new Set([
  "id",
  "typeId",
  "position",
  "properties",
]);
const WIRE_KEYS = new Set(["id", "endpointA", "endpointB"]);
const ENDPOINT_KEYS = new Set(["componentId", "portId"]);

export function migrateV2ToV3(document: ProjectDocumentV2): ProjectDocumentV3 {
  assertValidRoot(document.rootCircuitId, document.circuits);
  return {
    format: "logsim-ternary",
    version: 3,
    rootCircuitId: document.rootCircuitId,
    circuits: document.circuits.map((circuit) => ({
      id: circuit.id,
      name: circuit.name,
      kind: circuit.kind,
      components: circuit.components.map(cloneComponent),
      wires: circuit.connections.map((connection) => ({
        id: connection.id,
        endpointA: {
          componentId: connection.sourceComponentId,
          portId: connection.sourcePortId,
        },
        endpointB: {
          componentId: connection.targetComponentId,
          portId: connection.targetPortId,
        },
      })),
      ...(circuit.viewport ? { viewport: { ...circuit.viewport } } : {}),
    })),
  };
}

export function parseProjectDocumentV3(json: string): ProjectDocumentV3 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `Project file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const candidate = recordAt(parsed, "document");
  if (candidate.format !== "logsim-ternary") {
    throw new Error("document.format must be 'logsim-ternary'");
  }
  if (candidate.version === 1 || candidate.version === 2) {
    return migrateV2ToV3(parseProjectDocument(json));
  }
  if (candidate.version !== 3) {
    throw new Error(
      `Unsupported project document version: ${String(candidate.version)}`,
    );
  }
  return projectV3At(candidate);
}

export function serializeProjectDocumentV3(
  document: ProjectDocumentV3,
): string {
  const serializable: ProjectDocumentV3 = {
    format: "logsim-ternary",
    version: 3,
    rootCircuitId: document.rootCircuitId,
    circuits: document.circuits.map((circuit) => ({
      id: circuit.id,
      name: circuit.name,
      kind: circuit.kind,
      components: circuit.components.map(cloneComponent),
      wires: circuit.wires.map((wire) => ({
        id: wire.id,
        endpointA: { ...wire.endpointA },
        endpointB: { ...wire.endpointB },
      })),
      ...(circuit.viewport ? { viewport: { ...circuit.viewport } } : {}),
    })),
  };
  return JSON.stringify(serializable, null, 2);
}

function projectV3At(document: Record<string, unknown>): ProjectDocumentV3 {
  assertAllowedKeys(document, PROJECT_KEYS, "document");
  const rootCircuitId = stringAt(document.rootCircuitId, "document.rootCircuitId");
  if (!Array.isArray(document.circuits)) {
    throw new Error("document.circuits must be an array");
  }
  const circuits = document.circuits.map(circuitAt);
  assertUniqueIds(circuits, "document contains duplicate circuit IDs");
  const mainCircuits = circuits.filter((circuit) => circuit.kind === "main");
  if (mainCircuits.length !== 1) {
    throw new Error("document must contain exactly one main circuit");
  }
  assertValidRoot(rootCircuitId, circuits);
  return {
    format: "logsim-ternary",
    version: 3,
    rootCircuitId,
    circuits,
  };
}

function circuitAt(value: unknown, index: number): ProjectCircuitV3 {
  const path = `document.circuits[${index}]`;
  const circuit = recordAt(value, path);
  assertAllowedKeys(circuit, CIRCUIT_KEYS, path);
  const kind = circuit.kind;
  if (kind !== "main" && kind !== "module") {
    throw new Error(`${path}.kind must be main or module`);
  }
  if (!Array.isArray(circuit.components)) {
    throw new Error(`${path}.components must be an array`);
  }
  if (!Array.isArray(circuit.wires)) {
    throw new Error(`${path}.wires must be an array`);
  }
  const components = circuit.components.map((component, componentIndex) =>
    componentAt(component, `${path}.components[${componentIndex}]`),
  );
  const wires = circuit.wires.map((wire, wireIndex) =>
    wireAt(wire, `${path}.wires[${wireIndex}]`),
  );
  assertUniqueIds(components, `${path} contains duplicate component IDs`);
  assertUniqueIds(wires, `${path} contains duplicate wire IDs`);
  const componentIds = new Set(components.map((component) => component.id));
  for (const wire of wires) {
    if (
      !componentIds.has(wire.endpointA.componentId) ||
      !componentIds.has(wire.endpointB.componentId)
    ) {
      throw new Error(
        `${path} wire '${wire.id}' references a missing component`,
      );
    }
  }

  let viewport: ProjectCircuitV3["viewport"];
  if (circuit.viewport !== undefined) {
    viewport = viewportAt(circuit.viewport, `${path}.viewport`);
  }
  return {
    id: stringAt(circuit.id, `${path}.id`),
    name: stringAt(circuit.name, `${path}.name`),
    kind,
    components,
    wires,
    ...(viewport ? { viewport } : {}),
  };
}

function componentAt(value: unknown, path: string): EditorComponent {
  const component = recordAt(value, path);
  assertAllowedKeys(component, COMPONENT_KEYS, path);
  const typeId = stringAt(component.typeId, `${path}.typeId`);
  const properties = recordAt(component.properties, `${path}.properties`);
  return {
    id: stringAt(component.id, `${path}.id`),
    typeId,
    position: pointAt(component.position, `${path}.position`),
    properties: structuredClone(properties),
  };
}

function wireAt(value: unknown, path: string): ProjectWire {
  const wire = recordAt(value, path);
  assertAllowedKeys(wire, WIRE_KEYS, path);
  return {
    id: stringAt(wire.id, `${path}.id`),
    endpointA: endpointAt(wire.endpointA, `${path}.endpointA`),
    endpointB: endpointAt(wire.endpointB, `${path}.endpointB`),
  };
}

function endpointAt(value: unknown, path: string): WireEndpoint {
  const endpoint = recordAt(value, path);
  assertAllowedKeys(endpoint, ENDPOINT_KEYS, path);
  return {
    componentId: stringAt(endpoint.componentId, `${path}.componentId`),
    portId: stringAt(endpoint.portId, `${path}.portId`),
  };
}

function assertValidRoot(
  rootCircuitId: string,
  circuits: ReadonlyArray<{ id: string; kind: "main" | "module" }>,
): void {
  const root = circuits.find((circuit) => circuit.id === rootCircuitId);
  if (!root) {
    throw new Error("document.rootCircuitId must reference an existing circuit");
  }
  if (root.kind !== "main") {
    throw new Error("document.rootCircuitId must reference the main circuit");
  }
}

function cloneComponent(component: EditorComponent): EditorComponent {
  return {
    ...component,
    position: { ...component.position },
    properties: structuredClone(component.properties),
  };
}

function assertUniqueIds(
  values: ReadonlyArray<{ id: string }>,
  message: string,
): void {
  if (new Set(values.map((value) => value.id)).size !== values.length) {
    throw new Error(message);
  }
}

function recordAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new Error(`${path} contains unknown property '${unknown}'`);
  }
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function numberAt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function pointAt(value: unknown, path: string): { x: number; y: number } {
  const point = recordAt(value, path);
  assertAllowedKeys(point, new Set(["x", "y"]), path);
  return {
    x: numberAt(point.x, `${path}.x`),
    y: numberAt(point.y, `${path}.y`),
  };
}

function viewportAt(
  value: unknown,
  path: string,
): { x: number; y: number; zoom: number } {
  const viewport = recordAt(value, path);
  assertAllowedKeys(viewport, new Set(["x", "y", "zoom"]), path);
  const zoom = numberAt(viewport.zoom, `${path}.zoom`);
  if (zoom <= 0) {
    throw new Error(`${path}.zoom must be greater than 0`);
  }
  return {
    x: numberAt(viewport.x, `${path}.x`),
    y: numberAt(viewport.y, `${path}.y`),
    zoom,
  };
}
