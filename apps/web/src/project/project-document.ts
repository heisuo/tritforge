import {
  parseCircuitDocumentValue,
  type CircuitDocument,
  type EditorComponent,
  type EditorConnection,
} from "../editor/circuit-document";
import {
  parseProjectDocumentV3,
  serializeProjectDocumentV3,
  type ProjectDocumentV3,
} from "./project-v3";

export interface ProjectDocumentV2 {
  format: "logsim-ternary";
  version: 2;
  rootCircuitId: string;
  circuits: ProjectCircuit[];
}

export interface ProjectCircuit {
  id: string;
  name: string;
  kind: "main" | "module";
  components: EditorComponent[];
  connections: EditorConnection[];
  viewport?: { x: number; y: number; zoom: number };
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
  "connections",
  "viewport",
]);
const COMPONENT_KEYS = new Set([
  "id",
  "typeId",
  "position",
  "properties",
]);
const CONNECTION_KEYS = new Set([
  "id",
  "sourceComponentId",
  "sourcePortId",
  "targetComponentId",
  "targetPortId",
]);
const SPECIAL_PROPERTIES = {
  "project.module_input": new Set(["portId", "label", "previewValue"]),
  "project.module_output": new Set(["portId", "label"]),
  "project.module_instance": new Set(["moduleId", "label"]),
} as const;

export function migrateV1ToV2(document: CircuitDocument): ProjectDocumentV2 {
  return {
    format: "logsim-ternary",
    version: 2,
    rootCircuitId: "main",
    circuits: [
      {
        id: "main",
        name: "Main",
        kind: "main",
        components: document.components.map(cloneComponent),
        connections: document.connections.map((connection) => ({ ...connection })),
        ...(document.viewport ? { viewport: { ...document.viewport } } : {}),
      },
    ],
  };
}

export function parseProjectDocumentV2(json: string): ProjectDocumentV2 {
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
  if (candidate.version === 1) {
    return migrateV1ToV2(parseCircuitDocumentValue(candidate));
  }
  if (candidate.version !== 2) {
    throw new Error(
      `Unsupported project document version: ${String(candidate.version)}`,
    );
  }
  return projectV2At(candidate);
}

export function serializeProjectDocumentV2(document: ProjectDocumentV2): string {
  return JSON.stringify(document, null, 2);
}

/** Imports every supported legacy format into the current v3 editor model. */
export function parseProjectDocument(json: string): ProjectDocumentV3 {
  return parseProjectDocumentV3(json);
}

/** Project exports are intentionally v3-only; there is no lossy v3 downgrade. */
export function serializeProjectDocument(document: ProjectDocumentV3): string {
  return serializeProjectDocumentV3(document);
}

function projectV2At(document: Record<string, unknown>): ProjectDocumentV2 {
  assertAllowedKeys(document, PROJECT_KEYS, "document");
  const rootCircuitId = stringAt(document.rootCircuitId, "document.rootCircuitId");
  if (!Array.isArray(document.circuits)) {
    throw new Error("document.circuits must be an array");
  }
  const circuits = document.circuits.map(circuitAt);
  const circuitIds = new Set(circuits.map((circuit) => circuit.id));
  if (circuitIds.size !== circuits.length) {
    throw new Error("document contains duplicate circuit IDs");
  }
  const mainCircuits = circuits.filter((circuit) => circuit.kind === "main");
  if (mainCircuits.length !== 1) {
    throw new Error("document must contain exactly one main circuit");
  }
  return {
    format: "logsim-ternary",
    version: 2,
    rootCircuitId,
    circuits,
  };
}

