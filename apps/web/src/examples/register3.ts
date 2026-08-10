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

const register3: ProjectCircuit = {
  id: "register3",
  name: "Register3",
  kind: "module",
  components: [
    component("input-d2", "project.module_input", 40, 40, {
      portId: "d2",
      label: "D2",
      previewValue: "1",
    }),
    component("input-d1", "project.module_input", 40, 165, {
      portId: "d1",
      label: "D1",
      previewValue: "T",
    }),
    component("input-d0", "project.module_input", 40, 290, {
      portId: "d0",
      label: "D0",
      previewValue: "0",
    }),
    component("input-clk", "project.module_input", 40, 415, {
      portId: "clk",
      label: "CLK",
      previewValue: "0",
    }),
    component("input-en", "project.module_input", 40, 540, {
      portId: "en",
      label: "EN",
      previewValue: "1",
    }),
    component("input-rst", "project.module_input", 40, 665, {
      portId: "rst",
      label: "RST",
      previewValue: "0",
    }),
    component("dff-2", "sequential.dff", 410, 80, { label: "DFF2" }),
    component("dff-1", "sequential.dff", 410, 300, { label: "DFF1" }),
    component("dff-0", "sequential.dff", 410, 520, { label: "DFF0" }),
    component("output-q2", "project.module_output", 780, 80, {
      portId: "q2",
      label: "Q2",
    }),
    component("output-q1", "project.module_output", 780, 300, {
      portId: "q1",
      label: "Q1",
    }),
    component("output-q0", "project.module_output", 780, 520, {
      portId: "q0",
      label: "Q0",
    }),
  ],
  connections: [
    connection("d2", "input-d2", "out", "dff-2", "d"),
    connection("d1", "input-d1", "out", "dff-1", "d"),
    connection("d0", "input-d0", "out", "dff-0", "d"),
    connection("clk-2", "input-clk", "out", "dff-2", "clk"),
    connection("clk-1", "input-clk", "out", "dff-1", "clk"),
    connection("clk-0", "input-clk", "out", "dff-0", "clk"),
    connection("en-2", "input-en", "out", "dff-2", "en"),
    connection("en-1", "input-en", "out", "dff-1", "en"),
    connection("en-0", "input-en", "out", "dff-0", "en"),
    connection("rst-2", "input-rst", "out", "dff-2", "rst"),
    connection("rst-1", "input-rst", "out", "dff-1", "rst"),
    connection("rst-0", "input-rst", "out", "dff-0", "rst"),
    connection("q2", "dff-2", "q", "output-q2", "in"),
    connection("q1", "dff-1", "q", "output-q1", "in"),
    connection("q0", "dff-0", "q", "output-q0", "in"),
  ],
  viewport: { x: 65, y: 25, zoom: 0.78 },
};

const main: ProjectCircuit = {
  id: "main",
  name: "3-trit Register Demo",
  kind: "main",
  components: [
    component("input-d2", "source.trit_input", 40, 45, {
      value: "1",
      label: "D2 最高位",
    }),
    component("input-d1", "source.trit_input", 40, 205, {
      value: "T",
      label: "D1",
    }),
    component("input-d0", "source.trit_input", 40, 365, {
      value: "0",
      label: "D0 最低位",
    }),
    component("clock-1", "source.clock", 285, 650, { label: "Clock" }),
    component("input-en", "source.trit_input", 40, 540, {
      value: "1",
      label: "EN",
    }),
    component("input-rst", "source.trit_input", 40, 700, {
      value: "0",
      label: "RST",
    }),
    component("register-1", "project.module_instance", 500, 300, {
      moduleId: "register3",
      label: "Register3",
    }),
    component("probe-q2", "sink.probe", 870, 100, { label: "Q2 最高位" }),
    component("probe-q1", "sink.probe", 870, 300, { label: "Q1" }),
    component("probe-q0", "sink.probe", 870, 500, { label: "Q0 最低位" }),
  ],
  connections: [
    connection("d2-register", "input-d2", "out", "register-1", "d2"),
    connection("d1-register", "input-d1", "out", "register-1", "d1"),
    connection("d0-register", "input-d0", "out", "register-1", "d0"),
    connection("clock-register", "clock-1", "out", "register-1", "clk"),
    connection("en-register", "input-en", "out", "register-1", "en"),
    connection("rst-register", "input-rst", "out", "register-1", "rst"),
    connection("q2-probe", "register-1", "q2", "probe-q2", "in"),
    connection("q1-probe", "register-1", "q1", "probe-q1", "in"),
    connection("q0-probe", "register-1", "q0", "probe-q0", "in"),
  ],
  viewport: { x: 105, y: 25, zoom: 0.76 },
};

const REGISTER3_PROJECT: ProjectDocumentV2 = {
  format: "logsim-ternary",
  version: 2,
  rootCircuitId: "main",
  circuits: [main, register3],
};

export function cloneRegister3Project(): ProjectDocumentV2 {
  return structuredClone(REGISTER3_PROJECT);
}

