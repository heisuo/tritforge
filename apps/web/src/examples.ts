import type {
  EditorDocument,
  EditorEdge,
  EditorNode,
  KnownTrit,
} from "./editor-model";

export type ExampleId =
  | "neg"
  | "min-max"
  | "decoder"
  | "mux3"
  | "full-adder"
  | "ripple-adder-3"
  | "driver-conflict";

export interface TernaryExample {
  id: ExampleId;
  name: string;
  category: string;
  description: string;
  composition: string;
  expected: string;
  document: EditorDocument;
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
    id: "full-adder",
    name: "单 trit 全加器",
    category: "算术模块",
    description: "把 a、b 和低位进位 cin 相加，同时观察本位和 sum 与高位进位 carry。",
    composition: "Input a + Input b + cin → Full Adder → sum / carry",
    expected: "默认 1 + 1 + 0：sum=T，carry=1，合起来是 1T₃（十进制 2）",
    document: {
      nodes: [
        node("fa-a", "source.trit_input", "输入 a", 50, 80, "1"),
        node("fa-b", "source.trit_input", "输入 b", 50, 260, "1"),
        node("fa-cin", "source.trit_input", "低位进位 cin", 50, 440, "0"),
        node("full-adder-1", "module.full_adder", "Full Adder", 380, 250),
        node("fa-sum", "sink.probe", "本位和 sum", 730, 150),
        node("fa-carry", "sink.probe", "高位进位 carry", 730, 370),
      ],
      edges: [
        edge("fa-a-wire", "fa-a", "out", "full-adder-1", "a"),
        edge("fa-b-wire", "fa-b", "out", "full-adder-1", "b"),
        edge("fa-cin-wire", "fa-cin", "out", "full-adder-1", "cin"),
        edge("fa-sum-wire", "full-adder-1", "sum", "fa-sum", "in"),
        edge("fa-carry-wire", "full-adder-1", "carry", "fa-carry", "in"),
      ],
    },
  },
  {
    id: "ripple-adder-3",
    name: "3-trit 行波进位加法器",
    category: "多 trit 算术",
    description: "三个全加器从最低位到最高位串联，前一级 carry 接到后一级 cin。",
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
      data: { ...item.data },
    })),
    edges: example.document.edges.map((item) => ({ ...item })),
  };
}
