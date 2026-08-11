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

const romContents = Array<string>(27).fill("000");
romContents[4] = "T01";
romContents[13] = "000";
romContents[22] = "1T0";

const main: ProjectCircuitV3 = {
  id: "main",
  name: "Memory Lab",
  kind: "main",
  components: [
    component("address", "source.trit_input", 40, 245, {
      label: "地址 T00",
      width: 3,
      value: "T00",
    }),
    component("rom", "memory.rom", 360, 100, {
      label: "程序 ROM",
      wordWidth: 3,
      addressWidth: 3,
      contents: romContents,
    }),
    component("rom-output", "sink.probe", 720, 100, {
      label: "ROM DATA",
      width: 3,
    }),
    component("data-input", "source.trit_input", 40, 465, {
      label: "写入数据 1T0",
      width: 3,
      value: "1T0",
    }),
    component("write-enable", "source.trit_input", 280, 595, {
      label: "写使能 WE=1",
      value: "1",
    }),
    component("clock", "source.clock", 510, 650, { label: "Clock" }),
    component("reset", "source.trit_input", 40, 650, {
      label: "复位 RST=0",
      value: "0",
    }),
    component("ram", "memory.ram", 560, 360, {
      label: "数据 RAM",
      wordWidth: 3,
      addressWidth: 3,
    }),
    component("ram-output", "sink.probe", 900, 360, {
      label: "RAM DOUT",
      width: 3,
    }),
  ],
  wires: [
    wire("address-rom", "address", "out", "rom", "addr"),
    wire("address-ram", "address", "out", "ram", "addr"),
    wire("rom-probe", "rom", "data", "rom-output", "in"),
    wire("data-ram", "data-input", "out", "ram", "din"),
    wire("we-ram", "write-enable", "out", "ram", "we"),
    wire("clock-ram", "clock", "out", "ram", "clk"),
    wire("reset-ram", "reset", "out", "ram", "rst"),
    wire("ram-probe", "ram", "dout", "ram-output", "in"),
  ],
  viewport: { x: 145, y: 70, zoom: 0.72 },
};

export const MEMORY_LAB_PROJECT: ProjectDocumentV3 = {
  format: "logsim-ternary",
  version: 3,
  rootCircuitId: "main",
  circuits: [main],
};

export function cloneMemoryLabProject(): ProjectDocumentV3 {
  return structuredClone(MEMORY_LAB_PROJECT);
}
