# 三进制体系结构学习规划

## 目标

这份规划面向一个具体研究任务：基于已有三值/3bit 器件，逐步设计一套能先跑通的三进制体系结构。

第一阶段不追求完整 CPU，也不追求复杂 ALU。主线是先把三值基础模块做稳：

- 明确三值信号、寄存器和 3-trit 数据通路的表示方式。
- 实现单 trit 基础逻辑模块。
- 实现 3-trit 寄存器、3-trit 加减法器和简化 ALU。
- 在小规模仿真或板级实验中跑通最小数据通路。
- 最后再扩展到寄存器堆、控制器、指令集和最小三进制处理器。

## 参考材料

优先阅读 Douglas W. Jones 的 ternary computing 系列页面：

- Ternary Manifesto: https://homepage.cs.uiowa.edu/~jones/ternary/
- Standard Ternary Logic: https://homepage.cs.uiowa.edu/~jones/ternary/logic.shtml
- Fast Ternary Addition: https://homepage.cs.uiowa.edu/~jones/ternary/arith.shtml
- Number Representations for Ternary Computers: https://homepage.cs.uiowa.edu/~jones/ternary/numbers.shtml
- Binary Coded Ternary and Ternary Coded Binary: https://homepage.cs.uiowa.edu/~jones/ternary/bct.shtml
- Trillium Architecture: https://homepage.cs.uiowa.edu/~jones/ternary/trillium.shtml

已有本地资料：

- [Ternary CPU 5500 ISA 学习笔记](../research/ternary-cpu-5500-isa-study-notes.md)

Jones 的材料里，最适合本项目先用的是三值逻辑、balanced ternary、基础门、加法器和小型 9-trit 架构思路。BCT 只作为普通二进制环境里的参考模型，不作为硬件主线。

## 术语约定

后续学习和设计中，先统一采用 balanced ternary：

| 符号 | 数值 | 逻辑含义 |
| --- | ---: | --- |
| `-` | `-1` | false / negative |
| `0` | `0` | unknown / zero |
| `+` | `+1` | true / positive |

如果一个数据字有 3 个 trit，则数值范围为：

```text
最大值 +++ = 1*3^2 + 1*3^1 + 1 = 13
--- = -1*3^2 + -1*3^1 + -1 = -13
3-trit balanced ternary 范围 = -13 到 +13
```

这里的 `3-trit` 寄存器不是普通二进制 3-bit 寄存器，而是由三个三值位组成的寄存器。若底层器件接口仍然需要二进制测试平台描述，可以单独建立参考编码，但不要把参考编码误当作真实三值电路本身。

## 总体路线

学习路线分成 8 个阶段。每个阶段都要留下三个产物：

1. 一页学习笔记。
2. 一组真值表或行为规则。
3. 一个可测试的小模块。

不要跳过真值表。三值设计最容易出错的地方不是模块写不出来，而是 `- / 0 / +` 的边界语义没有提前定死。

## 阶段 0：接口和实验边界

目标：先把团队已有器件能表达什么说清楚。

本阶段阅读链接：

- Ternary Manifesto: https://homepage.cs.uiowa.edu/~jones/ternary/
  - 重点看 trit、trybble、tryte、word 的基本动机。
- Standard Ternary Logic: https://homepage.cs.uiowa.edu/~jones/ternary/logic.shtml
  - 重点看 `+ / 0 / -` 的逻辑和数值含义。
- Binary Coded Ternary and Ternary Coded Binary: https://homepage.cs.uiowa.edu/~jones/ternary/bct.shtml
  - 只看二进制测试平台如何表达三值数据，不作为硬件主线。

要确认的问题：

- 一个物理三值位如何表示 `- / 0 / +`。
- 复位后寄存器默认是 `0`，还是其他状态。
- 现有器件是否支持标准三值反相、传输、锁存。
- 仿真环境如何表示三值信号。
- 是否允许用二进制 SystemVerilog testbench 做参考模型。

产物：

- `docs/trit_signal_convention.md`
- 三值电平或编码说明表。
- 单 trit 输入输出观测脚本或实验记录。

退出标准：

- 所有人对 `- / 0 / +` 的含义一致。
- 一个单 trit 信号可以被输入、保持、输出和观测。

## 阶段 1：三值基础逻辑

目标：掌握并实现单 trit 基础门。

本阶段阅读链接：

