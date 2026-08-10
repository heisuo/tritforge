import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOCUMENT,
  cycleKnownTrit,
  cycleKnownWord,
  renameNodeLabel,
  toCircuitDefinition,
  validateConnection,
  type CatalogComponent,
} from "../src/editor-model";
import { editorHandleId } from "../src/editor/port-handles";

const catalog: CatalogComponent[] = [
  {
    type_id: "source.trit_input",
    display_name: "Trit Input",
    category: "source",
    kind: "TritInput",
    ports: [{ id: "out", direction: "output", width: 1 }],
    truth_table: [],
  },
  {
    type_id: "gate.neg",
    display_name: "Negate",
    category: "gate",
    kind: "Neg",
    ports: [
      { id: "a", direction: "input", width: 1 },
      { id: "y", direction: "output", width: 1 },
    ],
    truth_table: [],
  },
  {
    type_id: "sink.probe",
    display_name: "Probe",
    category: "sink",
    kind: "Probe",
    ports: [{ id: "in", direction: "input", width: 1 }],
    truth_table: [],
  },
];

describe("editor document model", () => {
  it("converts the default Input -> NEG -> Probe document", () => {
    expect(toCircuitDefinition(DEFAULT_DOCUMENT)).toEqual({
      components: [
        {
          id: "input-1",
          type_id: "source.trit_input",
          properties: { value: "0" },
        },
        {
          id: "neg-1",
          type_id: "gate.neg",
          properties: {},
        },
        {
          id: "probe-1",
          type_id: "sink.probe",
          properties: {},
        },
      ],
      connections: [
        {
          id: "wire-input-neg",
          source_component_id: "input-1",
          source_port_id: "out",
          target_component_id: "neg-1",
          target_port_id: "a",
        },
        {
          id: "wire-neg-probe",
          source_component_id: "neg-1",
          source_port_id: "y",
          target_component_id: "probe-1",
          target_port_id: "in",
        },
      ],
    });
  });

  it("strips role-specific handles from legacy circuit definitions", () => {
    const document = structuredClone(DEFAULT_DOCUMENT);
    document.nodes[0].data.ports = catalog[0].ports;
    document.nodes[1].data.ports = catalog[1].ports;
    document.nodes[2].data.ports = catalog[2].ports;
    document.edges[0].sourceHandle = editorHandleId("out", "source");
    document.edges[0].targetHandle = editorHandleId("a", "target");
    document.edges[1].sourceHandle = editorHandleId("y", "source");
    document.edges[1].targetHandle = editorHandleId("in", "target");

    const definition = toCircuitDefinition(document);

    expect(definition.connections).toEqual([
      expect.objectContaining({ source_port_id: "out", target_port_id: "a" }),
      expect.objectContaining({ source_port_id: "y", target_port_id: "in" }),
    ]);
    expect(JSON.stringify(definition)).not.toContain("logsim-port");
  });

  it("cycles known input values in balanced ternary order", () => {
    const values = ["T", "0", "1", "T"] as const;
    expect(values.slice(1)).toEqual(values.slice(0, -1).map(cycleKnownTrit));
  });

  it("cycles every trit in a known word without changing its width", () => {
    expect(cycleKnownWord("1T0")).toBe("T01");
    expect(() => cycleKnownWord("10X")).toThrow(/unknown ternary symbol/);
  });

  it("renames only the node label without changing circuit topology", () => {
    const renamedNodes = renameNodeLabel(
      DEFAULT_DOCUMENT.nodes,
      "neg-1",
      "  一级取反门  ",
    );

    expect(
      renamedNodes.find((node) => node.id === "neg-1")?.data.label,
    ).toBe("一级取反门");
    expect(
      toCircuitDefinition({
        nodes: renamedNodes,
        edges: DEFAULT_DOCUMENT.edges,
      }),
    ).toEqual(toCircuitDefinition(DEFAULT_DOCUMENT));
    expect(
      renameNodeLabel(DEFAULT_DOCUMENT.nodes, "neg-1", "   "),
    ).toBe(DEFAULT_DOCUMENT.nodes);
  });

  it("accepts input-input connections because v3 wires are undirected", () => {
    expect(
      validateConnection(
        {
          source: "neg-1",
          sourceHandle: "a",
          target: "probe-1",
          targetHandle: "in",
        },
        DEFAULT_DOCUMENT,
        catalog,
      ),
    ).toEqual({ valid: true });
  });

  it("accepts output-output connections because v3 wires are undirected", () => {
    expect(
      validateConnection(
        {
          source: "input-1",
          sourceHandle: "out",
          target: "neg-1",
          targetHandle: "y",
        },
        { ...DEFAULT_DOCUMENT, edges: [] },
        catalog,
      ),
    ).toEqual({ valid: true });
  });

  it("rejects a connection from a semantic endpoint to itself", () => {
    expect(
      validateConnection(
        {
          source: "neg-1",
          sourceHandle: "a",
          target: "neg-1",
          targetHandle: "a",
        },
        { ...DEFAULT_DOCUMENT, edges: [] },
        catalog,
      ),
    ).toEqual({ valid: false, reason: "same_endpoint" });
  });

  it("rejects catalog-resolved width mismatches", () => {
    const mismatchedCatalog = structuredClone(catalog);
    mismatchedCatalog[0].ports[0].width = 3;
    expect(
      validateConnection(
        {
          source: "input-1",
          sourceHandle: "out",
          target: "neg-1",
          targetHandle: "a",
        },
        DEFAULT_DOCUMENT,
        mismatchedCatalog,
      ),
    ).toEqual({ valid: false, reason: "width_mismatch" });
  });

  it("rejects an exact duplicate connection", () => {
    expect(
      validateConnection(
        {
          source: "input-1",
          sourceHandle: "out",
          target: "neg-1",
          targetHandle: "a",
        },
        DEFAULT_DOCUMENT,
        catalog,
      ),
    ).toEqual({ valid: false, reason: "duplicate" });
  });

  it("accepts resolved inout ports and detects reversed duplicates", () => {
    const document = structuredClone(DEFAULT_DOCUMENT);
    document.nodes[1].data.ports = [
      { id: "a", direction: "inout", width: 1 },
    ];
    expect(
      validateConnection(
        {
          source: "input-1",
          sourceHandle: "out",
          target: "neg-1",
          targetHandle: "a",
        },
        { ...document, edges: [] },
        catalog,
      ),
    ).toEqual({ valid: true });
    expect(
      validateConnection(
        {
          source: "neg-1",
          sourceHandle: "a",
          target: "input-1",
          targetHandle: "out",
        },
        document,
        catalog,
      ),
    ).toEqual({ valid: false, reason: "duplicate" });
  });

  it("indexes nodes once instead of scanning them for every existing edge", () => {
    const nodes = Array.from({ length: 120 }, (_, index) => ({
      ...structuredClone(DEFAULT_DOCUMENT.nodes[0]),
      id: `node-${index}`,
      data: {
        typeId: "wiring.junction",
        label: `Node ${index}`,
        ports: [{ id: "net", direction: "inout" as const, width: 1 }],
      },
    }));
    const edges = Array.from({ length: 400 }, (_, index) => ({
      id: `wire-${index}`,
      source: `node-${1 + (index % 118)}`,
      sourceHandle: "net",
      target: `node-${1 + ((index + 1) % 118)}`,
      targetHandle: "net",
    }));
    let findCalls = 0;
    const nativeFind = nodes.find.bind(nodes);
    Object.defineProperty(nodes, "find", {
      value: (...args: Parameters<typeof nodes.find>) => {
        findCalls += 1;
        return nativeFind(...args);
      },
    });

    expect(
      validateConnection(
        {
          source: "node-0",
          sourceHandle: "net",
          target: "node-119",
          targetHandle: "net",
        },
        { nodes, edges },
      ),
    ).toEqual({ valid: true });
    expect(findCalls).toBe(0);
  });
});
