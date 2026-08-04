import { describe, expect, it } from "vitest";
import { COMPONENT_HELP } from "../src/component-help";
import {
  EXAMPLES,
  cloneExampleDocument,
  cloneExampleProject,
} from "../src/examples";

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
  "gate.mod_sum",
  "gate.consensus",
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
      "half-adder",
      "full-adder",
      "hierarchical-adder",
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

  it("builds the half adder from one MOD_SUM and one CONSENSUS gate", () => {
    const document = cloneExampleDocument("half-adder");
    expect(
      document.nodes.filter((node) => node.data.typeId === "gate.mod_sum"),
    ).toHaveLength(1);
    expect(
      document.nodes.filter((node) => node.data.typeId === "gate.consensus"),
    ).toHaveLength(1);
    expect(
      document.nodes.some((node) => node.data.typeId.startsWith("module.")),
    ).toBe(false);
  });

  it("builds the full adder from two half adders and one MOD_SUM gate", () => {
    const document = cloneExampleDocument("full-adder");
    expect(
      document.nodes.filter(
        (node) => node.data.typeId === "module.half_adder",
      ),
    ).toHaveLength(2);
    expect(
      document.nodes.filter((node) => node.data.typeId === "gate.mod_sum"),
    ).toHaveLength(1);
    expect(
      document.nodes.some(
        (node) =>
          node.data.typeId === "module.full_adder" ||
          node.data.typeId === "gate.mux3",
      ),
    ).toBe(false);
  });

  it("freezes the editable Half Adder -> Full Adder -> Main hierarchy", () => {
    const project = cloneExampleProject("hierarchical-adder")!;
    const halfAdder = project.circuits.find((circuit) => circuit.id === "half-adder")!;
    const fullAdder = project.circuits.find((circuit) => circuit.id === "full-adder")!;
    const main = project.circuits.find((circuit) => circuit.id === "main")!;

    expect(halfAdder.components.map((component) => component.typeId)).toEqual([
      "project.module_input",
      "project.module_input",
      "gate.mod_sum",
      "gate.consensus",
      "project.module_output",
      "project.module_output",
    ]);
    expect(
      fullAdder.components.filter(
        (component) => component.typeId === "project.module_input",
      ),
    ).toHaveLength(3);
    expect(
      fullAdder.components.filter(
        (component) =>
          component.typeId === "project.module_instance" &&
          component.properties.moduleId === "half-adder",
      ),
    ).toHaveLength(2);
    expect(
      fullAdder.components.filter(
        (component) => component.typeId === "gate.mod_sum",
      ),
    ).toHaveLength(1);
    expect(fullAdder.components.map((component) => component.typeId)).toEqual([
      "project.module_input",
      "project.module_input",
      "project.module_input",
      "project.module_instance",
      "project.module_instance",
      "gate.mod_sum",
      "project.module_output",
      "project.module_output",
    ]);
    expect(
      fullAdder.connections.map((connection) => [
        connection.sourceComponentId,
        connection.sourcePortId,
        connection.targetComponentId,
        connection.targetPortId,
      ]),
    ).toEqual([
      ["input-a", "out", "half-adder-1", "a"],
      ["input-b", "out", "half-adder-1", "b"],
      ["half-adder-1", "sum", "half-adder-2", "a"],
      ["input-cin", "out", "half-adder-2", "b"],
      ["half-adder-2", "sum", "output-sum", "in"],
      ["half-adder-1", "carry", "carry-merge", "a"],
      ["half-adder-2", "carry", "carry-merge", "b"],
      ["carry-merge", "y", "output-carry", "in"],
    ]);
    expect(main.components.map((component) => component.typeId)).toEqual([
      "source.trit_input",
      "source.trit_input",
      "source.trit_input",
      "project.module_instance",
      "sink.probe",
      "sink.probe",
    ]);
    expect(
      project.circuits.flatMap((circuit) => circuit.components).some(
        (component) => component.typeId === "module.full_adder",
      ),
    ).toBe(false);
  });

  it("deep-clones the hierarchical project template", () => {
    const copy = cloneExampleProject("hierarchical-adder")!;
    copy.circuits[0].components[0].properties.value = "T";
    expect(
      cloneExampleProject("hierarchical-adder")!.circuits[0].components[0]
        .properties.value,
    ).toBe("1");
    expect(cloneExampleProject("neg")).toBeNull();

    const exposed = EXAMPLES.find(
      (example) => example.id === "hierarchical-adder",
    )!.project!;
    exposed.circuits[0].components[0].properties.value = "T";
    expect(
      cloneExampleProject("hierarchical-adder")!.circuits[0].components[0]
        .properties.value,
    ).toBe("1");
    exposed.circuits[0].components[0].properties.value = "1";
  });
});

describe("component help", () => {
  it.each(TYPE_IDS)("%s has a useful Chinese explanation", (typeId) => {
    expect(COMPONENT_HELP[typeId]).toBeDefined();
    expect(COMPONENT_HELP[typeId].summary.length).toBeGreaterThan(12);
    expect(COMPONENT_HELP[typeId].details.length).toBeGreaterThan(12);
  });
});
