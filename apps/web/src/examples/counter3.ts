import type {
  ProjectCircuitV3,
  ProjectDocumentV3,
  ProjectWire,
} from "../project/project-v3";

type Component = ProjectCircuitV3["components"][number];

function component(
  id: string,
  typeId: string,
  x: number,
  y: number,
  properties: Record<string, unknown>,
): Component {
  return { id, typeId, position: { x, y }, properties };
}

function wire(
  id: string,
  componentA: string,
  portA: string,
  componentB: string,
  portB: string,
): ProjectWire {
  return {
    id,
    endpointA: { componentId: componentA, portId: portA },
    endpointB: { componentId: componentB, portId: portB },
  };
}

const counter: ProjectCircuitV3 = {
  id: "counter3",
  name: "Counter3",
  kind: "module",
  components: [
    component("input-clk", "project.module_input", 30, 570, {
      portId: "clk",
      label: "CLK",
      previewValue: "0",
    }),
    component("input-en", "project.module_input", 30, 690, {
      portId: "en",
      label: "EN",
      previewValue: "1",
    }),
    component("input-rst", "project.module_input", 30, 810, {
      portId: "rst",
      label: "RST",
      previewValue: "0",
    }),
    component("increment-one", "source.constant", 30, 70, {
      label: "+1",
      value: "1",
    }),
    component("zero", "source.constant", 30, 250, {
      label: "常量 0",
      value: "0",
    }),
    component("register", "sequential.register", 430, 330, {
      label: "当前计数 Register[3]",
      width: 3,
    }),
    component("current-splitter", "wiring.splitter", 690, 300, {
      label: "当前值 Q2:Q0",
      width: 3,
      branchCount: 3,
      mapping: [0, 1, 2],
    }),
    component("adder-0", "module.full_adder", 930, 60, {
      label: "bit0 + 1",
    }),
    component("adder-1", "module.full_adder", 930, 280, {
      label: "bit1 + carry",
    }),
    component("adder-2", "module.full_adder", 930, 500, {
      label: "bit2 + carry",
    }),
    component("next-splitter", "wiring.splitter", 1190, 300, {
      label: "下一计数 D2:D0",
      width: 3,
      branchCount: 3,
      mapping: [0, 1, 2],
    }),
    component("output-q", "project.module_output", 1190, 720, {
      portId: "q",
      label: "COUNT",
      width: 3,
    }),
    component("overflow", "sink.probe", 1190, 520, {
      label: "最高位进位",
    }),
  ],
  wires: [
    wire("q-split", "register", "q", "current-splitter", "trunk"),
    wire("q-output", "register", "q", "output-q", "in"),
    wire("sum0-next", "adder-0", "sum", "next-splitter", "branch0"),
    wire("sum1-next", "adder-1", "sum", "next-splitter", "branch1"),
    wire("sum2-next", "adder-2", "sum", "next-splitter", "branch2"),
    wire("next-register", "next-splitter", "trunk", "register", "d"),
    wire("q0-adder", "current-splitter", "branch0", "adder-0", "a"),
    wire("q1-adder", "current-splitter", "branch1", "adder-1", "a"),
    wire("q2-adder", "current-splitter", "branch2", "adder-2", "a"),
    wire("one-adder0", "increment-one", "out", "adder-0", "b"),
    wire("zero-cin0", "zero", "out", "adder-0", "cin"),
    wire("zero-b1", "zero", "out", "adder-1", "b"),
    wire("zero-b2", "zero", "out", "adder-2", "b"),
    wire("carry0", "adder-0", "carry", "adder-1", "cin"),
    wire("carry1", "adder-1", "carry", "adder-2", "cin"),
    wire("carry2", "adder-2", "carry", "overflow", "in"),
    wire("clk-register", "input-clk", "out", "register", "clk"),
    wire("en-register", "input-en", "out", "register", "en"),
    wire("rst-register", "input-rst", "out", "register", "rst"),
  ],
  viewport: { x: 100, y: 75, zoom: 0.58 },
};

const main: ProjectCircuitV3 = {
  id: "main",
  name: "3-trit Counter Demo",
  kind: "main",
  components: [
    component("clock", "source.clock", 80, 160, { label: "Clock" }),
    component("enable", "source.trit_input", 80, 340, {
      label: "计数使能 EN=1",
      value: "1",
    }),
    component("reset", "source.trit_input", 80, 520, {
      label: "同步复位 RST=0",
      value: "0",
    }),
    component("counter", "project.module_instance", 430, 300, {
      moduleId: "counter3",
      label: "Counter3",
    }),
    component("count", "sink.probe", 820, 300, {
      label: "3-trit 计数值",
      width: 3,
    }),
  ],
  wires: [
    wire("clock-counter", "clock", "out", "counter", "clk"),
    wire("enable-counter", "enable", "out", "counter", "en"),
    wire("reset-counter", "reset", "out", "counter", "rst"),
    wire("counter-probe", "counter", "q", "count", "in"),
  ],
  viewport: { x: 165, y: 105, zoom: 0.82 },
};

export const COUNTER3_PROJECT: ProjectDocumentV3 = {
  format: "logsim-ternary",
  version: 3,
  rootCircuitId: "main",
  circuits: [main, counter],
};

export function cloneCounter3Project(): ProjectDocumentV3 {
  return structuredClone(COUNTER3_PROJECT);
}
