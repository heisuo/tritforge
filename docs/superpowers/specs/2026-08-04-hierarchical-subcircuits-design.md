# Logsim Ternary 阶段 2A：子电路与层次化模块设计

## 1. 状态与目标

本文定义阶段 2A 的冻结设计。用户已经确认以下决策：

- 使用专用模块编辑器，不做框选后一键封装。
- 自定义模块允许多层嵌套，但禁止直接或间接递归。
- 模块接口采用保护策略；已连接端口不能被破坏性删除。
- 仿真采用 Rust 层次编译后扁平执行，不在 TypeScript 中实现展开语义。
- 验收链为“基础门半加器 -> 两个半加器组成全加器 -> 顶层测试电路”。

阶段目标是让用户能够创建一个有稳定输入输出接口的组合子电路，把它作为
普通元件重复摆放，双击进入定义继续编辑，并通过真实 Rust/WASM 仿真观察
当前层级的信号。

## 2. 范围

### 2.1 本阶段包含

- `Project v2`：一个工程包含主电路和零个或多个模块定义。
- 新建、重命名和删除未被使用的模块。
- `Module Input` 与 `Module Output` 边界元件。
- 自定义模块动态加入元件库并可重复实例化。
- 多层无环嵌套、双击进入模块、面包屑返回上级。
- 模块独立预览；模块输入在预览时可循环 `T/0/1`。
- Rust 层次校验、确定性展开、端口映射和快照投影。
- v1 单电路文件自动迁移到 v2。
- 半加器、全加器和顶层测试工程示例。
- 层次展开与输入传播分离的性能基线。

### 2.2 本阶段不包含

- 框选元件后一键封装。
- 递归模块、参数化模块和模块接口版本管理。
- 显式网络分叉点、总线、多-trit 端口和分线器。
- DFF、时钟、寄存器、波形和物理传播延迟。
- 同时打开多个画布、跨层拖线和跨模块全局布线。
- 从 Logisim `.circ` 或其他 HDL 导入子电路。

## 3. 用户体验

### 3.1 工程与模块入口

左侧元件库新增“工程模块”分组和“新建模块”命令。每个模块条目显示名称、
输入数、输出数，并提供进入定义和放置实例两个动作。主电路始终存在，不能
删除或改成普通模块。

新建模块只要求名称。系统生成不可见的稳定模块 ID，并打开空模块画布。用户
随后从模块编辑器的接口工具中添加 `Module Input` 和 `Module Output`。

### 3.2 模块接口

每个边界元件包含：

- 隐藏且不可修改的稳定 `portId`；
- 可修改的中文或英文显示名称；
- 方向；
- 画布位置；
- `Module Input` 独立预览时使用的 `previewValue`。

模块实例端口按边界元件在画布中的纵向位置排序，位置相同时按稳定 ID 排序。
移动边界元件只影响端口显示顺序，不改变已有连接引用。

重命名只修改显示名称，因此不会断线。删除端口前扫描整个工程：只要任一模块
实例的该端口存在外部连接，就拒绝删除并列出使用位置；没有连接时允许删除，
所有实例视图同步更新。

### 3.3 层次导航

双击模块实例进入其共享定义。顶部显示面包屑，例如：

```text
主电路 / Full Adder / Half Adder
```

面包屑保存的是当前访问路径，不复制模块定义。多个实例进入的仍是同一份定义；
任何内部修改都会影响全部实例。返回上级时恢复上级画布的 viewport 和选择状态。

模块编辑器中的 `Module Input` 可点击循环 `T/0/1`，用于独立测试当前模块。
当同一模块作为其他电路的实例时，实际输入完全来自外部连线，`previewValue`
不参与嵌套实例求值。

`value` 和 `previewValue` 是可持久化、可撤销的非结构属性。点击输入会同时更新
ProjectDocument 和已加载 Simulator，但不增加结构 revision，也不触发层次
编译。导出保存当前值；重新进入模块和重新导入时从保存值初始化。

为支持共享模块定义中的 source，`sim-core` 新增原子批量 `set_sources`，允许更新
`Trit Input` 和 `Constant`，先验证全部 ID 与已知值，再一次 settle；任一更新
非法时整个批次不生效。项目级 `setSource(circuitId, componentId, value)` 使用
反向 provenance 找出当前展开图中该定义元件的全部实例副本，并在一个批次中
更新。例如 Half Adder 被实例化两次时，修改其内部 Constant 会同时更新两个
扁平副本。根预览 `Module Input` 映射到其唯一 Trit Input 副本。

