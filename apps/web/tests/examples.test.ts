import { describe, expect, it } from "vitest";
import { COMPONENT_HELP } from "../src/component-help";
import {
  EXAMPLES,
  cloneExampleDocument,
  cloneExampleProject,
} from "../src/examples";
import { cloneBusWiringProject } from "../src/examples/bus-wiring";

const TYPE_IDS = [
  "source.trit_input",
  "source.constant",
  "source.clock",
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
      "tunnel-basics",
      "bus-tunnel-3",
      "driver-conflict",
      "sequential-dff",
      "register3",
      "memory-lab",
      "counter3",
    ]);
  });

  it("teaches a disconnected same-name tunnel pair", () => {
    const example = EXAMPLES.find((item) => item.id === "tunnel-basics")!;
    const tunnels = example.document.nodes.filter(
      (node) => node.data.typeId === "wiring.tunnel",
    );

    expect(tunnels.map((node) => node.data.label)).toEqual([
      "tunnel0",
      "tunnel0",
    ]);
    expect(example.document.edges).toEqual([
      expect.objectContaining({ source: "tunnel-input", target: "tunnel-send" }),
      expect.objectContaining({ source: "tunnel-receive", target: "tunnel-probe" }),
    ]);
    expect(
      example.document.edges.some(
        (edge) =>
          new Set([edge.source, edge.target]).has("tunnel-send") &&
          new Set([edge.source, edge.target]).has("tunnel-receive"),
      ),
    ).toBe(false);
    expect(example.expected).toMatch(/没有直接导线.*输出 1/);
  });

  it("defines a runnable 3-trit Memory Lab around one shared address bus", () => {
    const project = cloneExampleProject("memory-lab")!;
    const circuit = project.circuits[0];
    const components = new Map(
      circuit.components.map((component) => [component.id, component]),
    );
    const wires = "wires" in circuit ? circuit.wires : [];

    expect(project).toMatchObject({ version: 3, rootCircuitId: "main" });
    expect(components.get("address")).toMatchObject({
      typeId: "source.trit_input",
      properties: { width: 3, value: "T00" },
    });
    expect(components.get("rom")).toMatchObject({
      typeId: "memory.rom",
      properties: { wordWidth: 3, addressWidth: 3 },
    });
    expect(components.get("ram")).toMatchObject({
      typeId: "memory.ram",
      properties: { wordWidth: 3, addressWidth: 3 },
    });
    expect(
      wires.filter(
        (wire) =>
          wire.endpointA.componentId === "address" &&
          wire.endpointA.portId === "out",
      ),
    ).toHaveLength(2);
    const contents = components.get("rom")!.properties.contents as string[];
    expect([contents[4], contents[13], contents[22]]).toEqual([
      "T01",
      "000",
      "1T0",
    ]);
  });

  it("builds a 3-trit synchronous counter from a register and ripple incrementer", () => {
    const project = cloneExampleProject("counter3")!;
    const circuit = project.circuits.find((item) => item.id === "counter3")!;
    const typeIds = circuit.components.map((component) => component.typeId);
    const wires = "wires" in circuit ? circuit.wires : [];

    expect(project).toMatchObject({ version: 3, rootCircuitId: "main" });
    expect(
      typeIds.filter((typeId) => typeId === "sequential.register"),
    ).toHaveLength(1);
    expect(
      typeIds.filter((typeId) => typeId === "module.full_adder"),
    ).toHaveLength(3);
    expect(
      typeIds.filter((typeId) => typeId === "wiring.splitter"),
    ).toHaveLength(2);
    expect(
      circuit.components.find((component) => component.id === "increment-one"),
    ).toMatchObject({
      typeId: "source.constant",
      properties: { value: "1" },
    });
    expect(wires).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpointA: { componentId: "register", portId: "q" },
          endpointB: { componentId: "current-splitter", portId: "trunk" },
        }),
        expect.objectContaining({
          endpointA: { componentId: "next-splitter", portId: "trunk" },
          endpointB: { componentId: "register", portId: "d" },
        }),
      ]),
    );
  });

  it.each(EXAMPLES)(
    "$name has a structurally valid editable graph",
    (example) => {
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
    },
  );

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
      document.nodes.filter((node) => node.data.typeId === "module.full_adder"),
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
      document.nodes.filter((node) => node.data.typeId === "module.half_adder"),
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
    const halfAdder = project.circuits.find(
      (circuit) => circuit.id === "half-adder",
    )!;
    const fullAdder = project.circuits.find(
      (circuit) => circuit.id === "full-adder",
    )!;
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
      project.circuits
        .flatMap((circuit) => circuit.components)
        .some((component) => component.typeId === "module.full_adder"),
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

  it("defines the 3-trit bus lesson with stable components and placement", () => {
    const project = cloneBusWiringProject();
    const circuit = project.circuits[0];

    expect(project).toMatchObject({
      format: "logsim-ternary",
      version: 3,
      rootCircuitId: "main",
    });
    expect(circuit.components).toEqual([
      {
        id: "word-input",
        typeId: "source.trit_input",
        position: { x: 0, y: 280 },
        properties: { label: "三位输入", value: "1T0", width: 3 },
      },
      {
        id: "split-word",
        typeId: "wiring.splitter",
        position: { x: 250, y: 250 },
        properties: {
          label: "拆分总线",
          width: 3,
          branchCount: 3,
          mapping: [0, 1, 2],
        },
      },
      {
        id: "lst-junction",
        typeId: "wiring.junction",
        position: { x: 460, y: 75 },
        properties: { label: "LST 扇出", width: 1 },
      },
      {
        id: "probe-lst",
        typeId: "sink.probe",
        position: { x: 670, y: 35 },
        properties: { label: "branch0 / LST", width: 1 },
      },
      {
        id: "tunnel-send",
        typeId: "wiring.tunnel",
        position: { x: 550, y: 500 },
        properties: { label: "DATA_MID", width: 1 },
      },
      {
        id: "tunnel-receive",
        typeId: "wiring.tunnel",
        position: { x: 520, y: 170 },
        properties: { label: "DATA_MID", width: 1 },
      },
      {
        id: "probe-mid",
        typeId: "sink.probe",
        position: { x: 730, y: 505 },
        properties: { label: "branch1", width: 1 },
      },
      {
        id: "probe-mst",
        typeId: "sink.probe",
        position: { x: 590, y: 650 },
        properties: { label: "branch2 / MST", width: 1 },
      },
      {
        id: "join-word",
        typeId: "wiring.splitter",
        position: { x: 830, y: 255 },
        properties: {
          label: "重组三位总线",
          width: 3,
          branchCount: 3,
          mapping: [0, 1, 2],
        },
      },
      {
        id: "probe-word",
        typeId: "sink.probe",
        position: { x: 1060, y: 95 },
        properties: { label: "重组输出", width: 3 },
      },
    ]);
  });

  it("routes one scalar branch through a disconnected local tunnel pair", () => {
    const circuit = cloneBusWiringProject().circuits[0];

    expect(circuit.wires).toEqual([
      {
        id: "word-to-split",
        endpointA: { componentId: "word-input", portId: "out" },
        endpointB: { componentId: "split-word", portId: "trunk" },
      },
      {
        id: "branch0-to-junction",
        endpointA: { componentId: "split-word", portId: "branch0" },
        endpointB: { componentId: "lst-junction", portId: "net" },
      },
      {
        id: "junction-to-lst-probe",
        endpointA: { componentId: "lst-junction", portId: "net" },
        endpointB: { componentId: "probe-lst", portId: "in" },
      },
      {
        id: "junction-to-join",
        endpointA: { componentId: "lst-junction", portId: "net" },
        endpointB: { componentId: "join-word", portId: "branch0" },
      },
      {
        id: "branch1-to-tunnel",
        endpointA: { componentId: "split-word", portId: "branch1" },
        endpointB: { componentId: "tunnel-send", portId: "net" },
      },
      {
        id: "tunnel-to-join",
        endpointA: { componentId: "tunnel-receive", portId: "net" },
        endpointB: { componentId: "join-word", portId: "branch1" },
      },
      {
        id: "tunnel-to-mid-probe",
        endpointA: { componentId: "tunnel-receive", portId: "net" },
        endpointB: { componentId: "probe-mid", portId: "in" },
      },
      {
        id: "branch2-to-join",
        endpointA: { componentId: "split-word", portId: "branch2" },
        endpointB: { componentId: "join-word", portId: "branch2" },
      },
      {
        id: "branch2-to-mst-probe",
        endpointA: { componentId: "split-word", portId: "branch2" },
        endpointB: { componentId: "probe-mst", portId: "in" },
      },
      {
        id: "join-to-word-probe",
        endpointA: { componentId: "join-word", portId: "trunk" },
        endpointB: { componentId: "probe-word", portId: "in" },
      },
    ]);

    const tunnels = circuit.components.filter(
      (component) => component.typeId === "wiring.tunnel",
    );
    expect(tunnels.map((component) => component.properties.label)).toEqual([
      "DATA_MID",
      "DATA_MID",
    ]);
    expect(
      circuit.wires.some(
        (wire) =>
          new Set([wire.endpointA.componentId, wire.endpointB.componentId]).has(
            "tunnel-send",
          ) &&
          new Set([wire.endpointA.componentId, wire.endpointB.componentId]).has(
            "tunnel-receive",
          ),
      ),
    ).toBe(false);
  });

  it("deep-clones the bus lesson and registers its inspector teaching notes", () => {
    const copy = cloneBusWiringProject();
    copy.circuits[0].components[0].properties.value = "000";
    copy.circuits[0].wires[0].endpointA.componentId = "changed";

    expect(
      cloneBusWiringProject().circuits[0].components[0].properties.value,
    ).toBe("1T0");
    expect(
      cloneBusWiringProject().circuits[0].wires[0].endpointA.componentId,
    ).toBe("word-input");

    const registered = cloneExampleProject("bus-tunnel-3");
    expect(registered?.version).toBe(3);
    const example = EXAMPLES.find((item) => item.id === "bus-tunnel-3")!;
    expect(example.lessons).toEqual([
      expect.objectContaining({ title: "字序与位序" }),
      expect.objectContaining({ title: "分支映射" }),
      expect.objectContaining({ title: "本地 Tunnel" }),
      expect.objectContaining({ title: "重组与宽度" }),
    ]);
    expect(example.lessons?.map((lesson) => lesson.text).join(" ")).toMatch(
      /MS-first.*index 0.*LST.*\[0,1,2\].*DATA_MID.*同一电路.*1T0.*3-trit.*1-trit/,
    );
  });
});

describe("component help", () => {
  it.each(TYPE_IDS)("%s has a useful Chinese explanation", (typeId) => {
    expect(COMPONENT_HELP[typeId]).toBeDefined();
    expect(COMPONENT_HELP[typeId].summary.length).toBeGreaterThan(12);
    expect(COMPONENT_HELP[typeId].details.length).toBeGreaterThan(12);
  });
});
