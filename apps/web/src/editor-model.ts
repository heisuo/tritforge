import type { Edge, Node } from "@xyflow/react";
import {
  portForEditorHandle,
  semanticPortIdForHandle,
} from "./editor/port-handles";
import type { WireLaneAssignment, WireObstacle } from "./wire-routing";
import type { CanvasDisplayMode } from "./canvas-display";

export type KnownTrit = "T" | "0" | "1";
export type TritSymbol = KnownTrit | "X" | "Z" | "E";
/** MS-first ternary word. Runtime words may contain T/0/1/X/Z/E. */
export type TernaryWord = string;
export type ClockPhase = "lowStable" | "highStable";

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
  componentOutputWords: Record<string, Record<string, TernaryWord>>;
  inputNetWords: Record<string, Record<string, TernaryWord>>;
  diagnostics: ProjectSimulationDiagnostic[];
  stable: boolean;
  tickCount: number;
  compileCount: number;
  clockPhase: ClockPhase;
}

export interface CatalogPort {
  id: string;
  direction: "input" | "output" | "inout";
  width: number;
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
  sourceValue?: TernaryWord;
  ports?: CatalogPort[];
  inputSignals?: Record<string, TritSymbol>;
  outputSignals?: Record<string, TritSymbol>;
  inputWords?: Record<string, TernaryWord>;
  outputWords?: Record<string, TernaryWord>;
  canvasDisplayMode?: CanvasDisplayMode;
}

export type EditorNode = Node<ComponentNodeData, "component">;
export interface LogicWireData
  extends Record<string, unknown>, Partial<WireLaneAssignment> {
  semanticSourcePortId?: string;
  semanticTargetPortId?: string;
  semanticWidth?: number;
  currentWord?: TernaryWord;
  displayWord?: string;
  localName?: string;
  signalColor?: string;
  routeObstacles?: WireObstacle[];
}
export type EditorEdge = Edge<LogicWireData, "logic">;

export interface EditorDocument {
  nodes: EditorNode[];
  edges: EditorEdge[];
}

export interface CircuitDefinition {
  components: Array<{
    id: string;
    type_id: string;
    properties: { value?: string };
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

export function cycleKnownWord(value: TernaryWord): TernaryWord {
  return [...value]
    .map((trit) => {
      if (trit !== "T" && trit !== "0" && trit !== "1") {
        throw new Error(`Cannot cycle unknown ternary symbol '${trit}'`);
      }
      return cycleKnownTrit(trit);
    })
    .join("");
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
  const nodeById = new Map(document.nodes.map((node) => [node.id, node]));
  return {
    components: document.nodes.map((node) => ({
      id: node.id,
      type_id: node.data.typeId,
      properties:
        node.data.sourceValue === undefined
          ? {}
          : { value: node.data.sourceValue },
    })),
    connections: document.edges.map((edge) => {
      const sourceNode = nodeById.get(edge.source);
      const targetNode = nodeById.get(edge.target);
      return {
        id: edge.id,
        source_component_id: edge.source,
        source_port_id:
          semanticPortIdForHandle(
            sourceNode?.data.ports ?? [],
            edge.sourceHandle,
          ) ??
          edge.data?.semanticSourcePortId ??
          edge.sourceHandle ??
          "",
        target_component_id: edge.target,
        target_port_id:
          semanticPortIdForHandle(
            targetNode?.data.ports ?? [],
            edge.targetHandle,
          ) ??
          edge.data?.semanticTargetPortId ??
          edge.targetHandle ??
          "",
      };
    }),
  };
}

export type ConnectionRejection =
  "missing_endpoint" | "same_endpoint" | "width_mismatch" | "duplicate";

export interface ConnectionCandidate {
  source: string | null;
  sourceHandle?: string | null;
  target: string | null;
  targetHandle?: string | null;
}

export type ConnectionValidationResult =
  | { valid: true }
  | {
      valid: false;
      reason: "width_mismatch";
      sourceWidth: number;
      targetWidth: number;
    }
  | {
      valid: false;
      reason: Exclude<ConnectionRejection, "width_mismatch">;
    };

export function validateConnection(
  connection: ConnectionCandidate,
  document: EditorDocument,
  catalog: CatalogComponent[] = [],
): ConnectionValidationResult {
  const nodeById = new Map(document.nodes.map((node) => [node.id, node]));
  const sourceNode = connection.source
    ? nodeById.get(connection.source)
    : undefined;
  const targetNode = connection.target
    ? nodeById.get(connection.target)
    : undefined;
  const sourceDescriptor = catalog.find(
    (component) => component.type_id === sourceNode?.data.typeId,
  );
  const targetDescriptor = catalog.find(
    (component) => component.type_id === targetNode?.data.typeId,
  );
  const sourcePorts = sourceNode?.data.ports ?? sourceDescriptor?.ports ?? [];
  const targetPorts = targetNode?.data.ports ?? targetDescriptor?.ports ?? [];
  const sourcePort = portForEditorHandle(sourcePorts, connection.sourceHandle);
  const targetPort = portForEditorHandle(targetPorts, connection.targetHandle);

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
    connection.source === connection.target &&
    sourcePort.id === targetPort.id
  ) {
    return { valid: false, reason: "same_endpoint" };
  }
  if (sourcePort.width !== targetPort.width) {
    return {
      valid: false,
      reason: "width_mismatch",
      sourceWidth: sourcePort.width,
      targetWidth: targetPort.width,
    };
  }

  const duplicate = document.edges.some((edge) => {
    const edgeSourceNode = nodeById.get(edge.source);
    const edgeTargetNode = nodeById.get(edge.target);
    const edgeSourcePort =
      semanticPortIdForHandle(
        edgeSourceNode?.data.ports ?? [],
        edge.sourceHandle,
      ) ??
      edge.data?.semanticSourcePortId ??
      edge.sourceHandle;
    const edgeTargetPort =
      semanticPortIdForHandle(
        edgeTargetNode?.data.ports ?? [],
        edge.targetHandle,
      ) ??
      edge.data?.semanticTargetPortId ??
      edge.targetHandle;
    return (
      (edge.source === connection.source &&
        edgeSourcePort === sourcePort.id &&
        edge.target === connection.target &&
        edgeTargetPort === targetPort.id) ||
      (edge.source === connection.target &&
        edgeSourcePort === targetPort.id &&
        edge.target === connection.source &&
        edgeTargetPort === sourcePort.id)
    );
  });
  if (duplicate) {
    return { valid: false, reason: "duplicate" };
  }

  return { valid: true };
}

export function makeComponentId(typeId: string, nodes: EditorNode[]): string {
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