值属性的撤销重做也走 project `setSource`；只有同时跨越结构历史节点时才重新
编译。本阶段不新增独立的临时 preview reset；“默认示例”仍按现有语义重新
载入完整示例工程。

### 3.4 删除与保护

- 被任何电路实例化的模块不能删除，界面列出引用电路和实例名称。
- 当前模块，以及传递依赖中已经包含当前模块的任何候选模块，都不出现在可放置
  列表中；该规则与用户从哪条面包屑路径进入定义无关。
- 导入文件仍必须由 Rust 检测完整依赖环，不能依赖 UI 过滤保证正确性。
- 修改失败不回滚整个工程；编辑内容保留，信号清为 `Z`，诊断面板显示错误。

## 4. Project v2 工程格式

### 4.1 顶层结构

```typescript
interface ProjectDocumentV2 {
  format: "logsim-ternary";
  version: 2;
  rootCircuitId: string;
  circuits: ProjectCircuit[];
}

interface ProjectCircuit {
  id: string;
  name: string;
  kind: "main" | "module";
  components: EditorComponent[];
  connections: EditorConnection[];
  viewport?: { x: number; y: number; zoom: number };
}
```

工程必须恰好有一个 `kind: "main"` 的电路，且其 ID 等于 `rootCircuitId`。
电路 ID、模块 ID、元件 ID 和连接 ID 在各自作用域内稳定。

### 4.2 特殊元件

v2 保留三个工程级类型 ID：

```text
project.module_input
project.module_output
project.module_instance
```

- `project.module_input`：属性包含 `portId`、`label`、`previewValue`，自身只有
  固定输出 handle `out`。
- `project.module_output`：属性包含 `portId`、`label`，自身只有固定输入
  handle `in`。
- `project.module_instance`：属性包含 `moduleId` 和实例显示 `label`；实例输入
  与输出 handle 直接使用被引用模块的稳定 `portId`。

边界元件只允许出现在 `kind: "module"` 的电路中。模块实例可出现在主电路或
其他模块中。一个模块内所有输入和输出的 `portId` 必须整体唯一。连接边界或
动态端口时方向错误统一返回 `INVALID_MODULE_PORT_DIRECTION`。

`moduleId` 没有第二套身份空间：它必须严格等于某个 `kind: "module"` 的
ProjectCircuit.id。指向不存在 ID 返回 `UNKNOWN_MODULE`；指向存在的 main
电路返回 `MODULE_REFERENCE_NOT_MODULE`。

### 4.3 v1 迁移

导入 v1 时执行纯迁移：

1. 生成稳定主电路 ID `main`。
2. 主电路名称固定为语言无关的 `Main`，kind 固定为 `main`。
3. 把原 `components/connections/viewport` 原样放入主电路。
4. 生成 `version: 2`、`rootCircuitId: "main"`、单元素 `circuits`。
5. 不改写元件 ID、连接 ID、属性和位置。

导出统一写 v2。解析器保留 v1 读取能力，并为每个未来不兼容版本提供独立、
可测试的迁移函数，禁止在普通解析代码中静默猜测版本。

新增 `schemas/project-v2.schema.json`。顶层、电路、连接和三类特殊元件使用
`additionalProperties: false` 锁定结构。属性约束按 `typeId` 使用条件分支：

- 只有三类 `project.*` 特殊元件才把 `moduleId/portId/previewValue` 视为保留键
  并检查其类型。
- 普通内置元件继续沿用 v1 规则，只约束 `value/label`，其他扩展键透明保留；
  即使扩展键恰好名为 `moduleId`，也不能按特殊元件规则解释或改写。

因此任何合法 v1 properties 都能原样进入 v2 主电路。迁移测试包含与 v2 特殊
键同名但类型不同的普通扩展属性，防止 Schema 条件分支误伤旧文件。

## 5. Rust 层次编译器

### 5.1 位置与边界

