import type {
  ProjectCircuit,
  ProjectDocumentV2,
} from "../project/project-document";

type Component = ProjectCircuit["components"][number];
type Connection = ProjectCircuit["connections"][number];

function component(
  id: string,
  typeId: string,
  x: number,
  y: number,
  properties: Record<string, unknown>,
): Component {
  return { id, typeId, position: { x, y }, properties };
}

function connection(
  id: string,
  sourceComponentId: string,
  sourcePortId: string,
  targetComponentId: string,
  targetPortId: string,
): Connection {
  return {
    id,
    sourceComponentId,
    sourcePortId,
    targetComponentId,
    targetPortId,
  };
}

const halfAdder: ProjectCircuit = {
  id: "half-adder",
  name: "Half Adder",
  kind: "module",
  components: [
    component("input-a", "project.module_input", 70, 120, {
      portId: "a",
      label: "A",
      previewValue: "0",
    }),
    component("input-b", "project.module_input", 70, 400, {
      portId: "b",
      label: "B",
      previewValue: "0",
    }),
    component("sum-gate", "gate.mod_sum", 370, 140, {
      label: "MOD_SUM 本位和",
    }),
    component("carry-gate", "gate.consensus", 370, 390, {
      label: "CONSENSUS 进位",
    }),
    component("output-sum", "project.module_output", 700, 140, {
      portId: "sum",
      label: "SUM",
    }),
    component("output-carry", "project.module_output", 700, 390, {
      portId: "carry",
      label: "CARRY",
    }),
  ],
  connections: [
    connection("a-sum", "input-a", "out", "sum-gate", "a"),
    connection("b-sum", "input-b", "out", "sum-gate", "b"),
    connection("a-carry", "input-a", "out", "carry-gate", "a"),
    connection("b-carry", "input-b", "out", "carry-gate", "b"),
    connection("sum-output", "sum-gate", "y", "output-sum", "in"),
    connection("carry-output", "carry-gate", "y", "output-carry", "in"),
  ],
  viewport: { x: 35, y: 80, zoom: 0.92 },
};

const fullAdder: ProjectCircuit = {
  id: "full-adder",
  name: "Full Adder",
  kind: "module",
  components: [
    component("input-a", "project.module_input", 40, 80, {
      portId: "a",
      label: "A",
      previewValue: "0",
    }),
    component("input-b", "project.module_input", 40, 270, {
      portId: "b",
      label: "B",
      previewValue: "0",
    }),
    component("input-cin", "project.module_input", 40, 500, {
      portId: "cin",
      label: "CIN",
      previewValue: "0",
    }),
    component("half-adder-1", "project.module_instance", 330, 165, {
      moduleId: "half-adder",
      label: "HA1: A + B",
    }),
    component("half-adder-2", "project.module_instance", 650, 230, {
      moduleId: "half-adder",
      label: "HA2: Partial + CIN",
    }),
    component("carry-merge", "gate.mod_sum", 650, 490, {
      label: "MOD_SUM 合并进位",
    }),
    component("output-sum", "project.module_output", 970, 220, {
      portId: "sum",
      label: "SUM",
    }),
    component("output-carry", "project.module_output", 970, 490, {
      portId: "carry",
      label: "CARRY",
    }),
  ],
  connections: [
    connection("a-ha1", "input-a", "out", "half-adder-1", "a"),
    connection("b-ha1", "input-b", "out", "half-adder-1", "b"),
    connection("partial-ha2", "half-adder-1", "sum", "half-adder-2", "a"),
    connection("cin-ha2", "input-cin", "out", "half-adder-2", "b"),
    connection("ha2-sum", "half-adder-2", "sum", "output-sum", "in"),
    connection("carry1-merge", "half-adder-1", "carry", "carry-merge", "a"),
    connection("carry2-merge", "half-adder-2", "carry", "carry-merge", "b"),
    connection("merge-carry", "carry-merge", "y", "output-carry", "in"),
  ],
  viewport: { x: 20, y: 55, zoom: 0.78 },
};

const main: ProjectCircuit = {
  id: "main",
  name: "Main",
  kind: "main",
  components: [
    component("input-a", "source.trit_input", 60, 80, {
      value: "1",
      label: "输入 A",
    }),
    component("input-b", "source.trit_input", 60, 280, {
      value: "1",
      label: "输入 B",
    }),
    component("input-cin", "source.trit_input", 60, 500, {
      value: "0",
      label: "进位 CIN",
    }),
    component("full-adder-1", "project.module_instance", 420, 260, {
      moduleId: "full-adder",
      label: "Full Adder 1",
    }),
    component("probe-sum", "sink.probe", 790, 180, {
      label: "本位和 SUM",
    }),
    component("probe-carry", "sink.probe", 790, 420, {
      label: "进位 CARRY",
    }),
  ],
  connections: [
    connection("a-full", "input-a", "out", "full-adder-1", "a"),
    connection("b-full", "input-b", "out", "full-adder-1", "b"),
    connection("cin-full", "input-cin", "out", "full-adder-1", "cin"),
    connection("sum-probe", "full-adder-1", "sum", "probe-sum", "in"),
    connection("carry-probe", "full-adder-1", "carry", "probe-carry", "in"),
  ],
  viewport: { x: 120, y: 75, zoom: 0.86 },
};

const HIERARCHICAL_ADDER_PROJECT: ProjectDocumentV2 = {
  format: "logsim-ternary",
  version: 2,
  rootCircuitId: "main",
  circuits: [main, fullAdder, halfAdder],
};

export function cloneHierarchicalAdderProject(): ProjectDocumentV2 {
  return structuredClone(HIERARCHICAL_ADDER_PROJECT);
}