- Standard Ternary Logic: https://homepage.cs.uiowa.edu/~jones/ternary/logic.shtml
  - 必读。重点看 ternary constants、monadic operators、diadic operators。
- [Ternary CPU 5500 ISA 学习笔记](../research/ternary-cpu-5500-isa-study-notes.md)
  - 辅助看 `ANY/EQUAL/TXOR/SUM/CONS/MIN/MAX` 这些三值原生函数。

优先学习 Jones 的 `Standard Ternary Logic` 页面，重点看：

- ternary constants
- buffer
- negation
- increment / decrement
- decoder
- min / max
- consensus
- accept-any

第一批必须实现的模块：

| 模块 | 含义 |
| --- | --- |
| `trit_buf` | 输出等于输入 |
| `trit_neg` | `-` 和 `+` 互换，`0` 保持 |
| `trit_min` | 两个输入取较小值 |
| `trit_max` | 两个输入取较大值 |
| `trit_is_neg` | 判断输入是否为 `-` |
| `trit_is_zero` | 判断输入是否为 `0` |
| `trit_is_pos` | 判断输入是否为 `+` |
| `trit_mux2` | 二选一 |
| `trit_mux3` | 三选一 |

建议顺序：

1. 先实现 `buf` 和 `neg`。
2. 再实现 `min` 和 `max`。
3. 再做三个 decoder。
4. 最后做 mux。

退出标准：

- 每个模块都有完整的 3 项或 9 项真值表。
- 每个模块都能自动遍历所有输入组合。
- `min/max/neg` 满足 De Morgan 关系：

```text
min(a, b) = -max(-a, -b)
max(a, b) = -min(-a, -b)
```

## 阶段 2：三值寄存器

目标：做出可靠的单 trit 和 3-trit 时序存储。

本阶段阅读链接：

- Standard Ternary Logic: https://homepage.cs.uiowa.edu/~jones/ternary/logic.shtml
  - 复习 buffer、driver、decoder、clamp，为寄存器输入输出控制做准备。
- The Trillium Architecture: https://homepage.cs.uiowa.edu/~jones/ternary/trillium.shtml
  - 重点看 Registers 和 Processor Status Word，理解小型三进制机如何组织寄存器和状态。
- Number Representations for Ternary Computers: https://homepage.cs.uiowa.edu/~jones/ternary/numbers.shtml
  - 辅助理解寄存器中一个 word 或小字长数据如何解释为数值。

要实现的模块：

| 模块 | 含义 |
| --- | --- |
| `trit_dff` | 单 trit D 触发器 |
| `trit_reg_en` | 带写使能的单 trit 寄存器 |
| `trit_reg_reset` | 带复位的单 trit 寄存器 |
| `reg3t` | 3-trit 寄存器 |
| `reg3t_en` | 带写使能的 3-trit 寄存器 |

关键问题：

- 复位值优先设为 `000`。
- 写使能无效时必须保持原值。
- 如果输入是非法态，模块要么隔离，要么在测试中报错。

退出标准：

- 3-trit 寄存器可以稳定保存 `-13` 到 `+13` 中的任意值。
- 寄存器写入、保持、复位三种行为都通过测试。

## 阶段 3：3-trit 数值表示

目标：熟悉 balanced ternary 数值和手工换算。

本阶段阅读链接：

- Number Representations for Ternary Computers: https://homepage.cs.uiowa.edu/~jones/ternary/numbers.shtml
  - 必读。重点看 balanced ternary、biased representation、tryte/word 组织。
- Ternary Manifesto: https://homepage.cs.uiowa.edu/~jones/ternary/
  - 重点看为什么三进制世界中 `3/9/27/81` 会自然出现。
- Binary Coded Ternary and Ternary Coded Binary: https://homepage.cs.uiowa.edu/~jones/ternary/bct.shtml
  - 只用于写参考模型和测试脚本时查表示方法。

必须掌握：

```text
value = t2 * 3^2 + t1 * 3^1 + t0 * 3^0
```

例子：

```text
+++ = 13
++0 = 12
++- = 11
+0- = 8
00+ = 1
000 = 0
00- = -1
--- = -13
```

练习：

- 写出 `-13` 到 `+13` 的 3-trit 编码表。
- 写出 3-trit 取反表。
- 写出 3-trit 加 1 和减 1 的结果表。

产物：

- `docs/3trit_number_table.md`
- `tools/` 下可选一个小脚本，用普通二进制环境生成参考表。

退出标准：

