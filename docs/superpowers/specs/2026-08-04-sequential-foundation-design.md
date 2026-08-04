# Logsim Ternary 阶段 3A：单-trit 时序基础设计

## 1. 状态与目标

阶段 2A 已完成层级组合模块。阶段 3A 的目标是加入最小但严格的同步时序语义，
让用户能够用 Clock、DFF 和现有组合门搭建可单步运行的状态电路，为阶段 3B 的
3-trit 寄存器和波形记录打基础。

本阶段采用事务式单步 tick：一次用户操作完成一个完整时钟脉冲和一次同步状态
提交。用户已授权阶段间直接写设计、计划并继续实现，因此本设计按现有路线和
硬件学习目标冻结，不再等待逐项确认。

## 2. 方案选择

评估过三种方案：

1. **完整逻辑时间优先队列**：最接近通用离散事件仿真器，但会同时引入延迟、
   多时钟域和事件排序，超出“先跑通单-trit DFF”的范围。
2. **半周期切换**：每次操作只把时钟从 0 切到 1 或从 1 切到 0，硬件过程直观，
   但用户要点击两次才完成一拍，演示和测试容易混淆“边沿”与“周期”。
3. **事务式完整 tick**：一次操作内部执行上升沿采样和下降沿恢复，最终快照处于
   稳定低电平。它保留同步采样和状态同时提交，又不提前承诺物理延迟模型。

阶段 3A 采用方案 3。内核仍使用现有 delta-cycle 组合传播，只在 tick 边界加入
确定性的时序状态转移。阶段 3B 再决定是否把内部相位公开到波形面板。

## 3. 范围

### 3.1 本阶段包含

- `source.clock` 时钟源，稳定快照时输出 `0`。
- `sequential.dff` 单-trit 上升沿 DFF，带写使能和同步复位。
- Rust `Simulator::tick()` 与 `ProjectSimulator::tick()`。
- 所有 DFF 同时采样、同时提交的双缓冲状态更新。
- reset 同时恢复普通输入初值、Clock 低电平、DFF `Q=0` 和 tick count。
- Clock/DFF 穿过层级展开；共享模块的每个 DFF 实例保存独立状态。
- WASM API v2 的 `tick()` 和包含 `tickCount` 的项目快照。
- Web 工具栏单步按钮、tick 计数、时序元件目录和可编辑 DFF 示例。

### 3.2 本阶段不包含

- 3-trit 寄存器、移位寄存器、计数器和 RAM。
- 波形面板、时钟频率、自动运行和真实时间定时器。
- 多时钟域、独立 Clock 相位、下降沿触发和异步复位。
- setup/hold、亚稳态、门延迟、时钟偏斜和物理时间。
- 状态跨结构重编译或跨活动根导航保存。

## 4. 元件语义

### 4.1 Clock

`source.clock` 只有输出端口 `out`。工程文件不保存运行相位；加载、reset 和每次
完整 tick 结束时均为 `0`。一次 tick 内所有当前活动展开图中的 Clock 同步产生
`0 -> 1 -> 0` 脉冲。

多个 Clock 在阶段 3A 中属于同一全局时钟域。它们可以经过现有组合门形成门控
时钟，但不能设置独立频率或相位。

### 4.2 DFF

`sequential.dff` 端口固定为：

```text
d    输入数据
clk  时钟输入
en   写使能，高有效
rst  同步复位，高有效
q    状态输出
```

DFF 初始状态固定为 `Q=0`。上升沿到来时按以下优先级计算下一状态：

1. `rst=1`：写入 `0`。
2. `rst=E`：写入 `E`；`rst=X/Z`：写入 `X`。
3. `rst=0/T` 且 `en=1`：采样 `d`；`d=Z` 归一为 `X`，其余状态原样保存。
4. `rst=0/T` 且 `en=0/T`：保持原 `Q`。
5. `rst=0/T` 且 `en=E`：写入 `E`；`en=X/Z`：写入 `X`。

控制端使用“正值断言”规则：`1` 表示有效，`0` 和 `T` 表示无效。这样控制信号
仍是原生 trit，同时明确区分未知、高阻和冲突。

只有 `clk` 从非 `1` 变为 `1` 才是上升沿。`clk=X/Z/E` 不触发采样；后续从这些
状态变为 `1` 会触发一次上升沿。没有 Clock 或其他信号制造上升沿时，DFF 保持。

## 5. Rust 仿真模型

`Simulator` 增加会话状态，而不是把运行状态写回电路定义：

```rust
pub struct SequentialState {
    pub tick_count: u64,
    pub dff_outputs: BTreeMap<String, Trit>,
    pub clock_levels: BTreeMap<String, Trit>,
}
```

组合门继续由 `gates::evaluate` 纯函数求值。Clock 和 DFF 由 Simulator 专门处理：
Clock 输出读取 `clock_levels`，DFF 输出读取 `dff_outputs`，普通传播永远不会直接
改写 DFF 状态。

一次 `tick()` 固定执行：

1. 复制当前稳定快照中每个 DFF 的 `clk`，再把全部 Clock 驱动设为 `1`，运行
   组合传播直至稳定。
