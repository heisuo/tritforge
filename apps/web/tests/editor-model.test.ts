import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOCUMENT,
  cycleKnownTrit,
  renameNodeLabel,
  toCircuitDefinition,
  validateConnection,
  type CatalogComponent,
} from "../src/editor-model";

const catalog: CatalogComponent[] = [
  {
    type_id: "source.trit_input",
    display_name: "Trit Input",
    category: "source",
    kind: "TritInput",
    ports: [{ id: "out", direction: "output" }],
    truth_table: [],
  },
  {
    type_id: "gate.neg",
    display_name: "Negate",
    category: "gate",
    kind: "Neg",
    ports: [
      { id: "a", direction: "input" },
      { id: "y", direction: "output" },
    ],
    truth_table: [],
  },
  {
    type_id: "sink.probe",
    display_name: "Probe",
    category: "sink",
    kind: "Probe",
    ports: [{ id: "in", direction: "input" }],
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

  it("cycles known input values in balanced ternary order", () => {
    const values = ["T", "0", "1", "T"] as const;
    expect(values.slice(1)).toEqual(values.slice(0, -1).map(cycleKnownTrit));
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

  it("rejects connections that do not run output to input", () => {
    expect(
      validateConnection(
        {
          source: "neg-1",
          sourceHandle: "a",
          target: "input-1",
          targetHandle: "out",
        },
        DEFAULT_DOCUMENT,
        catalog,
      ),
    ).toEqual({ valid: false, reason: "invalid_direction" });
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
});