- 能不查资料手算 3-trit balanced ternary。
- 能解释为什么 `+ +` 在单 trit 加法中会产生进位。

## 阶段 4：单 trit 全加器

目标：实现 balanced ternary 的 full adder。

本阶段阅读链接：

- Fast Ternary Addition: https://homepage.cs.uiowa.edu/~jones/ternary/arith.shtml
  - 必读。重点看 balanced ternary addition 和 full adder 的 sum/carry 关系。
- Standard Ternary Logic: https://homepage.cs.uiowa.edu/~jones/ternary/logic.shtml
  - 辅助看 `SUM`、`TXOR`、`MIN/MAX/NEG`，理解单 trit 局部函数和完整加法的区别。
- Number Representations for Ternary Computers: https://homepage.cs.uiowa.edu/~jones/ternary/numbers.shtml
  - 复习 balanced ternary 的数值解释。

输入：

```text
a, b, cin
```

输出：

```text
sum, cout
```

核心规则：

```text
t = a + b + cin

t = -3 -> sum = 0, cout = -
t = -2 -> sum = +, cout = -
t = -1 -> sum = -, cout = 0
t =  0 -> sum = 0, cout = 0
t = +1 -> sum = +, cout = 0
t = +2 -> sum = -, cout = +
t = +3 -> sum = 0, cout = +
```

建议先用行为模型验证，再映射到底层三值基础门。

产物：

- `trit_full_adder`
- 27 项完整真值表。
- 自动化测试：遍历 `a/b/cin` 的全部组合。

退出标准：

- 27 种输入组合全部正确。
- `cout` 只可能是 `- / 0 / +`。
- `sum + 3*cout` 等于 `a + b + cin`。

## 阶段 5：3-trit 加减法器

目标：用 3 个单 trit full adder 串出最小可用算术单元。

本阶段阅读链接：

- Fast Ternary Addition: https://homepage.cs.uiowa.edu/~jones/ternary/arith.shtml
  - 必读。重点看 ripple/carry 思路；carry-lookahead 先只了解，不实现。
- Number Representations for Ternary Computers: https://homepage.cs.uiowa.edu/~jones/ternary/numbers.shtml
  - 用来校对 `-13` 到 `+13` 的 3-trit 结果解释。
- The Trillium Architecture: https://homepage.cs.uiowa.edu/~jones/ternary/trillium.shtml
  - 辅助看 condition codes，理解加法器结果如何影响状态位。

模块：

| 模块 | 含义 |
| --- | --- |
| `adder3t` | 3-trit ripple-carry adder |
| `neg3t` | 3-trit 按位取反 |
| `sub3t` | `A - B = A + neg(B)` |
| `inc3t` | 3-trit 加 1 |
| `dec3t` | 3-trit 减 1 |

先不要做 carry-lookahead。Jones 的加法材料可以作为后续优化参考，但第一版目标是正确，不是快。

要定义的 flag：

- `zero`：结果是否为 `000`。
- `positive`：结果最高有效 trit 是否为 `+`。
- `negative`：结果最高有效 trit 是否为 `-`。
- `carry_out`：最高位进位。

退出标准：

- 能正确计算 `-13` 到 `+13` 范围内的代表性加减法。
- 对溢出行为有明确策略：先记录 `carry_out`，不要急着做饱和。
- 能通过随机测试或枚举测试。

## 阶段 6：3-trit 简化 ALU

目标：做一个能支撑最小 CPU demo 的 ALU。

本阶段阅读链接：

- Standard Ternary Logic: https://homepage.cs.uiowa.edu/~jones/ternary/logic.shtml
  - 用来定义 `NEG/MIN/MAX/decoder/mux` 等非算术 ALU 操作。
- Fast Ternary Addition: https://homepage.cs.uiowa.edu/~jones/ternary/arith.shtml
  - 用来定义 `ADD/SUB/inc/dec` 的算术行为。
- The Trillium Architecture: https://homepage.cs.uiowa.edu/~jones/ternary/trillium.shtml
  - 重点看 Instructions、Add、Subtract 和 Processor Status Word，借鉴 ALU 操作和 flags。
- [Ternary CPU 5500 ISA 学习笔记](../research/ternary-cpu-5500-isa-study-notes.md)
  - 辅助看 `ADD/SUB/ANY/MIN/MAX/SUM` 的 ISA 层语义。

第一版 ALU 操作：