`sim-core` 新增纯 Rust `project` 和 `hierarchy` 模块。TypeScript 只发送完整
项目和当前预览电路 ID，不展开模块、不判断递归，也不实现任何门逻辑。

公开概念接口为：

```text
compile_project(project, active_circuit_id)
  -> CompiledProject { circuit, projection }
```

`circuit` 是现有 `CircuitDefinition`，继续交给现有 `Simulator`。`projection`
保存当前层级逻辑端口到展开后端口的映射，用于恢复模块实例和边界节点信号。

### 5.2 校验顺序

编译器按确定顺序执行：

1. 校验主电路、所有电路 ID 和名称。
2. 对每个电路执行完整局部校验：重复元件/连接 ID、普通内置类型和属性、特殊
   元件属性、边界元件所在电路类型及所有本地连接端点。
3. 从边界元件导出每个模块的动态端口目录。
4. 校验模块实例引用存在且指向 module、动态连接端口存在且方向正确。
5. 构建整个工程的模块依赖有向图并检测循环，包括当前活动电路不可达的模块。
6. 以 checked arithmetic 预计算活动电路可达展开规模并应用资源预算。
7. 从 `active_circuit_id` 深度优先展开可达模块。
8. 生成扁平电路、投影表和 provenance，再调用现有电路校验器。

诊断按电路路径、元件 ID、端口 ID 和错误代码稳定排序，使相同工程每次得到
相同结果。

### 5.3 展开资源预算

阶段 2A 固定以下浏览器安全上限：

```text
最大层次深度              32
最大展开基础元件数        10,000
最大展开连接数            50,000
最大 projection 端点数   100,000
```

为保证“空模块实例”不会绕过基础元件预算，分析器另设内部工作量护栏：最多展开
10,000 个模块实例、50,000 个符号节点、100,000 条符号边和 2,000,000 个最终
provenance 引用。这些项目只约束编译分析与诊断回投所需资源，不改变上述扁平
电路与 projection 的公开容量；超限同样返回 `HIERARCHY_EXPANSION_LIMIT`。

编译器先用记忆化计数和 checked addition/multiplication 分析模块实例倍增、边界
驱动数与消费者数的笛卡尔积；溢出或任一预算超限时，在分配完整展开图之前返回
`HIERARCHY_EXPANSION_LIMIT`。实际展开阶段继续维护同一组计数作为第二道保护。
诊断包含命中的预算、估算值和导致增长的实例路径。后续可以通过 Rust 配置调整
限制，但第一版 UI 不提供绕过开关。

### 5.4 确定性展开

每个展开元件使用结构化实例路径，内部保存为路径段数组。序列化成扁平 ID 时
对分隔符进行转义，不能直接拼接未经处理的用户 ID。两个不同层次路径永远不能
产生同一扁平 ID。

嵌套边界不使用普通 `BUF`，因为现有门语义会把 `Z` 输入归一为 `X`，从而
改变线路穿过模块边界时的含义。编译器改为做纯连接替换：

- 模块输入端收到的全部外部驱动，直接连接到该输入端的全部内部消费者。
- 模块输出端的全部内部驱动，直接连接到该输出端的全部外部消费者。
- 多驱动与多消费者展开为确定性的驱动端/接收端组合，之后仍由现有网络解析器
  聚合驱动。
- 根预览模块的 `Module Input` 才展开为 `Trit Input`。
- 根预览模块的 `Module Output` 展开为 `Probe`。

projection 为逻辑模块端口保存其展开后的驱动端集合。项目级 simulator 使用
与内核网络相同的 `resolve_drivers` 聚合这些输出，以显示模块实例端口信号；
不为观察目的向电路插入会影响诊断或传播的合成门。没有驱动的端口集合解析为
`Z`，因此 `Z/X/E` 和多驱动冲突可跨任意层级保持原语义。

### 5.5 快照投影、诊断回投与增量输入

编译产物同时保存双向 provenance。所有逻辑引用都自身携带作用域，不能用一组
全局 `circuitId/instancePath` 限定整条诊断：

```text
QualifiedComponentRef { circuitId, instancePath, componentId }
QualifiedConnectionRef { circuitId, instancePath, connectionId }
QualifiedPortRef { circuitId, instancePath, componentId, portId }
```