function circuitAt(value: unknown, index: number): ProjectCircuit {
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
  if (!Array.isArray(circuit.connections)) {
    throw new Error(`${path}.connections must be an array`);
  }
  const components = circuit.components.map((component, componentIndex) =>
    componentAt(component, `${path}.components[${componentIndex}]`),
  );
  const connections = circuit.connections.map((connection, connectionIndex) =>
    connectionAt(connection, `${path}.connections[${connectionIndex}]`),
  );
  assertUniqueIds(components, `${path} contains duplicate component IDs`);
  assertUniqueIds(connections, `${path} contains duplicate connection IDs`);
  const componentIds = new Set(components.map((component) => component.id));
  for (const connection of connections) {
    if (
      !componentIds.has(connection.sourceComponentId) ||
      !componentIds.has(connection.targetComponentId)
    ) {
      throw new Error(
        `${path} connection '${connection.id}' references a missing component`,
      );
    }
  }

  let viewport: ProjectCircuit["viewport"];
  if (circuit.viewport !== undefined) {
    viewport = viewportAt(circuit.viewport, `${path}.viewport`);
  }
  return {
    id: stringAt(circuit.id, `${path}.id`),
    name: stringAt(circuit.name, `${path}.name`),
    kind,
    components,
    connections,
    ...(viewport ? { viewport } : {}),
  };
}

function componentAt(value: unknown, path: string): EditorComponent {
  const component = recordAt(value, path);
  assertAllowedKeys(component, COMPONENT_KEYS, path);
  const typeId = stringAt(component.typeId, `${path}.typeId`);
  const properties = recordAt(component.properties, `${path}.properties`);
  validateProperties(typeId, properties, `${path}.properties`);
  return {
    id: stringAt(component.id, `${path}.id`),
    typeId,
    position: pointAt(component.position, `${path}.position`),
    properties: structuredClone(properties),
  };
}

function validateProperties(
  typeId: string,
  properties: Record<string, unknown>,
  path: string,
): void {
  if (typeId === "project.module_input") {
    assertAllowedKeys(properties, SPECIAL_PROPERTIES[typeId], path);
    nonEmptyProperty(properties, "portId", path);
    nonEmptyProperty(properties, "label", path);
    knownTritProperty(properties, "previewValue", path, true);
    return;
  }
  if (typeId === "project.module_output") {
    assertAllowedKeys(properties, SPECIAL_PROPERTIES[typeId], path);
    nonEmptyProperty(properties, "portId", path);
    nonEmptyProperty(properties, "label", path);
    return;
  }
  if (typeId === "project.module_instance") {
    assertAllowedKeys(properties, SPECIAL_PROPERTIES[typeId], path);
    nonEmptyProperty(properties, "moduleId", path);
    nonEmptyProperty(properties, "label", path);
    return;
  }
  knownTritProperty(properties, "value", path, false);
  if (properties.label !== undefined) {
    nonEmptyProperty(properties, "label", path);
  }
}

function connectionAt(value: unknown, path: string): EditorConnection {
  const connection = recordAt(value, path);
  assertAllowedKeys(connection, CONNECTION_KEYS, path);
  return {
    id: stringAt(connection.id, `${path}.id`),
    sourceComponentId: stringAt(
      connection.sourceComponentId,
      `${path}.sourceComponentId`,
    ),
    sourcePortId: stringAt(connection.sourcePortId, `${path}.sourcePortId`),
    targetComponentId: stringAt(
      connection.targetComponentId,
      `${path}.targetComponentId`,
    ),
    targetPortId: stringAt(connection.targetPortId, `${path}.targetPortId`),
  };
}

function cloneComponent(component: EditorComponent): EditorComponent {
  return {
    ...component,
    position: { ...component.position },
    properties: structuredClone(component.properties),
  };
}

function assertUniqueIds(values: { id: string }[], message: string): void {
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

function nonEmptyProperty(
  properties: Record<string, unknown>,
  key: string,
  path: string,
): void {
  stringAt(properties[key], `${path}.${key}`);
}

function knownTritProperty(
  properties: Record<string, unknown>,
  key: string,
  path: string,
  required: boolean,
): void {
  const value = properties[key];
  if (!required && value === undefined) {
    return;
  }
  if (value !== "T" && value !== "0" && value !== "1") {
    throw new Error(`${path}.${key} must be T, 0, or 1`);
  }
}

export {
  migrateV2ToV3,
  parseProjectDocumentV3,
  serializeProjectDocumentV3,
  type ProjectCircuitV3,
  type ProjectDocumentV3,
  type ProjectWire,
  type WireEndpoint,
} from "./project-v3";
