# Logsim Ternary 项目总体设计与演进路线

## 1. 文档目的

本文定义 Logsim Ternary 的长期目标、技术边界、总体架构和阶段路线。

项目面向两类读者：

- 需要学习平衡三进制逻辑、寄存器、算术和处理器结构的学生与研究人员。
- 需要验证三值器件上层功能模型、数据通路和体系结构的硬件设计人员。

本文是解释型和路线型文档，不提供第一阶段的逐任务实施步骤。第一阶段的
精确数据结构、传播算法、元件语义和验收条件见
[第一阶段基础三进制组合逻辑编辑器设计](superpowers/specs/2026-07-29-logsim-ternary-phase1-design.md)。

## 2. 项目愿景

Logsim Ternary 是一个原生面向平衡三进制的数字逻辑设计与仿真工具。
用户应当能够像使用 Logisim 一样摆放元件、连接导线、改变输入并观察输出，
但导线承载的基本逻辑值不是二进制 `0/1`，而是：

```text
T = -1
0 =  0
1 = +1
```

项目最终希望支持从单 trit 基础门一直到小型三进制处理器的渐进设计：

```text
基础门
  ↓
单 trit 时序单元
  ↓
3-trit 寄存器和数据通路
  ↓
加减法器与 ALU
  ↓
存储器、控制器和子电路
  ↓
最小三进制 CPU
```

项目首先服务于教学、研究演示和功能验证，不声称替代 SPICE、电路级器件
仿真、时序签核或物理实现工具。

## 3. “原生三进制”的定义

### 3.1 真实逻辑值

仿真器中的逻辑代数、门真值表、寄存器状态和数据通路均以 `T/0/1` 为基本
数位，不使用两个二进制位冒充一个 trit。

Rust 内核必须直接定义三种已知逻辑值。三进制向量必须表示为 trit 序列，
不能把内部二进制编码暴露成用户可见语义。

### 3.2 仿真辅助状态

为了表达悬空、未知和冲突，每个单-trit 信号还支持三种辅助状态：

| 状态 | 含义 | 是否为三进制逻辑值 |
|---|---|---|
| `T` | `-1` | 是 |
| `0` | `0` | 是 |
| `1` | `+1` | 是 |
| `X` | 当前无法确定 | 否 |
| `Z` | 高阻或无驱动 | 否 |
| `E` | 驱动冲突或仿真错误 | 否 |

因此，本项目是“三值逻辑 + 三种仿真辅助状态”，不是六值逻辑代数。

### 3.3 与物理器件的边界

Logsim Ternary 负责功能级离散事件仿真。它不会在第一阶段模拟：

- 三个物理电压区间。
- 器件工艺偏差和噪声容限。
- 晶体管级延迟、功耗或模拟波形。
- 亚稳态的连续时间过程。

物理器件的数据可以在后续作为元件延迟、错误模型或外部协同仿真的输入，
但不改变内核的逻辑语义。

## 4. 对 Logisim-evolution 的参考原则

### 4.1 参考快照

本项目初始研究使用的 Logisim-evolution 快照为：