- 每个扁平元件映射到一个 QualifiedComponentRef。
- 每条生成连接映射到参与展开的 QualifiedConnectionRef 有序集合。
- 每个扁平目标输入保留独立 `TargetNetId`，其身份是完全限定的目标组件和端口。
- 模块边界另有 `BoundaryPortNetId`，记录穿过该边界的规范驱动集合以及它影响的
  TargetNetId；两种网络 ID 不能混用。
- 每个当前层级模块端口映射到扁平驱动集合及其 BoundaryPortNetId。

项目级 simulator 使用 `ProjectDiagnostic` 对外报告：code、severity、message、
可选 primary location，以及 QualifiedComponent/Connection/PortRef 数组。扁平
诊断通过 provenance 回投，生成 ID 不直接暴露给用户。非网络诊断的稳定去重键
是 `code + severity + 排序后的全部限定引用`，不依赖本地化 message。

网络冲突遵循以下规则：

1. 每个 TargetNetId 始终独立，不能因为共享一个边界扇出就合并。
2. BoundaryPortNetId 的驱动集合本身冲突时，产生一条边界端口诊断，即使没有
   内部消费者。
3. 若某目标网的完整驱动集合与冲突边界集合完全相同且没有额外本地驱动，目标
   冲突由边界诊断覆盖，不重复显示。
4. 只要目标网增加、移除或替换了任何驱动，就保留该 TargetNetId 自己的冲突
   诊断；不同消费者的本地冲突绝不互相去重。
5. BoundaryPortNetId 之间建立有向因果关系。若下游边界只有一个上游逻辑来源，
   该来源是已经报告冲突的边界，规范驱动集合完全相同且没有附加驱动，则下游
   冲突由最上游边界覆盖。该规则沿多层输入或输出边界传递；一旦合并第二个
   逻辑来源便停止覆盖，并为下游边界保留独立诊断。

诊断中的任一限定引用都可以让 Web 导航到正确模块定义和实例路径。跨父子层级
的一条诊断可以同时包含多个不同 circuitId 与 instancePath，不产生 ID 歧义。

WASM 新增项目级 simulator 句柄。每个句柄只对应一个活动预览根，保存该根的
扁平 Simulator、projection、provenance 与 compile count。返回快照时：

- 当前画布的内置元件使用其投影后的输入输出。
- 当前画布的模块实例按动态端口返回输入输出。
- 当前预览模块的边界元件返回预览输入和模块输出。
- 深层内部元件不混入当前画布快照。

project `setSource` 只更新当前展开图中的 source 副本，不重新运行层次编译。
以下生命周期规则固定：

- 如果逻辑 source 合法存在，但在当前活动根的展开图中有零个副本，操作成功
  作为“仅持久化更新”：只修改 ProjectDocument，不调用 `set_sources`、不
  settle、不编译。以后导航到该模块或使它变为可达时，从新值初始化。
- 如果 circuitId/componentId 不存在，或目标不是可变 source，才返回稳定错误。

- 连续输入变化：compile count 增量为 0。
- 当前电路或其可达依赖发生结构变化：重新编译当前预览根。
- 仅不可达电路结构变化且全工程校验成功：保留当前 Simulator，不重建扁平图。
- 任何全工程校验失败，包括只发生在不可达模块中的错误：立即丢弃当前
  Simulator、清空 snapshot、禁止 setSource，并显示工程级诊断；不能继续展示
  或操作旧成功信号。
- 修复上述错误后，由于句柄已丢弃，当前活动根重新编译一次并恢复仿真。
- 面包屑进入或返回另一电路：以新的 `activeCircuitId` 重新编译一次，因为根
  Module Input/Output 的展开角色发生变化。
- 第一版不缓存多个 active simulator；切回旧层级会再次编译，避免状态一致性
  和内存管理复杂化。

测试分别记录输入更新、结构更新和导航切换的 compile count，不能再使用
“整个工程加载后永远只编译一次”的模糊表述。

## 6. Web 状态与组件边界

当前 `App.tsx` 已超过单文件适合承担的职责。阶段 2A 只做服务于层次编辑的
定向拆分：

