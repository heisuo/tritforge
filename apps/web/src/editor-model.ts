import type { Edge, Node } from "@xyflow/react";
import type { WireLaneAssignment } from "./wire-routing";

export type KnownTrit = "T" | "0" | "1";
export type TritSymbol = KnownTrit | "X" | "Z" | "E";

export interface QualifiedComponentRef {
  circuitId: string;
  instancePath: string[];
  componentId: string;
}

export interface QualifiedConnectionRef {
  circuitId: string;
  instancePath: string[];
  connectionId: string;
}

export interface QualifiedPortRef {
  circuitId: string;
  instancePath: string[];
  componentId: string;
  portId: string;
}

export type ProjectDiagnosticLocation =
  | { kind: "component"; ref: QualifiedComponentRef }
  | { kind: "connection"; ref: QualifiedConnectionRef }
  | { kind: "port"; ref: QualifiedPortRef };

export interface ProjectSimulationDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  primaryLocation: ProjectDiagnosticLocation | null;
  componentRefs: QualifiedComponentRef[];
  connectionRefs: QualifiedConnectionRef[];
  portRefs: QualifiedPortRef[];
}

export interface ProjectSimulationSnapshot {
  componentOutputs: Record<string, Record<string, TritSymbol>>;
  inputNets: Record<string, Record<string, TritSymbol>>;
  diagnostics: ProjectSimulationDiagnostic[];
  stable: boolean;
  compileCount: number;
}

export interface CatalogPort {
  id: string;
  direction: "input" | "output";
}

export interface TruthTableRow {
  inputs: TritSymbol[];
  outputs: TritSymbol[];
}

export interface CatalogComponent {
  type_id: string;
  display_name: string;
  category: string;
  kind: string;
  ports: CatalogPort[];
  truth_table: TruthTableRow[];
}

export interface ComponentNodeData extends Record<string, unknown> {
  typeId: string;
  label: string;
  properties?: Record<string, unknown>;
  sourceValue?: KnownTrit;
  ports?: CatalogPort[];
  inputSignals?: Record<string, TritSymbol>;
  outputSignals?: Record<string, TritSymbol>;
}

export type EditorNode = Node<ComponentNodeData, "component">;
export interface LogicWireData
  extends Record<string, unknown>,
    WireLaneAssignment {}
export type EditorEdge = Edge<LogicWireData, "logic">;

export interface EditorDocument {
  nodes: EditorNode[];
  edges: EditorEdge[];
}

export interface CircuitDefinition {
  components: Array<{
    id: string;
    type_id: string;
    properties: { value?: KnownTrit };
  }>;
  connections: Array<{
    id: string;
    source_component_id: string;
    source_port_id: string;
    target_component_id: string;
    target_port_id: string;
  }>;
}

export const DEFAULT_DOCUMENT: EditorDocument = {
  nodes: [
    {
      id: "input-1",
      type: "component",
      position: { x: 100, y: 250 },
      data: {
        typeId: "source.trit_input",
        label: "Trit Input",
        sourceValue: "0",
      },
    },
    {
      id: "neg-1",
      type: "component",
      position: { x: 390, y: 250 },
      data: { typeId: "gate.neg", label: "NEG" },
    },
    {
      id: "probe-1",
      type: "component",
      position: { x: 680, y: 250 },
      data: { typeId: "sink.probe", label: "Probe" },
    },
  ],
  edges: [
    {
      id: "wire-input-neg",
      source: "input-1",
      sourceHandle: "out",
      target: "neg-1",
      targetHandle: "a",
    },
    {
      id: "wire-neg-probe",
      source: "neg-1",
      sourceHandle: "y",
      target: "probe-1",
      targetHandle: "in",
    },
  ],
};

export function createDefaultDocument(): EditorDocument {
  return {
    nodes: DEFAULT_DOCUMENT.nodes.map((node) => ({
      ...node,
      position: { ...node.position },
      data: { ...node.data },
    })),
    edges: DEFAULT_DOCUMENT.edges.map((edge) => ({ ...edge })),
  };
}

export function cycleKnownTrit(value: KnownTrit): KnownTrit {
  if (value === "T") {
    return "0";
  }
  if (value === "0") {
    return "1";
  }
  return "T";
}

export function renameNodeLabel(
  nodes: EditorNode[],
  nodeId: string,
  label: string,
): EditorNode[] {
  const nextLabel = label.trim();
  if (!nextLabel) {
    return nodes;
  }
  return nodes.map((node) =>
    node.id === nodeId
      ? { ...node, data: { ...node.data, label: nextLabel } }
      : node,
  );
}

export function toCircuitDefinition(
  document: EditorDocument,
): CircuitDefinition {
  return {
    components: document.nodes.map((node) => ({
      id: node.id,
      type_id: node.data.typeId,
      properties:
        node.data.sourceValue === undefined
          ? {}
          : { value: node.data.sourceValue },
    })),
    connections: document.edges.map((edge) => ({
      id: edge.id,
      source_component_id: edge.source,
      source_port_id: edge.sourceHandle ?? "",
      target_component_id: edge.target,
      target_port_id: edge.targetHandle ?? "",
    })),
  };
}

export type ConnectionRejection =
  | "missing_endpoint"
  | "invalid_direction"
  | "duplicate";

export interface ConnectionCandidate {
  source: string | null;
  sourceHandle?: string | null;
  target: string | null;
  targetHandle?: string | null;
}

export function validateConnection(
  connection: ConnectionCandidate,
  document: EditorDocument,
  catalog: CatalogComponent[],
): { valid: true } | { valid: false; reason: ConnectionRejection } {
  const sourceNode = document.nodes.find(
    (node) => node.id === connection.source,
  );
  const targetNode = document.nodes.find(
    (node) => node.id === connection.target,
  );
  const sourceDescriptor = catalog.find(
    (component) => component.type_id === sourceNode?.data.typeId,
  );
  const targetDescriptor = catalog.find(
    (component) => component.type_id === targetNode?.data.typeId,
  );
  const sourcePort = sourceDescriptor?.ports.find(
    (port) => port.id === connection.sourceHandle,
  );
  const targetPort = targetDescriptor?.ports.find(
    (port) => port.id === connection.targetHandle,
  );

  if (
    !connection.source ||
    !connection.target ||
    !connection.sourceHandle ||
    !connection.targetHandle ||
    !sourcePort ||
    !targetPort
  ) {
    return { valid: false, reason: "missing_endpoint" };
  }
  if (
    sourcePort.direction !== "output" ||
    targetPort.direction !== "input"
  ) {
    return { valid: false, reason: "invalid_direction" };
  }

  const duplicate = document.edges.some(
    (edge) =>
      edge.source === connection.source &&
      edge.sourceHandle === connection.sourceHandle &&
      edge.target === connection.target &&
      edge.targetHandle === connection.targetHandle,
  );
  if (duplicate) {
    return { valid: false, reason: "duplicate" };
  }

  return { valid: true };
}

export function makeComponentId(
  typeId: string,
  nodes: EditorNode[],
): string {
  const stem = typeId.split(".").at(-1)?.replaceAll("_", "-") ?? "component";
  const used = new Set(nodes.map((node) => node.id));
  let suffix = 1;
  while (used.has(`${stem}-${suffix}`)) {
    suffix += 1;
  }
  return `${stem}-${suffix}`;
}

export function makeConnectionId(edges: EditorEdge[]): string {
  const used = new Set(edges.map((edge) => edge.id));
  let suffix = 1;
  while (used.has(`wire-${suffix}`)) {
    suffix += 1;
  }
  return `wire-${suffix}`;
}
