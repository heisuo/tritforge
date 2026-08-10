import { toEditorDocument, type CircuitDocument } from "../editor/circuit-document";
import type {
  CatalogPort,
  EditorDocument,
  EditorEdge,
  EditorNode,
  ProjectSimulationSnapshot,
  TernaryWord,
} from "../editor-model";
import { editorHandleId } from "../editor/port-handles";
import type { ProjectCircuitV3, ProjectWire, WireEndpoint } from "./project-v3";

export type ComponentPortLookup = (
  componentId: string,
) => ReadonlyArray<CatalogPort>;

export function projectToEditor(
  circuit: ProjectCircuitV3,
  portsForComponent: ComponentPortLookup,
): EditorDocument {
  const document: CircuitDocument = {
    format: "logsim-ternary",
    version: 1,
    components: circuit.components,
    connections: [],
    ...(circuit.viewport ? { viewport: circuit.viewport } : {}),
  };
  const base = toEditorDocument(document);
  const nodes = base.nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      ports: portsForComponent(node.id).map((port) => ({ ...port })),
    },
  }));
  const portIndex = new Map(
    nodes.map((node) => [
      node.id,
      new Map((node.data.ports ?? []).map((port) => [port.id, port])),
    ]),
  );
  return {
    nodes,
    edges: circuit.wires.map((wire) => orientedEdge(wire, portIndex)),
  };
}

export function edgeNetValue(
  edge: EditorEdge,
  snapshot: ProjectSimulationSnapshot | null,
): TernaryWord {
  if (!snapshot) return "Z";
  const endpoints = [
    {
      componentId: edge.target,
      portId: edge.data?.semanticTargetPortId ?? edge.targetHandle ?? "",
    },
    {
      componentId: edge.source,
      portId: edge.data?.semanticSourcePortId ?? edge.sourceHandle ?? "",
    },
  ];
  for (const endpoint of endpoints) {
    const input =
      snapshot.inputNetWords[endpoint.componentId]?.[endpoint.portId] ??
      snapshot.inputNets[endpoint.componentId]?.[endpoint.portId];
    if (input !== undefined) return input;
  }
  for (const endpoint of endpoints.reverse()) {
    const output =
      snapshot.componentOutputWords[endpoint.componentId]?.[endpoint.portId] ??
      snapshot.componentOutputs[endpoint.componentId]?.[endpoint.portId];
    if (output !== undefined) return output;
  }
  return "Z";
}

function orientedEdge(
  wire: ProjectWire,
  ports: ReadonlyMap<string, ReadonlyMap<string, CatalogPort>>,
): EditorEdge {
  const direction = (endpoint: WireEndpoint) =>
    ports.get(endpoint.componentId)?.get(endpoint.portId)?.direction;
  const [source, target] = preferOrientation(
    wire.endpointA,
    wire.endpointB,
    direction(wire.endpointA),
    direction(wire.endpointB),
  );
  return {
    id: wire.id,
    source: source.componentId,
    sourceHandle: editorHandleId(source.portId, "source"),
    target: target.componentId,
    targetHandle: editorHandleId(target.portId, "target"),
    data: {
      semanticSourcePortId: source.portId,
      semanticTargetPortId: target.portId,
    },
  };
}

function preferOrientation(
  endpointA: WireEndpoint,
  endpointB: WireEndpoint,
  directionA: CatalogPort["direction"] | undefined,
  directionB: CatalogPort["direction"] | undefined,
): [WireEndpoint, WireEndpoint] {
  const forward = orientationScore(directionA, directionB);
  const reverse = orientationScore(directionB, directionA);
  if (compareScore(reverse, forward) < 0) return [endpointB, endpointA];
  if (compareScore(forward, reverse) < 0) return [endpointA, endpointB];
  return endpointKey(endpointA) <= endpointKey(endpointB)
    ? [endpointA, endpointB]
    : [endpointB, endpointA];
}

function orientationScore(
  source: CatalogPort["direction"] | undefined,
  target: CatalogPort["direction"] | undefined,
): [number, number] {
  const sourceRank = source === "output" ? 0 : source === "inout" ? 1 : source ? 3 : 2;
  const targetRank = target === "input" ? 0 : target === "inout" ? 1 : target ? 3 : 2;
  return [sourceRank, targetRank];
}

function compareScore(left: [number, number], right: [number, number]): number {
  return left[0] - right[0] || left[1] - right[1];
}

function endpointKey(endpoint: WireEndpoint): string {
  return `${endpoint.componentId}\0${endpoint.portId}`;
}
