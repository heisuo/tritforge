import type {
  EditorDocument,
  EditorEdge,
  EditorNode,
  KnownTrit,
} from "./editor-model";
import { toEditorDocument } from "./editor/circuit-document";
import { cloneBusWiringProject } from "./examples/bus-wiring";
import { cloneCounter3Project } from "./examples/counter3";
import { cloneHierarchicalAdderProject } from "./examples/hierarchical-adder";
import { cloneMemoryLabProject } from "./examples/memory-lab";
import { cloneRegister3Project } from "./examples/register3";
import { cloneSequentialDffProject } from "./examples/sequential-dff";
import type { ProjectDocumentV2 } from "./project/project-document";
import type { ProjectDocumentV3 } from "./project/project-v3";

export type ExampleId =
  | "neg"
  | "min-max"
  | "decoder"
  | "mux3"
  | "half-adder"
  | "full-adder"
  | "hierarchical-adder"
  | "ripple-adder-3"
  | "tunnel-basics"
  | "bus-tunnel-3"
  | "driver-conflict"
  | "sequential-dff"
  | "register3"
  | "memory-lab"
  | "counter3";

export interface TernaryExample {
  id: ExampleId;
  name: string;
  category: string;
  description: string;
  composition: string;
  expected: string;
  lessons?: Array<{ title: string; text: string }>;
  document: EditorDocument;
  project?: ProjectDocumentV2 | ProjectDocumentV3;
}

function node(
  id: string,
  typeId: string,
  label: string,
  x: number,
  y: number,
  sourceValue?: KnownTrit,
): EditorNode {
  return {
    id,
    type: "component",
    position: { x, y },
    data: { typeId, label, ...(sourceValue ? { sourceValue } : {}) },
  };
}

function edge(
  id: string,
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
): EditorEdge {
  return { id, source, sourceHandle, target, targetHandle };
}

const hierarchicalProject = cloneHierarchicalAdderProject();
const hierarchicalRoot = hierarchicalProject.circuits.find(
  (circuit) => circuit.id === hierarchicalProject.rootCircuitId,
)!;
const hierarchicalRootDocument = toEditorDocument({
  format: "logsim-ternary",
  version: 1,
  components: hierarchicalRoot.components,
  connections: hierarchicalRoot.connections,
  ...(hierarchicalRoot.viewport ? { viewport: hierarchicalRoot.viewport } : {}),
});
const sequentialDffProject = cloneSequentialDffProject();
const sequentialDffRoot = sequentialDffProject.circuits[0];
const sequentialDffDocument = toEditorDocument({
  format: "logsim-ternary",
  version: 1,
  components: sequentialDffRoot.components,
  connections: sequentialDffRoot.connections,
  ...(sequentialDffRoot.viewport
    ? { viewport: sequentialDffRoot.viewport }
    : {}),
});
const register3Project = cloneRegister3Project();
const register3Root = register3Project.circuits[0];
const register3Document = toEditorDocument({
  format: "logsim-ternary",
  version: 1,
  components: register3Root.components,
  connections: register3Root.connections,
  ...(register3Root.viewport ? { viewport: register3Root.viewport } : {}),
});
const busWiringProject = cloneBusWiringProject();
const busWiringRoot = busWiringProject.circuits[0];
const busWiringDocument: EditorDocument = {
  nodes: busWiringRoot.components.map((item) => {
    const { label, value, ...properties } = item.properties;
    return {
      id: item.id,
      type: "component",
      position: { ...item.position },
      data: {
        typeId: item.typeId,
        label: typeof label === "string" ? label : item.typeId,
        ...(typeof value === "string" ? { sourceValue: value } : {}),
        ...(Object.keys(properties).length > 0
          ? { properties: structuredClone(properties) }
          : {}),
      },
    };
  }),
  edges: busWiringRoot.wires.map((item) => ({
    id: item.id,
    source: item.endpointA.componentId,
    sourceHandle: item.endpointA.portId,
    target: item.endpointB.componentId,
    targetHandle: item.endpointB.portId,
  })),
};
const memoryLabProject = cloneMemoryLabProject();
const memoryLabRoot = memoryLabProject.circuits[0];
const memoryLabDocument: EditorDocument = {
  nodes: memoryLabRoot.components.map((item) => {
    const { label, value, ...properties } = item.properties;
    return {
      id: item.id,
      type: "component",
      position: { ...item.position },
      data: {
        typeId: item.typeId,
        label: typeof label === "string" ? label : item.typeId,
        ...(typeof value === "string" ? { sourceValue: value } : {}),
        ...(Object.keys(properties).length > 0
          ? { properties: structuredClone(properties) }
          : {}),
      },
    };
  }),
  edges: memoryLabRoot.wires.map((item) => ({
    id: item.id,
    source: item.endpointA.componentId,
    sourceHandle: item.endpointA.portId,
    target: item.endpointB.componentId,
    targetHandle: item.endpointB.portId,
  })),
};
const counter3Project = cloneCounter3Project();
const counter3Root = counter3Project.circuits[0];
const counter3Document: EditorDocument = {
  nodes: counter3Root.components.map((item) => {
    const { label, value, ...properties } = item.properties;
    return {
      id: item.id,
      type: "component",
      position: { ...item.position },
      data: {
        typeId: item.typeId,
        label: typeof label === "string" ? label : item.typeId,
        ...(typeof value === "string" ? { sourceValue: value } : {}),
        ...(Object.keys(properties).length > 0
          ? { properties: structuredClone(properties) }
          : {}),
      },
    };
  }),
  edges: counter3Root.wires.map((item) => ({
    id: item.id,
    source: item.endpointA.componentId,
    sourceHandle: item.endpointA.portId,
    target: item.endpointB.componentId,
    targetHandle: item.endpointB.portId,
  })),
};