2. 读取每个 DFF 已解析的 `d/clk/en/rst`，对检测到上升沿的 DFF计算 next state。
3. 使用独立 map 同时提交全部 next state，禁止元件遍历顺序影响采样结果。
4. 从所有已变化 DFF 的 `q` 启动组合传播，直至稳定。
5. 把全部 Clock 驱动恢复为 `0`，再次传播到稳定快照。
6. tick count 加一并返回快照。

如果任一传播相位不收敛，沿用 `NON_CONVERGENT_COMBINATIONAL_LOOP`，tick 返回
`stable=false`；已经提交的同步状态不回滚。后续 reset 可恢复确定初态。

`SimulationSnapshot` 增加 `tick_count`。WASM API 版本从 1 升为 2，避免调用方把
新增时序契约误认为旧接口。Project v2 文件格式不变，因为运行状态不持久化。

## 6. 层级工程语义

层次编译器把 Clock 和 DFF 当作可展开基础元件。一个 DFF 定义被实例化两次时，
扁平 ID 不同，`dff_outputs` 因而保存两份独立状态；修改共享模块结构仍同时影响
两个实例，但运行状态不会错误共享。

`ProjectSimulator::tick()` 调用当前扁平 Simulator 的 tick，再通过现有 projection
和 provenance 生成活动画布快照。项目快照增加 `tickCount`。

状态生命周期固定如下：

- 普通 source 值更新不增加 tick count，也不重置 DFF。
- 仅不可达模块变化且复用当前 Simulator 时保留状态。
- 当前可达结构重编译、切换活动根、加载新工程时，Clock/DFF 恢复初态。
- undo/redo 如果只改 source 值则保留状态；跨越结构历史节点则按重编译规则复位。
- 导出只保存电路定义和 source 当前值，不保存 tick count 或 DFF Q。

## 7. Web 交互

工具栏新增 Lucide `StepForward` 图标按钮“单步 Tick”，只在仿真器就绪且快照有效
时启用。状态栏显示 `N TICKS`。现有 reset/默认示例语义扩展为恢复时序初态。

元件库新增“时序”分组：

- Clock 使用时钟图标，节点显示当前 `0/1`。
- DFF 使用触发器图标，节点主信号显示 `Q`，端口旁显示 `d/clk/en/rst/q`。

基础示例“单-trit DFF”包含：数据 Trit Input、Clock、写使能 Trit Input、复位
Trit Input、DFF 和 Q Probe。默认 `D=1, EN=1, RST=0`；载入时 Q 为 0，点击
单步后 Q 变为 1。用户可以修改 D、EN、RST 后继续逐拍观察。

窄屏工具栏把 Tick 保留为可见图标命令，不新增说明卡片。元件帮助区域提供端口
含义、采样优先级和控制 trit 规则。

## 8. 错误与边界

- DFF 未连接输入继续产生现有 `UNDRIVEN_INPUT`，高阻控制在采样时转为 `X`。
- 多驱动冲突继续由网络解析产生 `E`，DFF 在边沿按上述规则保存 `E`。
- tick 前项目校验失败时返回 `PROJECT_NOT_READY`，不改变 tick count 或状态。
- 没有 Clock 或没有上升沿的合法电路仍可 tick；tick count 增加，DFF 保持。
- tick count 使用 checked addition；达到 `u64::MAX` 返回 `TICK_COUNT_OVERFLOW`，
  不执行该次 tick。

## 9. 测试与验收

### 9.1 Rust

- Clock/DFF 目录、端口方向和属性校验。
- 初始 Q=0、第一次上升沿采样、EN 保持、RST 优先和辅助状态表。
- 两个互相连接的 DFF 证明同时采样，不受元件 ID 或排序影响。
- reset 恢复 Q、Clock 和 tick count。
- Clock 经组合门后的有效/无效上升沿。
- 层级共享 DFF 的独立实例状态和投影快照。
- source 更新不重编译、不重置状态；结构更新和导航按规则复位。

### 9.2 WASM 与 Web

- flat/project `tick()` 返回 API v2 和正确 tick count。
- 未加载或项目失效时 tick 返回结构化错误。
- 工具栏 tick、状态栏、示例加载、输入切换和 reset。
- 桌面、紧凑和移动视口无溢出或控制台错误。

### 9.3 浏览器验收

真实 WASM 示例依次验证：加载时 Q=0，tick 后 Q=1，EN 无效时保持，RST 有效时
回到 0，连续 tick count 正确。再加载含两个共享 DFF 实例的层级示例，证明同一
模块定义的实例状态互不串扰。

## 10. 完成标准

- 用户能从元件库搭出并单步运行一个单-trit 状态电路。
- 所有 DFF 在一个 tick 中同时采样和提交。
- Clock/DFF 通过 Rust/WASM 和层级展开，不在 TypeScript 中实现状态语义。
- reset、结构重编译、导航和 source 更新的状态生命周期有确定测试。
- API v2、项目快照和 Web 状态栏对 tick count 的命名一致。
- Rust、WASM、Vitest、生产构建和 Playwright 全部通过。