- 参考仓库：[logisim-evolution/logisim-evolution](https://github.com/logisim-evolution/logisim-evolution)
- 提交：`a73bf6523913e4405d91fcbf9c02cd0db93d70f7`
- 日期：2026-07-28
- 许可：GNU GPL v3

主要参考入口：

- [`Value.java`](https://github.com/logisim-evolution/logisim-evolution/blob/a73bf6523913e4405d91fcbf9c02cd0db93d70f7/src/main/java/com/cburch/logisim/data/Value.java)：
  二进制值、未知态、错误态和多驱动合并。
- [`InstanceFactory.java`](https://github.com/logisim-evolution/logisim-evolution/blob/a73bf6523913e4405d91fcbf9c02cd0db93d70f7/src/main/java/com/cburch/logisim/instance/InstanceFactory.java)：
  元件类型、端口和传播入口。
- [`InstanceState.java`](https://github.com/logisim-evolution/logisim-evolution/blob/a73bf6523913e4405d91fcbf9c02cd0db93d70f7/src/main/java/com/cburch/logisim/instance/InstanceState.java)：
  元件读取输入和设置输出的接口。
- [`CircuitWires.java`](https://github.com/logisim-evolution/logisim-evolution/blob/a73bf6523913e4405d91fcbf9c02cd0db93d70f7/src/main/java/com/cburch/logisim/circuit/CircuitWires.java)：
  导线连通性、总线连接和网络传播。
- [`Propagator.java`](https://github.com/logisim-evolution/logisim-evolution/blob/a73bf6523913e4405d91fcbf9c02cd0db93d70f7/src/main/java/com/cburch/logisim/circuit/Propagator.java)：
  事件队列、逻辑时间和振荡检测。
- [`Circuit.java`](https://github.com/logisim-evolution/logisim-evolution/blob/a73bf6523913e4405d91fcbf9c02cd0db93d70f7/src/main/java/com/cburch/logisim/circuit/Circuit.java)：
  元件集合、增删事件和连接关系。
- [`LogisimFile.java`](https://github.com/logisim-evolution/logisim-evolution/blob/a73bf6523913e4405d91fcbf9c02cd0db93d70f7/src/main/java/com/cburch/logisim/file/LogisimFile.java)：
  工程装载、保存和库引用。

### 4.2 借鉴的设计思想

| Logisim-evolution 思想 | Logsim Ternary 对应设计 |
|---|---|
| 值对象同时表达已知值和异常状态 | `Trit` 明确区分 `T/0/1/X/Z/E` |
| 元件通过端口读取输入、设置输出 | `ComponentEvaluator` 只通过端口快照求值 |
| 导线连接先形成网络，再解析驱动值 | `Net` 聚合驱动端并产生唯一解析值 |
| 值变化通过事件队列传播 | Rust 内核使用确定性的 delta-cycle 队列 |
| 传播次数受限并检测振荡 | 非收敛组合环路产生结构化诊断 |
| 元件工厂与元件实例分开 | `ComponentKind` 描述类型，`ComponentInstance` 保存实例 |
| 工程文件保存元件、属性和连接 | 版本化 JSON 保存电路图，不保存可重算状态 |

### 4.3 必须重新设计的部分

Logisim-evolution 的 `Value` 以 bit 为基本单位，并通过 `long` 位图保存
二进制值、未知位和错误位。这个结构不适合直接加入第三个已知逻辑值。

Logsim Ternary 不直接翻译 Java/Swing 代码，而是重新设计以下部分：

- 以 trit 为单位的值和向量。
- 显式区分 `X` 与 `Z`。
- 三值门真值表和多驱动网络解析。
- Rust 内核与 React 界面的稳定边界。
- 浏览器友好的 JSON 工程格式。
- 面向 WebAssembly 的批量命令和快照接口。

### 4.4 许可和归属

项目将采用 GNU GPL v3，并在仓库中保留对 Logisim-evolution 的明确归属。
如果后续直接改编上游代码，必须保留原始版权和许可声明。第一阶段以架构
研究和独立实现为主，不逐行翻译上游 Java 源码。

## 5. 总体架构

```text
┌──────────────────────────────────────────────────────────┐
│ React / TypeScript Web 应用                              │
│ 工具栏、元件库、画布、属性面板、工程管理、诊断展示       │
└───────────────────────┬──────────────────────────────────┘
                        │ 稳定、批量、版本化的 WASM API
┌───────────────────────▼──────────────────────────────────┐
│ Rust WebAssembly 适配层                                  │
│ 命令反序列化、ID 映射、快照序列化、错误边界              │
└───────────────────────┬──────────────────────────────────┘
                        │ 纯 Rust API
┌───────────────────────▼──────────────────────────────────┐
│ Rust 仿真内核                                            │
│ Trit、向量、元件、端口、网络、事件队列、诊断、工程校验   │
└───────────────────────┬──────────────────────────────────┘
                        │ 元件注册接口
┌───────────────────────▼──────────────────────────────────┐
│ 元件库                                                   │
│ 组合门、时序元件、算术、存储器、I/O、体系结构教学元件    │
└──────────────────────────────────────────────────────────┘
```

### 5.1 分层约束

- React 不实现门真值表或网络解析。
- WASM 适配层不持有第二份电路真相。
- Rust 内核不依赖浏览器、React Flow 或像素坐标。
- 画布位置和选中状态属于编辑器，不属于仿真语义。
- 可重算的端口值、网络值和事件队列不写入工程文件。
- 元件库通过稳定注册接口加入，不让核心传播器依赖具体门名称。

### 5.2 建议目录

```text
logsim-ternary/
├── apps/
│   └── web/                 # React、TypeScript、React Flow
├── crates/
│   ├── sim-core/            # 纯 Rust 仿真内核
│   └── sim-wasm/            # wasm-bindgen 适配层
├── docs/
│   ├── Logsim-Ternary项目总体设计与演进路线.md
│   └── superpowers/specs/
├── examples/                # 版本化示例电路
├── schemas/                 # JSON Schema
├── tests/                   # 跨层测试资源
├── LICENSE
└── README.md
```

## 6. 长期核心模型

### 6.1 Trit 与 TritVector

`Trit` 保存单个逻辑或辅助状态。`TritVector` 保存有确定方向和宽度的 trit
序列。向量转十进制仅用于显示和测试，不作为门求值的底层表示。

向量设计不继承 Logisim-evolution 的 64-bit 固定上限。第一阶段仅使用
宽度 1，后续按实际内存和性能限制设置可配置上限。

### 6.2 Component

元件分为类型定义和实例：

- 类型定义声明名称、类别、端口、属性模式和求值器。
- 实例保存稳定 ID、类型 ID 和用户设置。
- 编辑器位置、朝向和标签保存在实例的展示字段中。
- 时序元件状态由仿真会话保存，不写回类型定义。

### 6.3 Port

端口具有：

- 稳定的局部 ID。
- 输入、输出或后续支持的双向方向。
- trit 宽度。
- 可选名称和展示位置。
- 连接约束。

第一阶段仅支持宽度 1 的输入和输出端口。

### 6.4 Net

网络聚合一个或多个驱动端与一个或多个接收端。网络值不是某条导线单独
拥有的属性，而是所有有效驱动经过解析后的结果。

第一阶段编辑器以“输出端到输入端”的连接表示线路，Rust 内核会将同一输入
端收到的连接归并成一个输入网络。后续加入导线分叉和任意连接点时，工程
格式升级为显式网络，仿真器接口保持不变。

### 6.5 Event

事件表示某个驱动端在某个逻辑时刻产生新值。长期模型支持：

- delta cycle。
- 固定传播延迟。
- 时钟 tick。
- 元件内部状态更新。
- 传播次数限制和振荡诊断。

第一阶段所有组合门仅使用 delta cycle，不模拟物理时间。

## 7. 阶段路线

### 阶段 0：语义和工程基础

目标：

- 冻结 `T/0/1/X/Z/E`。
- 建立 Rust workspace、WASM 构建和 Web 测试链。
- 写出网络解析表和最小空电路格式。

退出标准：

- Rust、WASM 和 React 三层能够通过一个空电路往返。
- 六状态序列化和反序列化测试全部通过。

### 阶段 1：组合逻辑演示版

目标：

- 提供可拖拽、可连线、自动仿真的网页编辑器。
- 实现基础输入、输出和阶段 1 三值门。
- 支持 `Z/X/E` 展示、冲突诊断和组合环路检测。

退出标准见第一阶段详细设计。

### 阶段 2：工程编辑能力

目标：

- 显式导线分叉和网络节点。
- 框选、复制粘贴、对齐、旋转。
- 工程导入导出和版本迁移。
- 子电路及层次化元件。
- 自动生成和检查真值表。

### 阶段 3：时序逻辑

目标：

- [x] 单-trit DFF。
- [x] 写使能和同步复位。
- [x] 时钟源和完整周期单步 tick。
- [x] 3-trit 并行寄存器。
- 波形或时序记录面板。

仿真内核从纯组合稳定传播扩展为离散时间事件仿真。

截至 2026-08-10，Phase 3B 已完成 Rust/WASM 拥有的 Clock/DFF 状态、事务式
`0 → 1 → 0` tick、层级实例独立状态、API v2，以及由三个 DFF 组合出的可编辑
3-trit 并行寄存器。Register3 使用稳定的 `D2/D1/D0/CLK/EN/RST` 输入和
`Q2/Q1/Q0` 输出，支持并行捕获、保持、同步复位和层级下钻。当前快速验收范围
为桌面 Chromium；紧凑/移动视口和层级双实例的浏览器加固测试延期。

### 阶段 4：三进制算术

目标：

- 单-trit half adder 和 full adder。
- 3-trit ripple-carry adder。
- `NEG/ADD/SUB/INC/DEC`。
- `zero/negative/positive/carry_out` 状态。
- 第一版 3-trit ALU。

### 阶段 5：体系结构教学元件

目标：

- ROM、RAM 和有限深度栈。
- PC、IR、FSM 和寄存器组。
- 总线、分线器和多 trit 探针。
- 手动控制的最小数据通路。

### 阶段 6：最小三进制处理器

目标：

- 不超过 8 条指令的教学 ISA。
- 取指、译码、执行和停机。
- 运行加载常数、加减和条件跳转程序。
- 与 Setun、Setun-70 和 Trillium 的概念进行明确对照，但不冒充兼容实现。

## 8. 正确性策略

### 8.1 单一语义来源

所有逻辑语义必须在 Rust 内核中实现。TypeScript 只能显示结果，不能维护
一套独立的门计算逻辑。

### 8.2 穷举测试

基础门的已知值域很小，应优先穷举而不是只写少数示例：

- 一元门：3 种已知输入。
- 二元门：9 种已知输入。
- 单-trit full adder：27 种已知输入。
- 网络双驱动解析：6 × 6 种状态。
- 多驱动网络：验证驱动器排列不影响聚合结果。

### 8.3 性质测试

需要长期维护的代数性质包括：

```text
NEG(NEG(a)) = a
MIN(a, b) = NEG(MAX(NEG(a), NEG(b)))
MAX(a, b) = NEG(MIN(NEG(a), NEG(b)))
MIN(a, b) = MIN(b, a)
MAX(a, b) = MAX(b, a)
```

性质只对定义域中适用的状态断言，不能把 `X/Z/E` 当成普通数值。

### 8.4 跨层测试

- Rust 单元测试验证语义。
- `wasm-bindgen-test` 验证边界。
- Vitest 验证 Web 适配和状态管理。
- Playwright 验证摆放、连线、切换输入和输出更新。
- 示例电路同时作为文档和端到端回归。

## 9. 工程格式原则

长期工程格式使用版本化 JSON，并提供 JSON Schema。

工程文件保存：

- 格式版本。
- 元件实例和类型 ID。
- 元件属性与画布位置。
- 连接或显式网络。
- 工程级设置。

工程文件不保存：

- 当前事件队列。
- dirty 集合。
- 可重算的网络值。
- 浏览器临时选中状态。
- WASM 内部句柄。

任何不兼容修改都必须提升格式版本并提供迁移器，不能静默改变旧工程含义。

## 10. 性能与可移植性

第一阶段优先保证可解释和可测试，不做过早优化。

架构上保留以下能力：

- Rust 核心可以在浏览器外作为命令行库运行。
- 大型电路可把 WASM 仿真移入 Web Worker。
- 向量可从普通数组升级为紧凑编码而不改变公开语义。
- UI 通过批量快照更新，避免每条导线单独跨越 WASM 边界。
- React Flow 可以在后续替换为自研 SVG/Canvas 编辑器。

## 11. 明确不做的事情

以下内容不进入第一阶段主线：

- SPICE 或晶体管级模拟。
- 模拟电压与连续时间求解。
- HDL 综合和 FPGA 下载。
- 与 Logisim `.circ` 文件兼容。
- 完整 Setun 或 Setun-70 指令兼容。
- 流水线、cache、中断和复杂外设。
- 多用户实时协作。
- 插件市场。

## 12. 第一阶段之后如何决策

第一阶段完成后，根据真实演示反馈检查：

1. 用户是否能不看说明完成摆门、连线和切换输入。
2. `T/0/1/X/Z/E` 是否容易区分。
3. 网络冲突和组合环路是否能被理解。
4. React Flow 是否足以支持下一阶段的导线分叉和子电路。
5. Rust/WASM 边界是否产生明显性能或调试负担。

只有这些问题得到实测答案后，才决定第二阶段优先做工程编辑能力还是时序
元件。长期路线是方向，不是一次性全部实现的承诺。
