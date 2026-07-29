# 第一阶段基础三进制组合逻辑编辑器设计

## 1. 文档状态

本文定义 Logsim Ternary 第一阶段的可实现规格。第一阶段定位为偏演示的
最小真实电路编辑器：用户能够摆放基础三进制元件、连接端口、切换输入，
并立即看到 Rust/WASM 仿真内核返回的导线与输出状态。

总体方向见
[Logsim Ternary 项目总体设计与演进路线](../../Logsim-Ternary项目总体设计与演进路线.md)。

## 2. 目标读者和使用目标

目标读者具备基本数字电路概念，正在学习平衡三进制门、真值表和组合电路。

用户打开页面后，应能在一分钟内完成：

1. 从元件库拖入一个输入、一个 `NEG` 和一个 Probe。
2. 用导线连接三个元件。
3. 点击输入，在 `T/0/1` 之间切换。
4. 观察导线颜色和 Probe 输出同步变化。
5. 选中 `NEG` 查看精确真值表。

## 3. 第一阶段范围

### 3.1 必须交付

- Rust 原生六状态 trit 模型。
- Rust 组合逻辑仿真内核。
- WebAssembly 适配层。
- React/TypeScript 单页编辑器。
- React Flow 元件摆放、拖动和连线。
- 输入切换和自动稳定传播。
- 基础门、常量源和 Probe。
- 悬空、未知、冲突和不收敛诊断。
- 撤销、重做、删除、清空和恢复默认示例。
- 3 至 4 个内置演示电路。
- 桌面和移动端可用布局。
- Rust、WASM、Web 和浏览器端测试。

### 3.2 明确排除

- 时钟、DFF、寄存器和波形。
- 多-trit 总线、分线器和总线宽度转换。
- 任意导线分叉点。
- 子电路。
- 工程文件导入导出。
- HDL、FPGA、后端服务和用户系统。
- 物理延迟和模拟电压。

浏览器本地自动恢复当前演示电路可以使用 `localStorage`，但它不是正式工程
格式，也不作为第一阶段验收条件。

## 4. 技术栈

### 4.1 Rust

- 稳定版 Rust toolchain。
- Cargo workspace。
- `wasm-bindgen` 暴露 WebAssembly API。
- `serde` 和 `serde-wasm-bindgen` 处理批量命令与快照。
- `thiserror` 定义结构化错误。
- `proptest` 执行代数性质测试。

### 4.2 Web

- React。
- TypeScript strict mode。
- Vite。
- `@xyflow/react` 负责节点、端口、连接、平移和缩放。
- 轻量状态容器仅保存编辑器状态，不复制仿真语义。
- Vitest。
- Playwright。

### 4.3 分层目录

```text
logsim-ternary/
├── crates/
│   ├── sim-core/
│   │   ├── src/
│   │   │   ├── trit.rs
│   │   │   ├── component.rs
│   │   │   ├── circuit.rs
│   │   │   ├── net.rs
│   │   │   ├── simulator.rs
│   │   │   ├── diagnostic.rs
│   │   │   └── gates/
│   │   └── tests/
│   └── sim-wasm/
│       └── src/lib.rs
├── apps/
│   └── web/
│       ├── src/
│       │   ├── app/
│       │   ├── editor/
│       │   ├── components/
│       │   ├── simulation/
│       │   └── examples/
│       └── tests/
├── docs/
└── schemas/
```

## 5. 与 Logisim-evolution 的架构映射

| Logisim-evolution | 第一阶段对应物 | 处理方式 |
|---|---|---|
| `Value` | `Trit` | 重新设计为三种已知值和三种辅助状态 |
| `InstanceFactory` | `ComponentKind`/注册表 | 类型元数据与实例状态分离 |
| `InstanceState` | `EvalContext` | 求值器通过端口快照读写 |
| `CircuitWires` | `ConnectionGraph`/`Net` | 聚合驱动并解析网络值 |
| `Propagator` | `Simulator`/delta queue | 确定性事件序列和收敛限制 |
| `Circuit` | `CircuitDefinition` | 保存元件和连接，不保存 UI 选中状态 |
| `LogisimFile` | `CircuitDocument` | 第一阶段只定义内存结构，正式持久化后置 |

Logisim-evolution 的主要价值是成熟的职责划分。第一阶段不会复用它的 Java
对象、Swing 绘制或二进制 `Value` 位图。

