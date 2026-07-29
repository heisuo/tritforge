import { describe, expect, it } from "vitest";
import { COMPONENT_HELP } from "../src/component-help";
import { EXAMPLES, cloneExampleDocument } from "../src/examples";

const TYPE_IDS = [
  "source.trit_input",
  "source.constant",
  "sink.probe",
  "gate.buf",
  "gate.neg",
  "gate.min",
  "gate.max",
  "gate.is_neg",
  "gate.is_zero",
  "gate.is_pos",
  "gate.mux2",
  "gate.mux3",
  "module.half_adder",
  "module.full_adder",
] as const;

describe("example library", () => {
  it("contains the teaching examples in stable order", () => {
    expect(EXAMPLES.map((example) => example.id)).toEqual([
      "neg",
      "min-max",
      "decoder",
      "mux3",
      "full-adder",
      "ripple-adder-3",
      "driver-conflict",
    ]);
  });

  it.each(EXAMPLES)("$name has a structurally valid editable graph", (example) => {
    const nodeIds = example.document.nodes.map((node) => node.id);
    const edgeIds = example.document.edges.map((edge) => edge.id);

    expect(new Set(nodeIds).size).toBe(nodeIds.length);
    expect(new Set(edgeIds).size).toBe(edgeIds.length);
    expect(example.document.nodes.length).toBeGreaterThan(0);
    expect(
      example.document.nodes.some(
        (node) => node.data.typeId === "sink.probe",
      ),
    ).toBe(true);

    for (const edge of example.document.edges) {
      expect(nodeIds).toContain(edge.source);
      expect(nodeIds).toContain(edge.target);
      expect(edge.sourceHandle).toBeTruthy();
      expect(edge.targetHandle).toBeTruthy();
    }
  });

  it("returns a deep clone that cannot mutate the template", () => {
    const copy = cloneExampleDocument("neg");
    copy.nodes[0].position.x = 9999;
    copy.nodes[0].data.label = "changed";
    copy.edges[0].source = "changed";

    const fresh = cloneExampleDocument("neg");
    expect(fresh.nodes[0].position.x).not.toBe(9999);
    expect(fresh.nodes[0].data.label).not.toBe("changed");
    expect(fresh.edges[0].source).not.toBe("changed");
  });

  it("builds the 3-trit ripple adder from exactly three full adders", () => {
    const document = cloneExampleDocument("ripple-adder-3");
    expect(
      document.nodes.filter(
        (node) => node.data.typeId === "module.full_adder",
      ),
    ).toHaveLength(3);
  });

  it("builds the single-trit full adder only from basic MUX3 gates", () => {
    const document = cloneExampleDocument("full-adder");
    expect(
      document.nodes.some((node) => node.data.typeId.startsWith("module.")),
    ).toBe(false);
    expect(
      document.nodes.filter((node) => node.data.typeId === "gate.mux3"),
    ).toHaveLength(14);
  });
});

describe("component help", () => {
  it.each(TYPE_IDS)("%s has a useful Chinese explanation", (typeId) => {
    expect(COMPONENT_HELP[typeId]).toBeDefined();
    expect(COMPONENT_HELP[typeId].summary.length).toBeGreaterThan(12);
    expect(COMPONENT_HELP[typeId].details.length).toBeGreaterThan(12);
  });
});
