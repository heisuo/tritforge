import { describe, expect, it } from "vitest";
import { buildRenderedEdges, wireSignalColor } from "../src/edge-rendering";
import type {
  EditorEdge,
  EditorNode,
  ProjectSimulationSnapshot,
  TernaryWord,
} from "../src/editor-model";

function junction(id: string): EditorNode {
  return {
    id,
    type: "component",
    position: { x: 0, y: 0 },
    data: {
      typeId: "wiring.junction",
      label: id,
      ports: [{ id: "net", direction: "inout", width: 3 }],
    },
  };
}

function wire(index: number, nodeCount: number): EditorEdge {
  return {
    id: `wire-${index}`,
    source: `node-${index % nodeCount}`,
    sourceHandle: "net",
    target: `node-${(index + 1) % nodeCount}`,
    targetHandle: "net",
    data: {
      semanticSourcePortId: "net",
      semanticTargetPortId: "net",
    },
  };
}

function snapshot(value: TernaryWord): ProjectSimulationSnapshot {
  return {
    componentOutputs: {},
    inputNets: {},
    componentOutputWords: {},
    inputNetWords: { "node-1": { net: value } },
    diagnostics: [],
    stable: true,
    tickCount: 0,
    compileCount: 1,
    clockPhase: "lowStable",
  };
}

describe("edge rendering", () => {
  it("uses semantic six-state colors without changing bus geometry", () => {
    expect(wireSignalColor("1T0", 3)).toBe("#426a70");
    expect(wireSignalColor("1XZ", 3)).toBe("#7b5794");
    expect(wireSignalColor("10Z", 3)).toBe("#8b969e");
    expect(wireSignalColor("1XE", 3)).toBe("#c32231");

    const rendered = buildRenderedEdges(
      [wire(0, 2)],
      [junction("node-0"), junction("node-1")],
      snapshot("1XE"),
      {},
    );
    expect(rendered[0].style).toMatchObject({
      stroke: "#c32231",
      strokeWidth: 6,
    });
    expect(rendered[0].data).toMatchObject({
      semanticWidth: 3,
      currentWord: "1XE",
      signalColor: "#c32231",
    });
  });

  it("adds a decimal label without changing the raw simulated word", () => {
    const rendered = buildRenderedEdges(
      [wire(0, 2)],
      [junction("node-0"), junction("node-1")],
      snapshot("1T0"),
      {},
      "decimal",
    );

    expect(rendered[0].data).toMatchObject({
      currentWord: "1T0",
      displayWord: "6",
    });
  });

  it("renders a large graph without scanning the node array per wire", () => {
    const nodeCount = 10_000;
    const wireCount = 50_000;
    const nodes = Array.from({ length: nodeCount }, (_, index) =>
      junction(`node-${index}`),
    );
    Object.defineProperty(nodes, "find", {
      value: () => {
        throw new Error("renderedEdges must not scan nodes");
      },
    });
    const edges = Array.from({ length: wireCount }, (_, index) =>
      wire(index, nodeCount),
    );

    const rendered = buildRenderedEdges(edges, nodes, null, {});

    expect(rendered).toHaveLength(wireCount);
    expect(rendered.at(-1)?.data?.semanticWidth).toBe(3);
  });
});