export const EXAMPLES: TernaryExample[] = [
  {
    id: "neg",
    name: "三进制取反",
    category: "基础门",
    description: "观察 T、0、1 经过 NEG 后正负互换、零保持不变。",
    composition: "Trit Input → NEG → Probe",
    expected: "默认输入 0，Probe 输出 0",
    document: {
      nodes: [
        node("input-1", "source.trit_input", "Trit Input", 100, 250, "0"),
        node("neg-1", "gate.neg", "NEG", 390, 250),
        node("probe-1", "sink.probe", "Probe", 680, 250),
      ],
      edges: [
        edge("wire-input-neg", "input-1", "out", "neg-1", "a"),
        edge("wire-neg-probe", "neg-1", "y", "probe-1", "in"),
      ],
    },
  },
  {
    id: "min-max",
    name: "MIN / MAX 并行比较",
    category: "二元逻辑",
    description: "把同一对输入同时送入 MIN 和 MAX，比较两种门的结果。",
    composition: "Input T + Input 1 → MIN / MAX → 2 Probes",
    expected: "MIN 输出 T，MAX 输出 1",
    document: {
      nodes: [
        node("input-a", "source.trit_input", "输入 A", 70, 145, "T"),
        node("input-b", "source.trit_input", "输入 B", 70, 405, "1"),
        node("min-1", "gate.min", "MIN", 390, 125),
        node("max-1", "gate.max", "MAX", 390, 425),
        node("probe-min", "sink.probe", "MIN Probe", 710, 125),
        node("probe-max", "sink.probe", "MAX Probe", 710, 425),
      ],
      edges: [
        edge("a-min", "input-a", "out", "min-1", "a"),
        edge("b-min", "input-b", "out", "min-1", "b"),
        edge("a-max", "input-a", "out", "max-1", "a"),
        edge("b-max", "input-b", "out", "max-1", "b"),
        edge("min-probe", "min-1", "y", "probe-min", "in"),
        edge("max-probe", "max-1", "y", "probe-max", "in"),
      ],
    },
  },
  {
    id: "decoder",
    name: "三态一位有效译码",
    category: "条件判断",
    description: "用三个判断门把一个 trit 解码为负、零、正三路条件。",
    composition: "Input 0 → IS_NEG / IS_ZERO / IS_POS → 3 Probes",
    expected: "IS_ZERO 输出 1，其余两路输出 T",
    document: {
      nodes: [
        node("decoder-input", "source.trit_input", "译码输入", 70, 285, "0"),
        node("is-neg", "gate.is_neg", "IS_NEG", 340, 85),
        node("is-zero", "gate.is_zero", "IS_ZERO", 340, 285),
        node("is-pos", "gate.is_pos", "IS_POS", 340, 485),
        node("probe-neg", "sink.probe", "负值", 650, 85),
        node("probe-zero", "sink.probe", "零值", 650, 285),
        node("probe-pos", "sink.probe", "正值", 650, 485),
      ],
      edges: [
        edge("input-neg", "decoder-input", "out", "is-neg", "a"),
        edge("input-zero", "decoder-input", "out", "is-zero", "a"),
        edge("input-pos", "decoder-input", "out", "is-pos", "a"),
        edge("neg-probe", "is-neg", "y", "probe-neg", "in"),
        edge("zero-probe", "is-zero", "y", "probe-zero", "in"),
        edge("pos-probe", "is-pos", "y", "probe-pos", "in"),
      ],
    },
  },
  {
    id: "mux3",
    name: "MUX3 三路选择",
    category: "数据通路",
    description: "三路常量作为数据输入，用一个 Trit Input 控制输出路由。",
    composition: "Constant T / 0 / 1 + Selector → MUX3 → Probe",
    expected: "默认选择端为 0，因此输出中间数据 0",
    document: {
      nodes: [
        node("data-t", "source.constant", "数据 T", 60, 70, "T"),
        node("data-0", "source.constant", "数据 0", 60, 245, "0"),
        node("data-1", "source.constant", "数据 1", 60, 420, "1"),
        node("selector", "source.trit_input", "选择端", 300, 545, "0"),
        node("mux3-1", "gate.mux3", "MUX3", 410, 245),
        node("mux-probe", "sink.probe", "选择输出", 750, 245),
      ],
      edges: [
        edge("t-a", "data-t", "out", "mux3-1", "a"),
        edge("zero-b", "data-0", "out", "mux3-1", "b"),
        edge("one-c", "data-1", "out", "mux3-1", "c"),
        edge("selector-s", "selector", "out", "mux3-1", "s"),
        edge("mux-probe", "mux3-1", "y", "mux-probe", "in"),
      ],
    },
  },
  {
    id: "half-adder",
    name: "基础门搭建单 trit 半加器",
    category: "门级算术",
    description:
      "用 MOD_SUM 计算本位和，用 CONSENSUS 计算进位，结构对应三进制的 XOR 与 AND。",
    composition: "a + b → MOD_SUM / CONSENSUS → sum / carry",
    expected: "默认 1 + 1：sum=T，carry=1，合起来是 1T₃（十进制 2）",
    document: {
      nodes: [
        node("ha-a", "source.trit_input", "输入 a", 80, 130, "1"),
        node("ha-b", "source.trit_input", "输入 b", 80, 390, "1"),
        node("ha-mod-sum", "gate.mod_sum", "MOD_SUM 本位和", 420, 130),
        node("ha-consensus", "gate.consensus", "CONSENSUS 进位", 420, 390),
        node("ha-sum", "sink.probe", "本位和 sum", 760, 130),
        node("ha-carry", "sink.probe", "进位 carry", 760, 390),
      ],
      edges: [
        edge("ha-a-sum", "ha-a", "out", "ha-mod-sum", "a"),
        edge("ha-b-sum", "ha-b", "out", "ha-mod-sum", "b"),
        edge("ha-a-carry", "ha-a", "out", "ha-consensus", "a"),
        edge("ha-b-carry", "ha-b", "out", "ha-consensus", "b"),
        edge("ha-sum-probe", "ha-mod-sum", "y", "ha-sum", "in"),
        edge("ha-carry-probe", "ha-consensus", "y", "ha-carry", "in"),
      ],
    },
  },
  {
    id: "full-adder",
    name: "半加器组合单 trit 全加器",
    category: "层次化算术",
    description:
      "两个 Half Adder 依次加入 a、b、cin，再用 MOD_SUM 合并两级产生的进位。",
    composition: "HA1(a,b) → HA2(partial,cin) → sum；MOD_SUM(c1,c2) → carry",
    expected: "默认 1 + 1 + 0：sum=T，carry=1，合起来是 1T₃（十进制 2）",
    document: {
      nodes: [
        node("fa-a", "source.trit_input", "输入 a", 60, 70, "1"),
        node("fa-b", "source.trit_input", "输入 b", 60, 270, "1"),
        node("fa-cin", "source.trit_input", "低位进位 cin", 60, 500, "0"),
        node("fa-ha1", "module.half_adder", "HA1：a + b", 360, 180),
        node("fa-ha2", "module.half_adder", "HA2：部分和 + cin", 700, 250),
        node("fa-carry-merge", "gate.mod_sum", "合并进位 c1 + c2", 700, 500),
        node("fa-sum", "sink.probe", "本位和 sum", 1040, 210),
        node("fa-carry", "sink.probe", "最终进位 carry", 1040, 500),
      ],
      edges: [
        edge("fa-a-ha1", "fa-a", "out", "fa-ha1", "a"),
        edge("fa-b-ha1", "fa-b", "out", "fa-ha1", "b"),
        edge("fa-partial-ha2", "fa-ha1", "sum", "fa-ha2", "a"),
        edge("fa-cin-ha2", "fa-cin", "out", "fa-ha2", "b"),
        edge("fa-ha2-sum", "fa-ha2", "sum", "fa-sum", "in"),
        edge("fa-c1-merge", "fa-ha1", "carry", "fa-carry-merge", "a"),
        edge("fa-c2-merge", "fa-ha2", "carry", "fa-carry-merge", "b"),
        edge("fa-merge-carry", "fa-carry-merge", "y", "fa-carry", "in"),
      ],
    },
  },
  {
    id: "hierarchical-adder",
    name: "可展开的层级全加器",
    category: "层级子电路",
    description:
      "主电路实例化 Full Adder，内部再由两个可进入、可编辑的 Half Adder 组成。",
    composition: "Main → Full Adder → 2 × Half Adder → 基础门",
    expected: "默认 1 + 1 + 0：SUM=T，CARRY=1；双击实例可逐层查看",
    document: hierarchicalRootDocument,
    project: cloneHierarchicalAdderProject(),
  },
  {
    id: "ripple-adder-3",
    name: "3-trit 行波进位加法器",
    category: "多 trit 算术",
    description:
      "三个全加器从最低位到最高位串联，前一级 carry 接到后一级 cin。",
    composition: "A[2:0] + B[2:0] → FA0 → FA1 → FA2 → S[2:0] + Cout",
    expected: "默认 001₃ + 001₃ = 01T₃：S2=0、S1=1、S0=T、Cout=0",
    document: {
      nodes: [
        node("a0", "source.trit_input", "A0 最低位", 20, 160, "1"),
        node("b0", "source.trit_input", "B0 最低位", 20, 330, "1"),
        node("cin-zero", "source.constant", "初始进位 0", 20, 500, "0"),
        node("fa0", "module.full_adder", "FA0 最低位", 270, 300),
        node("s0", "sink.probe", "S0", 540, 490),

        node("a1", "source.trit_input", "A1", 450, 70, "0"),
        node("b1", "source.trit_input", "B1", 450, 200, "0"),
        node("fa1", "module.full_adder", "FA1", 700, 300),
        node("s1", "sink.probe", "S1", 970, 490),

        node("a2", "source.trit_input", "A2 最高位", 880, 70, "0"),
        node("b2", "source.trit_input", "B2 最高位", 880, 200, "0"),
        node("fa2", "module.full_adder", "FA2 最高位", 1130, 300),
        node("s2", "sink.probe", "S2", 1420, 220),
        node("cout", "sink.probe", "最终进位 Cout", 1420, 420),
      ],
      edges: [
        edge("a0-fa0", "a0", "out", "fa0", "a"),
        edge("b0-fa0", "b0", "out", "fa0", "b"),
        edge("zero-fa0", "cin-zero", "out", "fa0", "cin"),
        edge("fa0-s0", "fa0", "sum", "s0", "in"),
        edge("carry0-fa1", "fa0", "carry", "fa1", "cin"),

        edge("a1-fa1", "a1", "out", "fa1", "a"),
        edge("b1-fa1", "b1", "out", "fa1", "b"),
        edge("fa1-s1", "fa1", "sum", "s1", "in"),
        edge("carry1-fa2", "fa1", "carry", "fa2", "cin"),

        edge("a2-fa2", "a2", "out", "fa2", "a"),
        edge("b2-fa2", "b2", "out", "fa2", "b"),
        edge("fa2-s2", "fa2", "sum", "s2", "in"),
        edge("fa2-cout", "fa2", "carry", "cout", "in"),
      ],
    },
  },
  {
    id: "tunnel-basics",
    name: "Tunnel 隔空连线入门",
    category: "基础布线",
    description:
      "两个名称相同的 Tunnel 属于同一条本地网络，可以省略画布中间的长导线。",
    composition: "Input → tunnel0   tunnel0 → Probe",
    expected: "两个 Tunnel 之间没有直接导线，但 Probe 输出 1。",
    lessons: [
      {
        title: "同名即连接",
        text: "发送端和接收端都叫 tunnel0，因此它们在当前电路内属于同一网络。",
      },
      {
        title: "名称可以修改",
        text: "新放置的隧道会自动命名为 tunnel0、tunnel1……需要连接时，在属性栏把两个隧道改成相同名称。",
      },
      {
        title: "只在本地生效",
        text: "Tunnel 名称不会跨越子电路边界；不同模块中的同名 Tunnel 不会自动连接。",
      },
    ],
    document: {
      nodes: [
        node("tunnel-input", "source.trit_input", "输入 1", 90, 180, "1"),
        {
          id: "tunnel-send",
          type: "component",
          position: { x: 390, y: 180 },
          data: {
            typeId: "wiring.tunnel",
            label: "tunnel0",
            properties: { width: 1 },
          },
        },
        {
          id: "tunnel-receive",
          type: "component",
          position: { x: 650, y: 390 },
          data: {
            typeId: "wiring.tunnel",
            label: "tunnel0",
            properties: { width: 1 },
          },
        },
        node("tunnel-probe", "sink.probe", "隔空输出", 950, 390),
      ],
      edges: [
        edge(
          "input-to-tunnel",
          "tunnel-input",
          "out",
          "tunnel-send",
          "net",
        ),
        edge(
          "tunnel-to-probe",
          "tunnel-receive",
          "net",
          "tunnel-probe",
          "in",
        ),
      ],
    },
  },
  {
    id: "bus-tunnel-3",
    name: "3-trit 总线、分线与本地 Tunnel",
    category: "总线布线",
    description:
      "把一个 3-trit 字拆成三条标量支路，中间支路通过同名 Tunnel 跨越空白区域，再按原位序重组。",
    composition:
      "Input[3] → Splitter → Junction / DATA_MID Tunnel / direct → Splitter → Probe[3]",
    expected: "输入与重组结果均为 1T0；三条支路依次显示 0、T、1。",
    lessons: [
      {
        title: "字序与位序",
        text: "界面按 MS-first 显示 1T0；内部 index 0 是 LST，所以 branch0 取到最右侧的 0。",
      },
      {
        title: "分支映射",
        text: "映射 [0,1,2] 表示 trunk 的 index 0、1、2 分别进入 branch0、1、2。",
      },
      {
        title: "本地 Tunnel",
        text: "两个 DATA_MID 没有直连 wire，但同名 Tunnel 会在同一电路内连接；名称不会跨子电路生效。",
      },
      {
        title: "重组与宽度",
        text: "第二个 Splitter 以相同映射重组出 1T0；3-trit 端口不能直接接 1-trit 端口，必须先分线。",
      },
    ],
    document: busWiringDocument,
    project: cloneBusWiringProject(),
  },
  {
    id: "driver-conflict",
    name: "多驱动冲突",
    category: "网络诊断",
    description: "让两个不同的已知值驱动同一输入，观察网络进入错误状态 E。",
    composition: "Constant T + Constant 1 → 同一个 Probe",
    expected: "Probe 显示 E，并产生 MULTIPLE_DRIVER_CONFLICT",
    document: {
      nodes: [
        node("driver-t", "source.constant", "驱动 T", 100, 155, "T"),
        node("driver-1", "source.constant", "驱动 1", 100, 405, "1"),
        node("conflict-probe", "sink.probe", "冲突 Probe", 560, 280),
      ],
      edges: [
        edge("t-conflict", "driver-t", "out", "conflict-probe", "in"),
        edge("one-conflict", "driver-1", "out", "conflict-probe", "in"),
      ],
    },
  },
  {
    id: "sequential-dff",
    name: "单 trit DFF",
    category: "时序电路",
    description: "用 D、Clock、EN 和同步 RST 驱动一个可单步观察的 D 型触发器。",
    composition: "D Input + Clock + EN + RST → DFF → Q Probe",
    expected: "默认 D=1、EN=1、RST=0，载入时 Q=0，单步后 Q=1",
    document: sequentialDffDocument,
    project: cloneSequentialDffProject(),
  },
  {
    id: "register3",
    name: "3-trit 并行寄存器",
    category: "时序电路",
    description:
      "用三个共享 Clock、EN 和同步 RST 的 DFF 并行保存一个 3-trit 字。",
    composition: "D2:D0 + Clock + EN + RST → 3 × DFF → Q2:Q0",
    expected: "默认 D=1T0，载入时 Q=000，单步后 Q=1T0（十进制 6）",
    document: register3Document,
    project: cloneRegister3Project(),
  },
  {
    id: "memory-lab",
    name: "三进制 Memory Lab",
    category: "存储器",
    description:
      "用同一条 3-trit 地址总线观察 ROM 异步读取，并演示 RAM 的写入、保持和复位。",
    composition: "Address → ROM / RAM；DIN + WE + Clock + RST → RAM",
    expected: "默认地址 T00：ROM 输出 T01，RAM 输出 000；单步后 RAM 写入 1T0",
    document: memoryLabDocument,
    project: cloneMemoryLabProject(),
  },
  {
    id: "counter3",
    name: "3-trit 同步计数器",
    category: "时序系统",
    description:
      "用 Register[3] 保存当前计数，用三个全加器组成 +1 行波进位器；每次 Tick 递增一次。",
    composition:
      "Register[3] → Splitter → 3 × Full Adder (+001) → Splitter → D",
    expected:
      "默认从 000 开始；连续 Tick 得到 001、01T、010……十进制为 1、2、3……",
    document: counter3Document,
    project: cloneCounter3Project(),
  },
];