| 操作 | 含义 |
| --- | --- |
| `PASS_A` | 输出 A |
| `PASS_B` | 输出 B |
| `NEG_A` | 输出 `-A` |
| `ADD` | 输出 `A + B` |
| `SUB` | 输出 `A - B` |
| `MIN` | 逐 trit 取 min |
| `MAX` | 逐 trit 取 max |
| `ZERO` | 输出 `000` |

暂缓：

- 乘法。
- 除法。
- 浮点。
- 多周期复杂运算。
- 大位宽 carry-lookahead。

退出标准：

- ALU 每个 opcode 都有单独测试。
- `ADD/SUB` 和参考模型一致。
- `MIN/MAX/NEG` 和单 trit 基础模块组合结果一致。

## 阶段 7：最小数据通路

目标：把寄存器和 ALU 接起来，形成一个能手动执行操作的数据通路。

本阶段阅读链接：

- The Trillium Architecture: https://homepage.cs.uiowa.edu/~jones/ternary/trillium.shtml
  - 必读。重点看 Registers、Processor Status Word、Instruction Format、Load、Load Immediate、Add、Subtract。
- Ternary Manifesto: https://homepage.cs.uiowa.edu/~jones/ternary/
  - 回看 trybble/tryte/word 的系统级组织思路。
- [Ternary CPU 5500 ISA 学习笔记](../research/ternary-cpu-5500-isa-study-notes.md)
  - 辅助看寄存器、访存、跳转、系统状态如何在更完整 ISA 中出现。

最小结构：

```text
regA ----\
         ALU ---- result ---- regA/regB
regB ----/
```

需要的控制信号：

- `load_a`
- `load_b`
- `alu_op`
- `write_back_sel`
- `write_enable`
- `reset`

先不要急着做完整指令译码。可以先用 testbench 或控制脚本手动拉控制信号。

第一个 demo：

```text
regA <- +0-
regB <- 00+
regA <- regA + regB
检查 regA
```

第二个 demo：

```text
regA <- +--
regB <- 0+0
regA <- regA - regB
检查 regA 和 flags
```

退出标准：

- 至少能跑通两个手动控制的 ALU demo。
- 波形中能清楚看到寄存器写入、ALU 输出、flags 更新。

## 阶段 8：最小体系结构

目标：在基础模块可靠后，再设计最小三进制处理器。

本阶段阅读链接：

- The Trillium Architecture: https://homepage.cs.uiowa.edu/~jones/ternary/trillium.shtml
  - 必读。重点看 9-trit word、instruction format、addressing modes、registers、instructions。
- Ternary Manifesto: https://homepage.cs.uiowa.edu/~jones/ternary/
  - 用来把小型 CPU 放回三进制系统设计的整体背景。
- Number Representations for Ternary Computers: https://homepage.cs.uiowa.edu/~jones/ternary/numbers.shtml
  - 用来校对指令字段、立即数和寄存器数据的数值解释。
- [Ternary CPU 5500 ISA 学习笔记](../research/ternary-cpu-5500-isa-study-notes.md)
  - 只作为长期参考，第一版不追求兼容 5500 ISA。

建议第一版 ISA 不超过 8 条指令：

| 指令 | 含义 |
| --- | --- |
| `NOP` | 空操作 |
| `LDI` | 加载小立即数 |
| `MOV` | 寄存器复制 |
| `ADD` | 加法 |
| `SUB` | 减法 |
| `NEG` | 取反 |
| `JZ` | zero 时跳转 |
| `HALT` | 停机 |

最小处理器组件：

- `PC`
- `IR`
- 2 到 4 个 3-trit 通用寄存器
- 3-trit ALU
- 简单控制 FSM
- 小容量 instruction memory

第一版程序只需要证明：

```text
加载常数
执行加法
判断 zero flag
停机
```

退出标准：

- 能从 instruction memory 取指。
- 能执行至少 3 条不同指令。
- 能运行一个完整小程序并停机。

## 推荐时间表

如果每周能投入 2 到 3 个完整工作日，可以按 8 周推进：

| 周次 | 重点 | 产物 |
| --- | --- | --- |
| 第 1 周 | 三值信号约定、Jones 三值逻辑 | signal convention + 基础真值表 |
| 第 2 周 | 单 trit 基础门 | `buf/neg/min/max/decoder` |
| 第 3 周 | 单 trit 和 3-trit 寄存器 | `trit_dff/reg3t` |
| 第 4 周 | balanced ternary 数值表示 | 3-trit 编码表和参考模型 |
| 第 5 周 | 单 trit full adder | 27 项真值表和测试 |
| 第 6 周 | 3-trit 加减法器 | `adder3t/sub3t/inc3t/dec3t` |
| 第 7 周 | 3-trit ALU | ALU opcode 和 flags |
| 第 8 周 | 最小数据通路 | 两个 ALU demo 波形 |

