export interface ComponentHelp {
  summary: string;
  details: string;
}

export const COMPONENT_HELP: Record<string, ComponentHelp> = {
  "source.trit_input": {
    summary: "可交互的单 trit 输入源，点击节点即可切换输入值。",
    details: "输入严格按照 T → 0 → 1 → T 循环，其中 T 表示平衡三进制的 −1。",
  },
  "source.constant": {
    summary: "输出固定三进制值的常量源，用于提供稳定的数据输入。",
    details: "常量不会随仿真变化，适合搭建选择器数据端和可重复的测试条件。",
  },
  "sink.probe": {
    summary: "观察输入网络当前状态的探针，不会驱动或改变电路。",
    details: "Probe 可以显示 T、0、1，也会直接显示未知 X、高阻 Z 和冲突 E。",
  },
  "gate.buf": {
    summary: "三进制缓冲门，已知输入值原样传递到输出。",
    details: "BUF 常用于整理连线或增加观察点；高阻 Z 进入逻辑门后按未知 X 处理。",
  },
  "gate.neg": {
    summary: "平衡三进制取反门，把正负方向互换并保持零不变。",
    details: "真值关系为 T→1、0→0、1→T，相当于对平衡三进制数值取相反数。",
  },
  "gate.min": {
    summary: "三进制最小值门，输出两个输入中数值较小的一项。",
    details: "按 T < 0 < 1 比较。例如 MIN(T,1)=T，MIN(0,1)=0。",
  },
  "gate.max": {
    summary: "三进制最大值门，输出两个输入中数值较大的一项。",
    details: "按 T < 0 < 1 比较。例如 MAX(T,1)=1，MAX(T,0)=0。",
  },
  "gate.is_neg": {
    summary: "负值译码门，用于判断输入是否恰好为 T。",
    details: "输入为 T 时输出 1，否则对已知输入输出 T，可作为三路译码器的一路。",
  },
  "gate.is_zero": {
    summary: "零值译码门，用于判断输入是否恰好为 0。",
    details: "输入为 0 时输出 1，其余已知输入输出 T，适合零检测和三向条件控制。",
  },
  "gate.is_pos": {
    summary: "正值译码门，用于判断输入是否恰好为 1。",
    details: "输入为 1 时输出 1，其余已知输入输出 T，可用于正值条件分支。",
  },
  "gate.mux2": {
    summary: "二选一三进制选择器，用 T 和 1 选择两路数据。",
    details: "选择端 s=T 时输出 a，s=1 时输出 b；s=0 没有对应数据路，因此输出 X。",
  },
  "gate.mux3": {
    summary: "完整三选一选择器，用一个 trit 选择三路数据。",
    details: "选择端 s=T/0/1 时分别输出 a/b/c，是三进制数据通路中的基础路由模块。",
  },
  "module.half_adder": {
    summary: "单 trit 半加器，把两个平衡三进制输入相加并输出和与进位。",
    details: "满足 a+b=sum+3×carry。例如 1+1=2，模块输出 sum=T、carry=1，即平衡三进制 1T。",
  },
  "module.full_adder": {
    summary: "单 trit 全加器，在半加器基础上额外接收低位传来的 cin。",
    details: "满足 a+b+cin=sum+3×carry。多个全加器首尾连接，就能构成多 trit 行波进位加法器。",
  },
};