## 6. Trit 状态模型

### 6.1 Rust 表示

概念接口：

```rust
#[repr(i8)]
pub enum Trit {
    Neg = -1,
    Zero = 0,
    Pos = 1,
    Unknown = 2,
    HighZ = 3,
    Error = 4,
}
```

公开 API 使用稳定字符串编码：

```text
"T"  "0"  "1"  "X"  "Z"  "E"
```

不能把 Rust 枚举的判别值直接写入长期工程文件。判别值是内部优化细节，
字符串才是跨版本合同。

### 6.2 基本分类

```rust
is_known(Trit) -> bool
is_meta(Trit) -> bool
as_balanced_value(Trit) -> Option<i8>
```

- `T/0/1` 是 known。
- `X/Z/E` 是 meta。
- 只有 known 值可以参与数值比较。

### 6.3 元件输入归一化

普通逻辑门接收输入时：

| 端口值 | 求值器看到的语义 |
|---|---|
| `T/0/1` | 按门真值表计算 |
| `X` | 输出 `X` |
| `Z` | 先归一化为 `X` |
| `E` | 输出 `E` |

第一阶段采用保守传播。即使部分输入足以决定 `MIN/MAX`，只要存在 `X/Z`，
输出仍为 `X`。这样规则容易解释，后续可以在不改变已知值真值表的前提下
加入精细的部分求值。

## 7. 网络解析

### 7.1 驱动规则

网络解析只处理驱动器输出，不执行门逻辑。

```text
没有驱动器            -> Z
所有驱动器均为 Z      -> Z
一个或多个相同已知值  -> 该已知值
不同已知值同时驱动    -> E
任意驱动器为 E        -> E
存在 X 且没有 E       -> X
Z 与其他值并存        -> 忽略 Z，解析其他驱动
```

### 7.2 双驱动解析矩阵

矩阵满足交换律。行列顺序均为 `T/0/1/X/Z/E`：

| ⊕ | `T` | `0` | `1` | `X` | `Z` | `E` |
|---|---|---|---|---|---|---|
| `T` | `T` | `E` | `E` | `X` | `T` | `E` |
| `0` | `E` | `0` | `E` | `X` | `0` | `E` |
| `1` | `E` | `E` | `1` | `X` | `1` | `E` |
| `X` | `X` | `X` | `X` | `X` | `X` | `E` |
| `Z` | `T` | `0` | `1` | `X` | `Z` | `E` |
| `E` | `E` | `E` | `E` | `E` | `E` | `E` |

双驱动矩阵用于解释两个驱动器的结果。三个及以上驱动器不能把该矩阵直接
按遍历顺序两两折叠，因为 `E` 同时表达上游错误和当前网络冲突，简单折叠
可能丢失“不同已知值已经冲突”的信息。

多驱动网络必须一次聚合全部驱动：

1. 任意驱动为 `E`，结果为 `E`。
2. 忽略全部 `Z`。
3. 若出现两个或更多不同的已知值，结果为 `E`。
4. 否则若存在 `X`，结果为 `X`。
5. 否则若存在一个已知值，结果为该值。
6. 没有剩余驱动时，结果为 `Z`。

测试必须验证任意驱动器排列得到相同结果。

## 8. 元件模型

### 8.1 类型定义

```rust
pub struct ComponentDescriptor {
    pub type_id: &'static str,
    pub display_name: &'static str,
    pub category: ComponentCategory,
    pub ports: &'static [PortDescriptor],
}
```

`type_id` 是工程和 WASM API 使用的稳定标识，例如：

```text
source.trit_input
source.constant
sink.probe
gate.buf
gate.neg
gate.min
gate.max
gate.is_neg
gate.is_zero
gate.is_pos
gate.mux2
gate.mux3
```

显示名称可以本地化，`type_id` 不能随界面文案改变。

### 8.2 实例

```rust
pub struct ComponentInstance {
    pub id: ComponentId,
    pub type_id: ComponentTypeId,
    pub properties: ComponentProperties,
}
```

Rust 内核不保存像素坐标。React 文档模型使用相同 `ComponentId` 保存位置、
朝向和标签。

### 8.3 端口

第一阶段端口只有：

```rust
pub enum PortDirection {
    Input,
    Output,
}
```

每个端口宽度固定为一个 trit。输入端允许多个输出连接，以便演示驱动冲突；
输出端允许扇出到多个输入端。