如果第 8 周跑通，再进入第二阶段：

| 周次 | 重点 | 产物 |
| --- | --- | --- |
| 第 9 周 | 最小 ISA | 指令格式和译码表 |
| 第 10 周 | PC/IR/控制 FSM | 单步取指执行 |
| 第 11 周 | 小程序运行 | 加法/减法/条件跳转 demo |
| 第 12 周 | 总结和优化 | 技术报告、波形、模块库整理 |

## 每周学习模板

每周按同一个节奏做：

1. 读材料。
2. 写真值表。
3. 手算 3 到 5 个例子。
4. 实现一个最小模块。
5. 遍历测试所有输入组合。
6. 保存波形或实验截图。
7. 写一页总结：做对了什么，哪里还不确定。

## 阶段性检查表

基础逻辑检查：

- [ ] `- / 0 / +` 定义固定。
- [ ] 单 trit 输入输出可观测。
- [ ] `neg` 正确。
- [ ] `min/max` 正确。
- [ ] decoder 正确。
- [ ] mux 正确。

寄存器检查：

- [ ] 单 trit DFF 正确。
- [ ] 单 trit enable 正确。
- [ ] 单 trit reset 正确。
- [ ] 3-trit register 正确。
- [ ] 非写入周期能保持。

算术检查：

- [ ] 单 trit full adder 27 项通过。
- [ ] 3-trit adder 通过枚举测试。
- [ ] subtraction 通过。
- [ ] `zero/positive/negative/carry_out` 定义清楚。

ALU 检查：

- [ ] `PASS_A/PASS_B` 正确。
- [ ] `NEG_A` 正确。
- [ ] `ADD/SUB` 正确。
- [ ] `MIN/MAX` 正确。
- [ ] flags 正确。

数据通路检查：

- [ ] regA/regB 可加载。
- [ ] ALU 输出可写回。
- [ ] 控制信号时序清楚。
- [ ] 至少两个 demo 跑通。

## 不要过早做的事情

这些内容可以研究，但不要放进第一版主线：

- 完整 5500 ISA 兼容。
- 27-trit 或更宽字长。
- 高速 carry-lookahead。
- 乘法器和除法器。
- 流水线。
- 中断和异常。
- cache。
- 复杂 ABI。
- 编译器。

第一版的胜利标准很简单：一个 3-trit 寄存器文件加一个简化 ALU，能在波形里稳定执行几步手动控制的数据运算。

## 读 Jones 材料的顺序

推荐顺序如下：

1. `Ternary Manifesto`
   - 只看为什么用 trit、trybble、tryte、word 这些概念。
2. `Standard Ternary Logic`
   - 重点看 `+ / 0 / -`、`neg`、`min`、`max`、decoder。
3. `Number Representations`
   - 理解 balanced ternary 和数值范围。
4. `Fast Ternary Addition`
   - 重点看加法器思想，不要求第一版实现高速加法。
5. `Trillium Architecture`
   - 只借鉴“小体系结构如何组织”，不要照搬。
6. `BCT`
   - 只作为二进制仿真参考，不作为真实三值硬件主线。

## 最终阶段报告建议结构

后续写阶段报告时，可以按下面结构整理：

1. 研究背景：为什么研究三值计算。
2. 器件基础：已有三值/3bit 器件能力。
3. 信号约定：`- / 0 / +` 表示方式。
4. 基础逻辑模块：真值表和实现。
5. 三值寄存器：时序行为。
6. 3-trit 加减法器：full adder 和 ripple adder。
7. 简化 ALU：操作集合和 flags。
8. 最小数据通路：控制信号和 demo。
9. 测试结果：仿真波形或板级实验。
10. 下一步：扩展 ISA、寄存器堆和控制器。

## 当前最优下一步

先完成阶段 0 和阶段 1。

建议下一个文件就写：

```text
docs/learning/trit-signal-convention.md
```

里面只回答一个问题：你们的三值器件到底如何表达、输入、保存、输出 `- / 0 / +`。

这个问题一旦定下来，后面的寄存器、加法器和 ALU 才能避免反复返工。