- `project-document`：v1/v2 解析、迁移、序列化和深克隆。
- `project-store`：全部电路、活动路径、每电路 viewport、选择与历史。
- `project-catalog`：把 Rust 内置目录与项目模块接口合并为动态元件目录。
- `hierarchy-runtime`：项目级 WASM API、结构版本和投影快照适配。
- `ModuleManager`：新建、重命名、删除和引用说明。
- `HierarchyBreadcrumbs`：进入与返回层级。

撤销重做以整个 ProjectDocument 为历史快照；活动路径和选择不写入工程文件，
也不制造历史记录。一次模块内部编辑只生成一个历史节点。撤销导致当前路径失效
时，编辑器回到最近仍存在的祖先，最终回到主电路。

## 7. 错误模型

新增稳定错误代码至少包括：

```text
DUPLICATE_CIRCUIT_ID
INVALID_ROOT_CIRCUIT
INVALID_MODULE_BOUNDARY
DUPLICATE_MODULE_PORT_ID
UNKNOWN_MODULE
UNKNOWN_MODULE_PORT
MODULE_REFERENCE_NOT_MODULE
INVALID_MODULE_PORT_DIRECTION
MODULE_DEPENDENCY_CYCLE
HIERARCHY_EXPANSION_LIMIT
MODULE_IN_USE
MODULE_PORT_IN_USE
INVALID_ACTIVE_CIRCUIT
```

循环诊断必须给出完整路径，例如：

```text
模块依赖形成循环：ALU -> Adder -> CarryUnit -> ALU
```

编译或加载失败时不显示上一次成功电路的旧信号；画布信号回到 `Z`，状态栏和
诊断面板展示结构化错误。工程内容继续可编辑，用户修复后自动重新编译。

## 8. 示例与验收流程

新增层次化教学工程：

1. `Half Adder` 模块：两个 Module Input、MOD_SUM、CONSENSUS、两个
   Module Output。
2. `Full Adder` 模块：三个 Module Input、两个 Half Adder 实例、一个
   MOD_SUM、两个 Module Output。
3. 主电路：三个 Trit Input、一个 Full Adder 实例、两个 Probe。

默认输入覆盖一个容易识别的结果，同时自动测试遍历全部 27 组
`a/b/cin in {T,0,1}`，验证：

```text
a + b + cin = sum + 3 * carry
```

浏览器验收还必须证明：

- 双击 Full Adder 能进入定义，再双击 Half Adder 进入第二层。
- 面包屑返回时主电路和各层 viewport 不丢失。
- 修改 Half Adder 内部结构会同时影响两个实例。
- 已连接端口和被引用模块的删除受到保护。
- 导出 v2 后重新导入，层次、位置、名称和输出保持一致。
- 构造递归引用的导入文件时得到稳定诊断且浏览器不冻结。

## 9. 测试策略

### 9.1 Rust

- Project v2 serde 往返与稳定诊断排序。
- v1 逐字段迁移固定生成 `main/Main/main`，并保持原组件、连接、属性和 viewport。
- v1 普通元件中与 v2 特殊键同名的扩展属性仍无损迁移。
- 边界目录导出、端口方向、重复端口和未知引用。
- 不可达模块中的未知普通元件、非法属性、重复 ID 和错误连接仍被拒绝。
- 两层与三层展开后的元件/连接数量及确定性 ID。
- 直接递归、间接递归和不可达递归均明确处理；整个工程仍拒绝任何依赖环。
- 指数嵌套、边界连接笛卡尔积、checked arithmetic 溢出和接近预算上限。
- `Z/X/E` 穿过模块边界时与手工扁平电路完全等价。
- 无消费者冲突端口仍有诊断；纯边界扇出冲突只显示边界诊断，带额外本地驱动
  的不同 TargetNetId 保留各自诊断。
- 三层输入/输出边界链只在最上游冲突来源报告一次；下游合并额外驱动后恢复
  独立诊断。
- 扁平元件与连接诊断能稳定回投每条引用自己的 circuitId、instancePath 和
  原始 ID；跨父子作用域 ID 不歧义。
- 半加器到全加器的 27 组穷举。
- 层次工程与等价扁平工程的快照性质测试。

### 9.2 WASM

- 加载项目、切换预览电路、设置根输入和返回投影快照。
- project `setSource` 原子更新共享定义的全部展开副本，支持 Trit Input 与
  Constant；任一非法更新使批次整体失败。