## 9. 第一批元件语义

### 9.1 输入和输出

#### Trit Input

- 无输入端口。
- 一个输出端口。
- 用户值仅允许 `T/0/1`。
- 点击顺序固定为 `T -> 0 -> 1 -> T`。
- 复位默认值为 `0`。

#### Constant

- 无输入端口。
- 一个输出端口。
- 属性值为 `T/0/1`。
- 通过属性面板修改，不响应画布点击。

#### Probe

- 一个输入端口。
- 无输出端口。
- 显示输入网络解析后的完整六状态。

### 9.2 一元门

#### BUF

| A | Y |
|---|---|
| `T` | `T` |
| `0` | `0` |
| `1` | `1` |

#### NEG

| A | Y |
|---|---|
| `T` | `1` |
| `0` | `0` |
| `1` | `T` |

#### Decoder

decoder 输出采用 `1=true`、`T=false`：

| A | IS_NEG | IS_ZERO | IS_POS |
|---|---|---|---|
| `T` | `1` | `T` | `T` |
| `0` | `T` | `1` | `T` |
| `1` | `T` | `T` | `1` |

### 9.3 二元门

#### MIN

`MIN(A,B)` 取 `-1 < 0 < +1` 中较小的值。

| A \ B | `T` | `0` | `1` |
|---|---|---|---|
| `T` | `T` | `T` | `T` |
| `0` | `T` | `0` | `0` |
| `1` | `T` | `0` | `1` |

#### MAX

`MAX(A,B)` 取 `-1 < 0 < +1` 中较大的值。

| A \ B | `T` | `0` | `1` |
|---|---|---|---|
| `T` | `T` | `0` | `1` |
| `0` | `0` | `0` | `1` |
| `1` | `1` | `1` | `1` |

### 9.4 选择器

#### MUX2

端口为 `A/B/S -> Y`：

- `S=T`：选择 A。
- `S=1`：选择 B。
- `S=0`：输出 `X`，表示二选一控制未作出决定。

选择器为 `E` 时输出 `E`，为 `X/Z` 时输出 `X`。

#### MUX3

端口为 `A/B/C/S -> Y`：

- `S=T`：选择 A。
- `S=0`：选择 B。
- `S=1`：选择 C。

选择器为 `E` 时输出 `E`，为 `X/Z` 时输出 `X`。

只有被选择的数据输入参与结果。未选择输入上的 `X/Z/E` 不污染输出。

## 10. 电路图模型

### 10.1 编辑器文档

```typescript
interface CircuitDocument {
  format: "logsim-ternary";
  version: 1;
  components: EditorComponent[];
  connections: EditorConnection[];
  viewport?: ViewportState;
}
```

```typescript
interface EditorComponent {
  id: string;
  typeId: string;
  position: { x: number; y: number };
  properties: Record<string, unknown>;
}

interface EditorConnection {
  id: string;
  sourceComponentId: string;
  sourcePortId: string;
  targetComponentId: string;
  targetPortId: string;
}
```

第一阶段连接是有方向的输出到输入边，不支持在线中间创建分叉点。一个输出
通过多条连接实现扇出。

### 10.2 内核定义

React 把编辑器文档转换为批量 `CircuitDefinition`：

```rust
pub struct CircuitDefinition {
    pub components: Vec<ComponentInstance>,
    pub connections: Vec<Connection>,
}
```

Rust 校验成功后构建端口索引、输入网络和下游依赖表。UI 不能假设只要画出
一条线，内核就一定接受。

## 11. 传播算法

### 11.1 构建阶段

1. 校验元件 ID 和类型 ID。
2. 校验端口存在且方向正确。
3. 忽略完全重复的连接并返回 warning。
4. 按目标输入端聚合所有驱动输出。
5. 建立“输出变化 -> 受影响输入网络 -> 下游元件”的索引。
6. 所有输出初始化为 `Z`。
7. 将输入源和常量源加入队列。

### 11.2 稳态传播

每次用户改变输入：

1. 更新输入源属性。
2. 将该源加入求值队列。
3. 求值元件输出。
4. 如果输出未变化，不继续传播。
5. 如果输出变化，重新解析受影响的输入网络。
6. 如果网络值变化，将所有下游元件加入下一 delta cycle。
7. 队列为空时返回稳定快照。

队列顺序由 `delta_cycle` 和单调递增 `sequence` 决定，保证同一电路、同一
输入得到完全相同的传播过程。