export function cloneExampleDocument(id: ExampleId): EditorDocument {
  const example = EXAMPLES.find((item) => item.id === id);
  if (!example) {
    throw new Error(`Unknown example: ${id}`);
  }
  return {
    nodes: example.document.nodes.map((item) => ({
      ...item,
      position: { ...item.position },
      data: structuredClone(item.data),
    })),
    edges: example.document.edges.map((item) => ({ ...item })),
  };
}

type V2ProjectExampleId = "hierarchical-adder" | "sequential-dff" | "register3";
type V3ProjectExampleId = "bus-tunnel-3" | "memory-lab" | "counter3";
type DocumentOnlyExampleId = Exclude<
  ExampleId,
  V2ProjectExampleId | V3ProjectExampleId
>;

export function cloneExampleProject(id: V3ProjectExampleId): ProjectDocumentV3;
export function cloneExampleProject(id: V2ProjectExampleId): ProjectDocumentV2;
export function cloneExampleProject(id: DocumentOnlyExampleId): null;
export function cloneExampleProject(
  id: ExampleId,
): ProjectDocumentV2 | ProjectDocumentV3 | null;
export function cloneExampleProject(
  id: ExampleId,
): ProjectDocumentV2 | ProjectDocumentV3 | null {
  if (id === "hierarchical-adder") return cloneHierarchicalAdderProject();
  if (id === "bus-tunnel-3") return cloneBusWiringProject();
  if (id === "sequential-dff") return cloneSequentialDffProject();
  if (id === "register3") return cloneRegister3Project();
  if (id === "memory-lab") return cloneMemoryLabProject();
  if (id === "counter3") return cloneCounter3Project();
  return null;
}
