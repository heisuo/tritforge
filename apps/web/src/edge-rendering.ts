import type {
  EditorEdge,
  EditorNode,
  ProjectSimulationSnapshot,
  TernaryWord,
  TritSymbol,
} from "./editor-model";
import { edgeNetValue } from "./project/editor-projection";
import type { WireLaneAssignment } from "./wire-routing";

const SIGNAL_COLORS: Record<TritSymbol, string> = {
  T: "#246b9a",
  "0": "#64717d",
  "1": "#b53b3f",
  X: "#7b5794",
  Z: "#8b969e",
  E: "#c32231",
};

const KNOWN_BUS_COLOR = "#426a70";

export function wireSignalColor(value: TernaryWord, width: number): string {
  if (value.includes("E")) return SIGNAL_COLORS.E;
  if (value.includes("X")) return SIGNAL_COLORS.X;
  if (value.includes("Z")) return SIGNAL_COLORS.Z;
  if (width > 1) return KNOWN_BUS_COLOR;
  return SIGNAL_COLORS[value as TritSymbol] ?? KNOWN_BUS_COLOR;
}

interface NodeRenderIndex {
  node: EditorNode;
  portWidths: ReadonlyMap<string, number>;
}

export function buildRenderedEdges(
  edges: EditorEdge[],
  nodes: EditorNode[],
  snapshot: ProjectSimulationSnapshot | null,
  wireLanes: Readonly<Record<string, Partial<WireLaneAssignment>>>,
): EditorEdge[] {
  const nodeById = new Map<string, NodeRenderIndex>();
  for (const node of nodes) {
    nodeById.set(node.id, {
      node,
      portWidths: new Map(
        (node.data.ports ?? []).map((port) => [port.id, port.width]),
      ),
    });
  }

  return edges.map((edge) => {
    const signal = edgeNetValue(edge, snapshot);
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    const sourcePortId = edge.data?.semanticSourcePortId ?? edge.sourceHandle;
    const targetPortId = edge.data?.semanticTargetPortId ?? edge.targetHandle;
    const width =
      (sourcePortId ? source?.portWidths.get(sourcePortId) : undefined) ??
      (targetPortId ? target?.portWidths.get(targetPortId) : undefined) ??
      signal.length;
    const tunnelNode =
      source?.node.data.typeId === "wiring.tunnel"
        ? source.node
        : target?.node.data.typeId === "wiring.tunnel"
          ? target.node
          : undefined;
    const localName =
      typeof tunnelNode?.data.properties?.label === "string"
        ? tunnelNode.data.properties.label
        : tunnelNode
          ? tunnelNode.data.label
          : undefined;
    const signalColor = wireSignalColor(signal, width);

    return {
      ...edge,
      type: "logic",
      data: {
        ...edge.data,
        ...wireLanes[edge.id],
        semanticWidth: width,
        currentWord: signal,
        signalColor,
        ...(localName ? { localName } : {}),
      },
      style: {
        stroke: signalColor,
        strokeWidth: width > 1 ? 6 : 2,
      },
    };
  });
}