### 11.3 不收敛处理

一次 `settle` 的事件上限为：

```text
max_events = max(1024, 64 * (component_count + connection_count))
```

超过上限时：

- 停止本次传播。
- 将仍在 dirty 集合中的输出和输入网络标记为 `E`。
- 返回 `NON_CONVERGENT_COMBINATIONAL_LOOP` 诊断。
- 保留其他已经稳定且不依赖该环路的网络值。

这个限制用于发现组合反馈，不表示物理传播时间。

## 12. WASM API

### 12.1 设计原则

- 使用批量命令，避免每根导线跨一次 WASM 边界。
- 所有公开调用返回结构化成功或错误。
- JavaScript 不持有 Rust 内部指针。
- 每个响应包含 API 版本。
- Rust panic 不得成为普通用户错误路径。

### 12.2 第一阶段接口

概念接口：

```text
createSimulator(apiVersion) -> SimulatorHandle
loadCircuit(handle, CircuitDefinition) -> LoadResult
setInput(handle, componentId, value) -> SimulationResult
reset(handle) -> SimulationResult
snapshot(handle) -> SimulationSnapshot
dispose(handle) -> void
componentCatalog() -> ComponentDescriptor[]
```

`SimulationSnapshot` 至少包含：

```typescript
interface SimulationSnapshot {
  apiVersion: 1;
  stable: boolean;
  componentOutputs: Record<string, Record<string, TritSymbol>>;
  inputNets: Record<string, Record<string, TritSymbol>>;
  diagnostics: SimulationDiagnostic[];
  processedEvents: number;
}
```

组件目录也由 Rust 导出，防止 UI 与内核各自维护一份端口定义。

## 13. 错误和诊断

### 13.1 结构错误

以下错误拒绝加载电路：

- 重复元件 ID。
- 未知 `type_id`。
- 连接引用不存在的元件或端口。
- 输入连接到输入。
- 输出连接到输出。
- 属性类型不正确。

### 13.2 可仿真警告

以下情况允许仿真但返回诊断：

- 重复连接被忽略。
- 输入端无驱动，值为 `Z`。
- 多驱动冲突，网络值为 `E`。
- 组合环路不收敛。

### 13.3 诊断结构

```typescript
interface SimulationDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  componentIds: string[];
  connectionIds: string[];
  portIds: string[];
}
```

UI 根据 ID 高亮相关元件和导线，不解析错误文案来推断位置。

## 14. Web 编辑器

### 14.1 页面结构

```text
┌──────────────────────────────────────────────────────────────┐
│ 顶部工具栏：撤销、重做、删除、清空、示例、缩放适配          │
├──────────────┬────────────────────────────┬──────────────────┤
│ 元件库       │ 电路画布                   │ 属性/真值表      │
│ 输入与输出   │ 网格、元件、端口、导线     │ 当前值与诊断     │
│ 一元门       │                            │                  │
│ 二元门       │                            │                  │
│ 选择器       │                            │                  │
├──────────────┴────────────────────────────┴──────────────────┤
│ 状态栏：WASM 状态、元件数、连接数、stable/error              │
└──────────────────────────────────────────────────────────────┘
```

打开页面后直接进入编辑器，不增加营销首页。默认载入：

```text
Trit Input -> NEG -> Probe
```

### 14.2 元件交互

- 从元件库拖入画布。
- 元件吸附到稳定网格。
- 输入端口位于左侧，输出端口位于右侧。
- 从输出端口拖到输入端口创建连接。
- 单击 Trit Input 循环 `T/0/1`。
- 单击元件选中，右侧显示属性、端口值和真值表。
- `Delete/Backspace` 删除选中元件或连接。
- 工具栏使用图标并提供 tooltip。
- `Ctrl/Cmd+Z` 和 `Ctrl/Cmd+Shift+Z` 撤销、重做。

### 14.3 状态颜色

| 状态 | 颜色或线型 |
|---|---|
| `T` | 红色实线 |
| `0` | 中性灰实线 |
| `1` | 绿色实线 |
| `X` | 黄色实线 |
| `Z` | 蓝色虚线 |
| `E` | 洋红色实线并带警告标记 |

颜色不是唯一信息。导线或 Probe 还要显示字符，保证色觉差异用户可辨认。

### 14.4 响应式布局

