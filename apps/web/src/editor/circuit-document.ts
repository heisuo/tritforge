import type {
  EditorDocument,
  EditorEdge,
  EditorNode,
  KnownTrit,
} from "../editor-model";

export interface EditorComponent {
  id: string;
  typeId: string;
  position: { x: number; y: number };
  properties: Record<string, unknown>;
}

export interface EditorConnection {
  id: string;
  sourceComponentId: string;
  sourcePortId: string;
  targetComponentId: string;
  targetPortId: string;
}

export interface CircuitDocument {
  format: "logsim-ternary";
  version: 1;
  components: EditorComponent[];
  connections: EditorConnection[];
  viewport?: { x: number; y: number; zoom: number };
}

const TOP_LEVEL_KEYS = new Set([
  "format",
  "version",
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

export function createEmptyCircuitDocument(): CircuitDocument {
  return {
    format: "logsim-ternary",
    version: 1,
    components: [],
    connections: [],
  };
}

export function cloneCircuitDocument(
  document: CircuitDocument,
): CircuitDocument {
  return {
    format: "logsim-ternary",
    version: 1,
    components: document.components.map((component) => ({
      ...component,
      position: { ...component.position },
      properties: structuredClone(component.properties),
    })),
    connections: document.connections.map((connection) => ({ ...connection })),
    ...(document.viewport ? { viewport: { ...document.viewport } } : {}),
  };
}

export function fromEditorDocument(
  document: EditorDocument,
  viewport?: CircuitDocument["viewport"],
): CircuitDocument {
  return {
    format: "logsim-ternary",
    version: 1,
    components: document.nodes.map((node) => ({
      id: node.id,
      typeId: node.data.typeId,
      position: { ...node.position },
      properties: {
        ...node.data.properties,
        label: node.data.label,
        ...(node.data.sourceValue === undefined
          ? {}
          : { value: node.data.sourceValue }),
      },
    })),
    connections: document.edges.map((edge) => ({
      id: edge.id,
      sourceComponentId: edge.source,
      sourcePortId: edge.sourceHandle ?? "",
      targetComponentId: edge.target,
      targetPortId: edge.targetHandle ?? "",
    })),
    ...(viewport ? { viewport: { ...viewport } } : {}),
  };
}

export function toEditorDocument(document: CircuitDocument): EditorDocument {
  const nodes: EditorNode[] = document.components.map((component) => {
    const { label, value, ...extraProperties } = component.properties;
    return {
      id: component.id,
      type: "component",
      position: { ...component.position },
      data: {
        typeId: component.typeId,
        label:
          typeof label === "string" && label.length > 0
            ? label
            : component.typeId,
        ...(Object.keys(extraProperties).length > 0
          ? { properties: extraProperties }
          : {}),
        ...(value === undefined ? {} : { sourceValue: value as KnownTrit }),
      },
    };
  });
  const edges: EditorEdge[] = document.connections.map((connection) => ({
    id: connection.id,
    source: connection.sourceComponentId,
    sourceHandle: connection.sourcePortId,
    target: connection.targetComponentId,
    targetHandle: connection.targetPortId,
  }));
  return { nodes, edges };
}

export function serializeCircuitDocument(document: CircuitDocument): string {
  return JSON.stringify(document, null, 2);
}

function recordAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
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

function componentAt(value: unknown, index: number): EditorComponent {
  const path = `components[${index}]`;
  const component = recordAt(value, path);
  assertAllowedKeys(component, COMPONENT_KEYS, path);
  const properties = recordAt(component.properties, `${path}.properties`);
  const sourceValue = properties.value;
  if (
    sourceValue !== undefined &&
    sourceValue !== "T" &&
    sourceValue !== "0" &&
    sourceValue !== "1"
  ) {
    throw new Error(`${path}.properties.value must be T, 0, or 1`);
  }
  if (
    properties.label !== undefined &&
    (typeof properties.label !== "string" || properties.label.length === 0)
  ) {
    throw new Error(`${path}.properties.label must be a non-empty string`);
  }
  return {
    id: stringAt(component.id, `${path}.id`),
    typeId: stringAt(component.typeId, `${path}.typeId`),
    position: pointAt(component.position, `${path}.position`),
    properties: { ...properties },
  };
}

function connectionAt(value: unknown, index: number): EditorConnection {
  const path = `connections[${index}]`;
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

export function parseCircuitDocument(json: string): CircuitDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `Circuit file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const document = recordAt(parsed, "document");
  assertAllowedKeys(document, TOP_LEVEL_KEYS, "document");
  if (document.format !== "logsim-ternary") {
    throw new Error("document.format must be 'logsim-ternary'");
  }
  if (document.version !== 1) {
    throw new Error(`Unsupported circuit document version: ${String(document.version)}`);
  }
  if (!Array.isArray(document.components)) {
    throw new Error("document.components must be an array");
  }
  if (!Array.isArray(document.connections)) {
    throw new Error("document.connections must be an array");
  }
  const components = document.components.map(componentAt);
  const connections = document.connections.map(connectionAt);
  const componentIds = new Set(components.map((component) => component.id));
  if (componentIds.size !== components.length) {
    throw new Error("document contains duplicate component IDs");
  }
  const connectionIds = new Set(connections.map((connection) => connection.id));
  if (connectionIds.size !== connections.length) {
    throw new Error("document contains duplicate connection IDs");
  }
  for (const connection of connections) {
    if (
      !componentIds.has(connection.sourceComponentId) ||
      !componentIds.has(connection.targetComponentId)
    ) {
      throw new Error(`connection '${connection.id}' references a missing component`);
    }
  }

  let viewport: CircuitDocument["viewport"];
  if (document.viewport !== undefined) {
    const value = recordAt(document.viewport, "document.viewport");
    assertAllowedKeys(value, new Set(["x", "y", "zoom"]), "document.viewport");
    viewport = {
      x: numberAt(value.x, "document.viewport.x"),
      y: numberAt(value.y, "document.viewport.y"),
      zoom: numberAt(value.zoom, "document.viewport.zoom"),
    };
    if (viewport.zoom <= 0) {
      throw new Error("document.viewport.zoom must be greater than 0");
    }
  }
  return {
    format: "logsim-ternary",
    version: 1,
    components,
    connections,
    ...(viewport ? { viewport } : {}),
  };
}