- 当前展开副本为零的合法 source 更新只持久化，不 settle、不编译；撤销、导出
  和之后导航均恢复新值。
- 结构错误保持机器可读 code 与 diagnostics。
- 输入更新不触发重复编译；结构更新和活动预览切换各精确增加一次 compile
  count，不可达结构变化不重建当前扁平图。

### 9.3 Web

- v1 到 v2 迁移不改写原有电路内容。
- Project Store 的模块增删改、路径导航、撤销重做和深克隆。
- `value/previewValue` 持久化但不增加结构 revision；值历史用 project
  `setSource` 恢复。
- 共享模块实例化两次后修改、撤销和重做内部 source 值，两个实例保持同步。
- 动态目录端口与模块定义一致。
- 删除保护、祖先过滤和无效路径恢复。
- 不可达模块变为非法时清空 snapshot 并禁用输入，修复后重新编译活动根。
- 示例模板加载后不可反向修改原模板。

### 9.4 Playwright 与性能

- 自动完成层次示例的进入、返回、输入切换、导入导出和删除保护。
- 在 `1440x900`、`900x700`、`390x844` 下无横向溢出。
- 控制台无未处理异常。
- 单独记录“层次编译时间”和“输入到稳定快照时间”。
- 性能工程至少包含 100 个 Full Adder 实例，并展开为真实基础元件。
- 本地目标：编译和单次输入传播各小于 `50 ms`；CI 阈值各为 `150 ms`。
- 测试必须证明连续输入变化期间 compile count 不增加。
- 导航切换允许且要求重新编译；该耗时单独记录，不混入输入传播指标。

## 10. 完成标准

阶段 2A 只有在以下条件全部满足时完成：

- 用户能从空模块开始定义端口和内部组合逻辑。
- 自定义模块能重复实例化并支持至少三层无环嵌套。
- Rust 是层次校验、展开、门逻辑和网络解析的唯一语义来源。
- 输入切换不重新编译结构。
- 当前层级的模块端口、导线和 Probe 显示正确六状态。
- 展开预算能在分配大图前拒绝指数级工程，浏览器不会因合法无环输入而失控。
- 层次运行诊断能去重并回投到原始电路、实例路径、元件、连接和端口。
- v1 自动迁移、v2 往返和错误导入均有测试。
- 半加器 -> 全加器 -> 顶层测试链通过 27 组穷举。
- 删除保护、递归诊断、撤销重做和层次导航通过浏览器验收。
- Rust、WASM、Vitest、生产构建和 Playwright 全部通过。
- 设计文档记录实际测试数量、性能结果和残余限制。

## 11. 实际验收结果

验收日期：2026-08-04。

- Rust workspace：126 项测试通过，`rustfmt` 与全 workspace `clippy -D warnings`
  通过。
- WASM Node：6 项边界测试通过；项目级 metrics 来自实际展开产物。
- Web：96 项 Vitest 测试通过，TypeScript 检查与 Vite 生产构建通过。
- Playwright：13 项 Chromium 验收通过，覆盖 `1440x900`、`900x700`、
  `390x844` 三种视口，无页面横向溢出和未处理控制台错误。
- 层级加法器：27 组已知输入全部满足
  `a + b + cin = sum + 3 * carry`，共享 Half Adder 定义更新同时作用于两个实例。
- 性能工程：100 个 Full Adder 实例真实展开为 507 个基础元件、1,004 条连接、
  3,811 个 projection 端点。三次层次编译样本为 34.5、33.7、34.4 ms，
  中位数 34.4 ms；单次输入传播 3.3 ms；compile count 保持 `1 -> 1`。

残余工具提示不影响结果：`wasm-pack` 会提示 crate 缺少可选的 description、
repository 和 crate 目录内的 LICENSE 文件；Playwright 启动的 Node 进程会提示
`FORCE_COLOR` 覆盖 `NO_COLOR`。阶段 2A 仍明确不包含递归模块、多-trit 总线、
时序逻辑和框选后一键封装。

本机执行 `playwright install --with-deps chromium` 时，系统包安装需要交互式
sudo 密码，因此该条不能在当前非提权会话完成；`playwright install chromium`
和全部浏览器验收均通过。CI 保留 `--with-deps`，在 GitHub runner 的可提权环境
安装系统依赖。