- 桌面：左侧元件库、中央画布、右侧检查器同时显示。
- 窄屏：画布占满主体，元件库和检查器变为可关闭抽屉。
- 顶部工具栏保留图标按钮，低优先级操作进入菜单。
- 画布和工具栏不能产生页面横向溢出。

## 15. 内置演示电路

第一阶段包含：

1. **NEG 基础**：展示 `T/0/1` 取反。
2. **MIN/MAX 比较**：同一对输入同时进入 `MIN` 和 `MAX`。
3. **三路 decoder**：一个输入驱动 `IS_NEG/IS_ZERO/IS_POS`。
4. **MUX3**：三个常量与一个 Trit Input 选择器。

示例是只读模板。用户载入后得到可编辑副本。

## 16. 测试设计

### 16.1 Rust 单元测试

- `Trit` 字符串往返。
- 已知值分类和数值转换。
- 双驱动 36 项解析矩阵。
- 多驱动聚合的排列不变性。
- 所有门的已知值真值表。
- `X/Z/E` 传播。
- MUX 只计算被选择输入。
- 无驱动输入得到 `Z`。
- 扇出传播。
- 多驱动冲突。
- 重复连接警告。
- 非收敛环路终止。

### 16.2 性质测试

在 `T/0/1` 域上验证：

```text
NEG(NEG(a)) = a
MIN(a,b) = MIN(b,a)
MAX(a,b) = MAX(b,a)
MIN(a,b) = NEG(MAX(NEG(a),NEG(b)))
MAX(a,b) = NEG(MIN(NEG(a),NEG(b)))
```

### 16.3 WASM 测试

- 创建和释放 simulator。
- 加载最小电路。
- 设置输入后返回稳定快照。
- 非法 ID 和非法 trit 返回结构化错误。
- Rust 元件目录与 Web 渲染适配器兼容。

### 16.4 Web 单元测试

- 元件目录分组。
- Rust 快照映射到导线和 Probe。
- 六状态颜色和字符同时存在。
- 撤销、重做和删除命令。
- 示例加载后不会修改模板。

### 16.5 Playwright 验收

自动执行：

1. 页面启动且 WASM ready。
2. 默认 NEG 示例在输入为 `0` 时输出 `0`。
3. 连续点击输入后依次得到 `1/T/0` 的 NEG 输出循环。
4. 拖入 `MIN`、两个输入和 Probe，并完成连线。
5. 验证 `MIN(0,1)=0`。
6. 制造多驱动冲突，验证导线和 Probe 显示 `E`。
7. 删除冲突连接后恢复稳定值。
8. 桌面与窄屏均无横向溢出或控件重叠。
9. 浏览器控制台无未处理异常。

### 16.6 性能基线

在开发机的 Chromium 中，200 个组合元件和 400 条连接的稳定传播目标为
50 ms 内完成。性能测量不包含首次 WASM 下载和 React 初次渲染。

该指标是防回退基线，不是硬实时承诺。

## 17. 第一阶段验收标准

只有以下条件全部满足，第一阶段才算完成：

- 页面打开后直接显示可编辑默认电路。
- 12 类元件均可摆放。
- 输出到输入可以连线，输出可以扇出。
- 输入点击严格循环 `T/0/1`。
- 所有已知值真值表通过穷举测试。
- 六状态网络解析通过完整矩阵测试。
- 导线和 Probe 同时用颜色与字符显示状态。
- `Z/X/E` 行为符合本文规则。
- 多驱动冲突可演示且能通过删除连接恢复。
- 组合环路不会卡死浏览器。
- React 中不存在第二套门求值实现。
- Rust、WASM、Vitest 和 Playwright 测试全部通过。
- 桌面和窄屏截图经过人工视觉检查。
- 默认示例和另外三个演示电路均能完成预期输出。

## 18. 实施顺序

实施计划必须遵循以下依赖顺序：

1. Rust `Trit` 和网络解析。
2. Rust 元件目录和基础门求值器。
3. Rust 电路定义和传播器。
4. WASM 批量 API。
5. Web 空编辑器和元件目录。
6. 节点、端口和连接。
7. 输入交互和仿真快照渲染。
8. 属性、真值表和诊断面板。
9. 撤销、重做、清空和示例。
10. 浏览器视觉验收和性能基线。

每一步先写失败测试，再实现最小行为。不能先在 TypeScript 中临时实现门逻辑
再迁移 Rust，因为这会形成两套语义并污染验收结果。
