# 三进制 RAM/ROM 混合实现设计

**日期：** 2026-08-11  
**状态：** 已确认设计，待实现  
**范围：** Project v3、Rust 仿真内核、WASM/Web 工作台

## 1. 目标

为 Logsim Ternary 增加足够搭建小型三进制计算机的 ROM 和 RAM，同时保持：

- 多-trit 端口和层级模块可组合；
- RAM 写入遵循现有半周期时钟模型；
- 大小固定且适合教学，不引入无限内存；
- 用户元件可检查到真实内部 cell 和来源映射；
- 不把 27-word 内存展开成大量门级译码器和 DFF。

第一版只实现单端口 ROM 和单端口 RAM，不实现双口 RAM、字节使能、文件格式导入或物理延迟。

## 2. 方案选择

采用混合方案。用户看到的是宽度感知的 `memory.rom` 和 `memory.ram`，Project v3 编译器将每个 W-trit 内存拆成 W 个内部 scalar memory cell。每个 cell 保存同一 bit lane 在全部地址上的 trit；地址和控制端复制到所有 cell，数据端逐 lane 映射。

内部 cell 是 Rust 仿真原语，不出现在普通元件库中。它们保留稳定生成 ID、宏端口来源和层级实例路径，因此结构检查、诊断和波形仍可回到用户放置的 RAM/ROM。

旧扁平 Circuit、Project v2 和旧 WASM Simulator 不执行结构宏，遇到 RAM/ROM 时返回 `STRUCTURAL_COMPONENT_REQUIRES_PROJECT_V3`。

## 3. 公共元件契约

### 3.1 ROM

类型 ID：`memory.rom`

```text
inputs:  addr[AW]
outputs: data[W]

wordWidth:    W  = 1..27
addressWidth: AW = 1..3
depth:        3^AW = 3 / 9 / 27 words
contents:     depth 个 W-trit 已知字
```

ROM 为异步读。地址改变并完成组合传播后，`data` 立即显示对应字。reset 和 Tick 不改变 ROM 内容。

### 3.2 RAM

类型 ID：`memory.ram`

```text
inputs:  addr[AW], din[W], we, clk, rst
outputs: dout[W]

wordWidth:    W  = 1..27
addressWidth: AW = 1..3
depth:        3^AW = 3 / 9 / 27 words
```

RAM 为异步读、上升沿同步写：

```text
rst=1  -> 上升沿清零全部 words
否则 we=1 -> 上升沿把 din 写入当前 addr
否则       -> 保持
```

优先级为 `rst > we > hold`。下降沿不写入。所有 W 个 cell 在同一个上升沿从旧状态计算并同时提交，不能出现半个 word 已写、半个 word 未写的中间状态。

第一版 RAM 上电和 reset 后全部为 `0`，不提供 RAM 初值编辑。

## 4. 平衡三进制地址

地址字符串沿用项目 MS-first 约定。先将地址解释成平衡三进制有符号整数，再增加偏置：

```text
bias  = (3^AW - 1) / 2
index = balanced_value(addr) + bias
```

示例：

```text
AW=1: T -> 0, 0 -> 1, 1 -> 2
AW=2: TT -> 0, 00 -> 4, 11 -> 8
AW=3: TTT -> 0, 000 -> 13, 111 -> 26
```

ROM 属性中的 contents 按物理 index 顺序保存，即从最负地址到最正地址。

地址中出现 `E` 时读输出为全 `E`；地址中出现 `X` 或 `Z` 时读输出为全 `X`。写入时，地址、`we` 或 `rst` 中出现 `X/Z/E` 都视为无法安全提交的运行时错误：记录 fault，保持整块 RAM 原状态，不选择任意地址，也不产生部分写入。只有全部控制已知时才应用 `rst > we > hold`。

## 5. ROM 内容格式与验证

Project v3 属性使用：

```json
{
  "label": "Program ROM",
  "wordWidth": 3,
  "addressWidth": 3,
  "contents": ["000", "001", "01T"]
}
```

`contents` 最多包含 `3^AW` 行；不足部分在编译时补零。每行必须恰好为 W 个 `T/0/1`，不允许 `X/Z/E` 作为持久内容。非法宽度、超量内容或错误字长必须在分配和编译前原子拒绝，旧工程和运行状态保持不变。

稳定诊断码：

- `INVALID_MEMORY_ADDRESS_WIDTH`
- `INVALID_MEMORY_CONTENTS`
- `STRUCTURAL_COMPONENT_REQUIRES_PROJECT_V3`

## 6. 编译与运行时

Project v3 lowering 在普通 scalar hierarchy compilation 之前执行：

```text
memory.rom(W, AW) -> W 个 internal ROM cell
memory.ram(W, AW) -> W 个 internal RAM cell
```

每个 cell 的端口：

```text
ROM cell: addr0, addr1, addr2 -> q
RAM cell: addr0, addr1, addr2, d, we, clk, rst -> q
```

未使用的高地址端固定为 0 或由 cell 的 `addressWidth` 忽略。生成 ID 包含用户组件 ID、memory kind 和 lane index，并使用现有碰撞规避规则。

RAM cell 状态由 Simulator 持有，形状为 depth 个 trit。低到高相位事务先读取所有旧 RAM、计算所有 next state，再统一替换，复用 DFF 的同步提交原则。ROM cell 内容来自编译后的不可变属性。

结构检查接口返回实际可执行 cell ID、原语类型、lane index、depth，以及每个内部端口对应的用户宏端口。结构重编译或有效内容变更清除 trace 并暂停自动时钟；label-only 修改保留 RAM 状态和时钟相位。

## 7. Web 工作台

元件库新增：

- `ROM`，默认 `wordWidth=3`、`addressWidth=3`、27 个零字；
- `RAM`，默认 `wordWidth=3`、`addressWidth=3`。

属性面板提供数据宽度、地址宽度和 ROM 内容编辑。ROM 内容使用逐地址 word 编辑器，显示平衡三进制地址；提交时一次性验证并原子更新。RAM 节点显示当前 `dout`，ROM 节点显示当前 `data`。中文帮助说明异步读、上升沿写、复位优先级和地址偏置。

新增一个 Memory Lab 示例：三进制地址源连接 ROM 和 RAM，RAM 另接 `din/we/clk/rst`，两个输出均接 Probe，并默认加入 Chronogram 可选信号。示例用于现场演示读 ROM、写 RAM、保持和复位。

## 8. 测试与验收

Rust 独立 oracle 测试覆盖：

- AW 1/2/3 的全部地址映射；
- W 1/3/27 的逐 lane 读写；
- ROM 异步读和零填充；
- RAM 上升沿写、下降沿不写、异步读；
- `rst > we > hold`；
- 同时 word 提交和嵌套实例隔离；
- X/Z/E 地址和控制；
- 稳定 ID、来源映射和展开预算；
- 非法属性原子失败；
- reset、重编译、trace 和自动时钟生命周期。

Web 测试覆盖动态端口、属性编辑、目录帮助、节点实时 word 和 Memory Lab。桌面 Playwright 验收至少完成一次 ROM 地址切换、一次 RAM 写入、一次保持、一次复位，并在 Chronogram 中看到 addr、clk、din、ROM data 和 RAM dout。

## 9. 非目标

第一版不包含：

- 双读口或双写口 RAM；
- 独立读写地址；
- 字节或 trit 写使能；
- MIF/HEX/VCD 文件导入导出；
- 超过 27 words 的内存；
- 物理 SRAM 时序、建立保持时间或传播延迟；
- 将 RAM 完全展开成 DFF、译码器和 MUX。
