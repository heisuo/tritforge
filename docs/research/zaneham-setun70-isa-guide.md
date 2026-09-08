# Zaneham Python 版 Setun70 指令集架构学习文档

> 文档类型：入门教程，偏硬件实现
> 对应项目：[`Zaneham/setun70-emulator`](https://github.com/Zaneham/setun70-emulator)
> 对应提交：`3a5db33669577be65dd4b013e3f79fffab830204`
> 编写日期：2026-07-21

## 1. 这份文档讲什么

这份文档帮助我们学习 Zaneham Python 模拟器中实际实现的三进制指令集架构，并把软件行为逐步对应到后续可能实现的硬件模块。

重点回答以下问题：

1. 一条 6-trit 指令如何编码？
2. 操作数栈 T、S 在每条指令前后如何变化？
3. `ADD/SUB/NEG/CMP` 需要哪些 ALU 模块？
4. `LIT/JMP/CALL/FETCH/STORE` 需要哪些控制状态和存储器接口？
5. 已有 3-trit 器件怎样组合成最小可运行数据通路？
6. Python 模拟器的哪些行为不能直接照搬到硬件？

## 2. 最重要的范围说明

本文描述的是：

> **Zaneham Python 项目定义并实现的简化 ISA。**

它不是原始 Setun-70 的完整历史 ISA，也不是周期精确模型。项目借用了平衡三进制、6-trit syllable、POLIZ 栈机和分页存储等思想，但很多指令和执行细节是教学型简化实现。

阅读时要分清三层：

| 层次 | 本文如何处理 |
|---|---|
| Python 项目实际行为 | 按 `setun70.py` 源码准确记录 |
| 面向硬件的建议 | 单独标成“硬件建议”，不冒充项目原始设计 |
| 历史 Setun-70 | 只说明主要差异，不在本文展开 |

## 3. 先认识平衡三进制

### 3.1 一个 trit 的三个值

项目采用 balanced ternary，即平衡三进制：

| 项目符号 | 本文含义 | 数值 |
|---|---|---:|
| `T` | negative trit | `-1` |
| `0` | zero trit | `0` |
| `1` | positive trit | `+1` |

例如三位平衡三进制数 `1T1` 表示：

```text
1T1 = 1*3^2 + (-1)*3^1 + 1*3^0
    = 9 - 3 + 1
    = 7
```

### 3.2 3-trit 和 6-trit 范围

| 宽度 | 状态数 | 最小值 | 最大值 |
|---:|---:|---:|---:|
| 1 trit | 3 | `-1` | `+1` |
| 3 trit | 27 | `-13` | `+13` |
| 4 trit | 81 | `-40` | `+40` |
| 6 trit | 729 | `-364` | `+364` |

3-trit 数据特别重要，因为我们当前计划先实现 3-trit 寄存器和 ALU。

### 3.3 软件表示和物理器件不是一回事

Python 项目使用普通整数和列表保存 trit。后续硬件中，一个 trit 应由团队已有三值器件实际保存。

如果 SystemVerilog 测试平台暂时使用二进制编码表示 trit，例如：

```text
00 -> 0
01 -> +1
10 -> -1
11 -> 非法
```

这个编码只属于仿真接口，不代表真实三值电路内部仍然是普通二进制逻辑。

## 4. 机器总体结构

Python 模拟器可以先理解成下面这台栈式机器：

```text
                 +------------------+
 PC ------------>| instruction/data |
                 | memory           |
                 +--------+---------+
                          |
                       6-trit
                          |
                 +--------v---------+
                 | instruction      |
                 | decode           |
                 +--------+---------+
                          |
             +------------+-------------+
             |                          |
      +------v-------+           +------v-------+
      | operand      |           | return       |
      | stack T/S    |           | stack        |
      +------+-------+           +--------------+
             |
      +------v-------+
      | arithmetic / |
      | compare      |
      +------+-------+
             |
          write back
```

它是零地址栈机。大多数算术指令不写寄存器编号，而是默认从操作数栈取数。

## 5. Python 模拟器的处理器状态

复位后，`Setun70` 对象包含以下状态：

| 状态 | Python 实现 | 功能 | 硬件对应建议 |
|---|---|---|---|
| `operand_stack` | Python 列表 | 保存数据和中间结果 | T/S 寄存器 + 小型 stack RAM |
| `return_stack` | Python 列表 | 保存子程序返回地址 | 独立 return stack |
| `memory` | `(page,offset)->int` 字典 | 指令和数据共用 | 第一版建议拆成 instruction/data memory |
| `page_registers` | 三个整数 | 将 `-1/0/+1` 映射到实际页号 | 三个页面寄存器，第一版暂缓 |
| `pc_page` | 整数 | 当前指令页 | PC 页字段，第一版可固定为 0 |
| `pc_offset` | 整数 | 当前页内指令位置 | PC offset |
| `comparison_flag` | `-1/0/+1` | 最近一次 `CMP` 结果 | 1-trit compare flag |
| `running` | 布尔量 | 运行/停机状态 | control FSM 的运行状态 |
| `error` | 字符串或空 | 软件错误状态 | illegal/underflow/div0 标志 |

复位值见 `setun70.py:242-264`：

```text
operand_stack = []
return_stack  = []
page_registers = {-1: 0, 0: 1, +1: 2}
PC = (page=0, offset=0)
comparison_flag = 0
running = false
```

## 6. 理解 T、S 和栈效果

### 6.1 T 和 S

本文用以下符号描述操作数栈：

- `T`：栈顶，Top of Stack。
- `S`：次栈顶，Second on Stack。

例如：

```text
operand_stack = [3, 4, 5]
                         ^ T = 5
                      ^ S = 4
```

### 6.2 栈效果记法

指令说明中使用：

```text
(执行前 -- 执行后)
```

例如：

```text
ADD: (a b -- a+b)
```

表示执行前 `b` 是 T、`a` 是 S，执行后两者被一个结果替换。

### 6.3 面向硬件的两级栈顶

第一版硬件不必立即实现无限深栈。可以先做：

```text
+-------------+      +-------------+
| S register  | ---> | T register  | ---> ALU input B
+-------------+      +-------------+
       |                    |
       +------> ALU <--------+
                  |
             result writeback
```

建议先实现：

- `reg_t`：3-trit 栈顶寄存器；
- `reg_s`：3-trit 次栈顶寄存器；
- `stack_depth`：至少能区分 0、1、2 个有效元素；
- 深度超过 2 时，再接小型 stack RAM。

## 7. 6-trit 指令格式

### 7.1 Operation syllable

所有操作指令都是 6 trit：

```text
位置:      k5  k4  k3  k2  k1  k0
内容:       0   0 type  opcode[2:0]
```

也可写成：

```text
[ 00 | type | 3-trit opcode ]
```

前两个 trit 都是 0，表示这是操作指令。

### 7.2 type 字段

| `type` | 类别 | Python 行为 |
|---:|---|---|
| `T` / `-1` | macro | 调用 `execute_macro_op()`，当前等价 NOP |
| `0` | basic | 算术、栈、跳转、访存、停机 |
| `1` / `+1` | service | 立即数和简化 I/O |

### 7.3 opcode 字段

opcode 是 3-trit 有符号数：

```text
TTT = -13
...
000 = 0
...
111 = +13
```

所以每种 type 最多容纳 27 个 opcode。

### 7.4 用两个 3-trit 寄存器保存一条指令

这正好适合团队当前已有的 3-trit 器件：

```text
6-trit IR = IR_HI + IR_LO

IR_HI = [0, 0, type]       # 一个 3-trit 寄存器
IR_LO = [opcode2:opcode0]   # 一个 3-trit 寄存器
```

硬件不需要一开始就研制新的 6-trit 单体寄存器，可以由两个 `reg3t` 组合成 `ir6t`。

## 8. Address syllable

当一条 6-trit syllable 的前两个 trit 不全为 0 时，Python 模拟器把它当作地址引用：

```text
[ length | page_reg | offset(4 trit) ]
```

| 字段 | 宽度 | 代码声明的含义 |
|---|---:|---|
| `length` | 1 trit | 目标数据长度 |
| `page_reg` | 1 trit | 选择三个页面寄存器之一 |
| `offset` | 4 trit | 页内偏移，理论范围 `-40..+40` |

实际执行时：

```text
page = page_registers[page_reg]
value = memory[(page, offset)]
push(value)
```

### 8.1 当前实现的限制

地址 syllable 暂时不适合作为第一版硬件依据：

1. `length` 能被解析，但执行时完全没有使用。
2. `length=0` 且 `page_reg=0` 会与 operation 的 `00` 标志冲突。
3. 汇编器默认 `ADDR label` 使用 `page_reg=+1`，复位后它映射到 page 2，而程序通常装在 page 0。
4. `STORE/FETCH/JMP/CALL` 又使用另一套十进制 `page*100+offset` 地址。

**硬件建议：**第一版先不实现 address syllable。采用线性 instruction memory 和显式 `LOAD/STORE`，等最小 CPU 跑通后再统一地址格式。

## 9. 取指、译码、执行

### 9.1 Python 的单步流程

`step()` 的行为是：

```text
1. memory[PC] -> syllable
2. PC 自增
3. 检查 syllable 前两个 trit
4. operation -> 按 type/opcode 执行
5. address   -> 读取内存并压栈
6. cycles += 1
```

代码位置：`setun70.py:361-388`。

### 9.2 建议的硬件控制 FSM

同步存储器下，不应假设全部指令都能在一个时钟完成。建议使用以下状态：

| 状态 | 主要动作 |
|---|---|
| `RESET` | 清 PC、IR、T/S、SP、flags |
| `FETCH` | instruction memory 地址设为 PC |
| `LATCH_IR` | 存储器输出写入 IR，PC 自增 |
| `DECODE` | 判断 operation/address、type、opcode |
| `EXEC_ALU` | 执行 ADD/SUB/NEG/CMP 等 |
| `FETCH_IMM` | 为 LIT 读取下一 syllable，PC 再自增 |
| `MEM_READ` | 为 FETCH/地址引用等待数据存储器 |
| `MEM_WRITE` | 执行 STORE |
| `BRANCH` | 更新 PC |
| `IO_WAIT` | 等待输入或输出握手 |
| `HALT` | 保持停机状态 |

### 9.3 Python cycle 不等于硬件 cycle

Python 的 `LIT` 在一次 `step()` 中同时读取下一 syllable，只记一个 cycle。单端口同步存储器实现通常至少需要额外一个取立即数周期。

因此：

```text
Python cycles = 模拟器 step 次数
硬件 cycles   = FSM 实际时钟数
```

二者不能直接比较。

## 10. 完整指令编码表

### 10.1 Basic 指令

Basic 指令统一使用：

```text
type = 0
full syllable = 000 + 3-trit opcode
```

| 指令 | 十进制 opcode | 3-trit opcode | 6-trit 编码 |
|---|---:|---|---|
| `HALT` | -8 | `T01` | `000T01` |
| `RET` | -7 | `T1T` | `000T1T` |
| `FETCH` | -6 | `T10` | `000T10` |
| `STORE` | -5 | `T11` | `000T11` |
| `ROT` | -4 | `0TT` | `0000TT` |
| `OVER` | -3 | `0T0` | `0000T0` |
| `ABS` | -2 | `0T1` | `0000T1` |
| `NEG` | -1 | `00T` | `00000T` |
| `NOP` | 0 | `000` | `000000` |
| `ADD` | +1 | `001` | `000001` |
| `SUB` | +2 | `01T` | `00001T` |
| `MUL` | +3 | `010` | `000010` |
| `DIV` | +4 | `011` | `000011` |
| `DUP` | +5 | `1TT` | `0001TT` |
| `DROP` | +6 | `1T0` | `0001T0` |
| `SWAP` | +7 | `1T1` | `0001T1` |
| `CMP` | +8 | `10T` | `00010T` |
| `JMP` | +9 | `100` | `000100` |
| `JZ` | +10 | `101` | `000101` |
| `JN` | +11 | `11T` | `00011T` |
| `JP` | +12 | `110` | `000110` |
| `CALL` | +13 | `111` | `000111` |

### 10.2 Service 指令

Service 指令统一使用 `type=+1`：

| 指令 | 十进制 opcode | 3-trit opcode | 6-trit 编码 |
|---|---:|---|---|
| `LIT` | 0 | `000` | `001000` |
| `OUT` | +1 | `001` | `001001` |
| `IN` | +2 | `01T` | `00101T` |

### 10.3 Macro 指令

Macro 指令格式为：

```text
00Txxx
```

其中 `xxx` 是 3-trit opcode。当前 `execute_macro_op()` 没有实际分派，所有 macro 都等价于 NOP。

## 11. 算术和比较指令

### 11.1 ADD

```text
栈效果：(a b -- a+b)
编码：000001
```

Python 行为：

```text
b = pop()   # T
a = pop()   # S
push(a+b)
```

硬件数据通路：

```text
alu_a = S
alu_b = T
alu_op = ADD
T <- result
S <- 原来 S 下方的下一个栈元素（如果存在）
depth <- depth - 1
```

第一版 3-trit ALU 应定义：

- 结果低 3 trit；
- 最高位 carry_out；
- overflow 策略；
- zero/negative/positive 标志。

### 11.2 SUB

```text
栈效果：(a b -- a-b)
编码：00001T
```

注意顺序：

```text
S - T
```

不是 `T-S`。

硬件可用：

```text
A - B = A + NEG(B)
```

因此 `SUB` 可以复用 `NEG` 和 ripple adder。

### 11.3 NEG

```text
栈效果：(a -- -a)
编码：00000T
```

平衡三进制取负可以逐 trit 完成：

| 输入 | 输出 |
|---:|---:|
| `T` | `1` |
| `0` | `0` |
| `1` | `T` |

`NEG` 不需要进位链，非常适合作为第一批硬件指令。

### 11.4 ABS

```text
栈效果：(a -- abs(a))
编码：0000T1
```

硬件实现可以检查最高有效 trit：

- 负数：执行 `NEG`；
- 零或正数：原样输出。

### 11.5 CMP

```text
栈效果：(a b -- c)
编码：00010T
```

结果：

| 条件 | `c` | comparison_flag |
|---|---:|---:|
| `a < b` | `T` | `T` |
| `a = b` | `0` | `0` |
| `a > b` | `1` | `1` |

Python 版既把结果压栈，也更新 `comparison_flag`。

需要注意：`JZ/JN/JP` 实际检查从栈中弹出的 `cond`，没有读取 `comparison_flag`。如果硬件希望直接按 flag 跳转，需要明确这是 ISA 修改。

### 11.6 MUL 和 DIV

```text
MUL: (a b -- a*b)，编码 000010
DIV: (a b -- trunc(a/b))，编码 000011
```

Python 直接使用整数乘除法。3-trit 第一版硬件建议暂缓：

- 乘法可能产生 6-trit 结果；
- 除法需要多周期控制和除零处理；
- Python 的 `int(a/b)` 定义为向零截断；
- 示例结果 `35/90/120` 都超出 3-trit 范围。

## 12. 栈操作指令

| 指令 | 栈效果 | 编码 | 硬件动作 |
|---|---|---|---|
| `DUP` | `(a -- a a)` | `0001TT` | T 复制一份并 push |
| `DROP` | `(a --)` | `0001T0` | pop T |
| `SWAP` | `(a b -- b a)` | `0001T1` | 交换 S、T |
| `OVER` | `(a b -- a b a)` | `0000T0` | 复制 S 并 push |
| `ROT` | `(a b c -- b c a)` | `0000TT` | 三个栈元素循环移位 |

如果第一版只有 T/S 两个寄存器：

- `DUP/DROP/SWAP` 容易实现；
- `OVER` 需要 push 后仍能保存原 T；
- `ROT` 至少需要第三个元素或 stack RAM。

所以推荐实现顺序是：

```text
DUP -> DROP -> SWAP -> OVER -> ROT
```

## 13. 控制流指令

### 13.1 地址的 Python 临时编码

控制流指令从操作数栈读取一个普通整数地址：

```text
addr = page*100 + offset
page = addr // 100
offset = addr % 100
```

这只是 Python 项目的临时表示，不是三进制硬件地址格式。

### 13.2 指令语义

| 指令 | 栈效果 | 条件 | 编码 |
|---|---|---|---|
| `JMP` | `(addr --)` | 无条件 | `000100` |
| `JZ` | `(cond addr --)` | `cond == 0` | `000101` |
| `JN` | `(cond addr --)` | `cond < 0` | `00011T` |
| `JP` | `(cond addr --)` | `cond > 0` | `000110` |
| `CALL` | `(addr --)` | 保存下一条 PC 后跳转 | `000111` |
| `RET` | `( --)` | 从 return stack 恢复 PC | `000T1T` |

### 13.3 三向分支很适合三进制

一个 3-trit 数的最高非零 trit 天然给出三种情况：

```text
negative / zero / positive
```

因此 `JN/JZ/JP` 可以共享一个三向条件判断模块。

### 13.4 第一版硬件建议

先只实现：

```text
JZ
```

等 zero flag 和 PC 写入稳定后，再加入 `JN/JP/JMP`。`CALL/RET` 需要独立返回栈，最后实现。

## 14. 访存指令

| 指令 | 栈效果 | 编码 | Python 行为 |
|---|---|---|---|
| `FETCH` | `(addr -- value)` | `000T10` | 从字典内存读取 |
| `STORE` | `(value addr --)` | `000T11` | 写入字典内存 |

它们使用的地址也是 `page*100+offset` 普通整数。

**硬件建议：**定义新的明确地址格式，不要实现十进制乘 100：

```text
data_addr = 3-trit 或 4-trit 线性地址
```

第一版最好采用 Harvard 结构：

- instruction memory：只读，保存 6-trit syllable；
- data memory：读写，保存 3-trit data；

这会偏离 Python 的统一字典内存，但能显著简化第一版硬件冲突和控制时序。

## 15. Service 指令

### 15.1 LIT

汇编写法：

```asm
LIT 7
```

会生成两个 6-trit syllable：

```text
001000   # LIT operation
0001T1   # 数值 7 的 6-trit 表示
```

执行时，LIT 读取 PC 指向的下一 syllable，作为普通整数压栈，然后再次增加 PC。

面向 3-trit 数据通路时，可规定：

```text
立即数必须在 -13..+13
6-trit literal 的高 3 trit 必须为 000
低 3 trit 写入 T
```

例如：

```text
-5 = 000T11
          T11 -> 3-trit 数据 -5
```

### 15.2 OUT

```text
栈效果：(value --)
编码：001001
```

Python 会弹出 T 并打印十进制和平衡三进制字符串。

硬件可以先映射成：

- 输出寄存器；
- FPGA LED/数码管接口；
- testbench 中的 `out_valid/out_data` 握手。

要记住：`OUT` 会 pop，输出后栈顶结果不再保留。

### 15.3 IN

```text
栈效果：( -- value)
编码：00101T
```

当前 Python 实现没有真实输入，只会压入 0。

硬件可以映射成拨码开关、输入寄存器或 testbench 接口，但这属于后续扩展。

## 16. HALT、NOP 和错误

### 16.1 NOP

```text
编码：000000
行为：除 PC 正常前进外，不改变状态
```

### 16.2 HALT

```text
编码：000T01
行为：running <- false
```

硬件控制器进入 `HALT` 状态，并保持 PC、T/S 和输出稳定，直到 reset。

### 16.3 Python 错误行为不应直接照搬

Python 的 `pop()` 在栈空时：

```text
error = "Stack underflow"
running = false
return 0
```

但当前指令仍可能继续执行剩余 Python 语句。硬件应在执行前检查栈深度：

```text
need_1_operand && depth < 1 -> TRAP/HALT
need_2_operand && depth < 2 -> TRAP/HALT
```

不要用“缺操作数时自动补 0”作为正常硬件语义。

## 17. 汇编器语法

### 17.1 注释

分号后内容是注释：

```asm
LIT 3      ; push value 3
```

### 17.2 LIT 和 PUSH

```asm
LIT 5
PUSH 5
```

两者都会生成“LIT operation + literal”两个 syllable。

### 17.3 标签

汇编器采用两遍扫描：

1. 第一遍统计标签地址；
2. 第二遍生成 syllable。

`LIT` 占两个 syllable，其他普通指令占一个。

示例：

```asm
start:
    LIT 1
    LIT end
    JMP
end:
    HALT
```

标签值是从 0 开始的线性 syllable offset。

### 17.4 ADDR

支持：

```asm
ADDR offset
ADDR page_reg offset
ADDR label
```

但因为前述页寄存器和编码冲突问题，第一版硬件和学习程序不建议使用它。

### 17.5 .WORD

```asm
.WORD 7
```

生成一个数值 syllable。其他未知伪指令会静默生成 0，使用时需要小心。

## 18. 一个适合 3-trit 硬件的程序

仓库原示例使用 `35/90/120`，不适合 3-trit 数据范围。先使用：

```text
3 + 4 = 7
```

汇编程序：

```asm
    LIT 3
    LIT 4
    ADD
    OUT
    HALT
```

### 18.1 汇编结果

| syllable 地址 | 内容 | 含义 |
|---:|---|---|
| 0 | `001000` | LIT |
| 1 | `000010` | literal 3 |
| 2 | `001000` | LIT |
| 3 | `000011` | literal 4 |
| 4 | `000001` | ADD |
| 5 | `001001` | OUT |
| 6 | `000T01` | HALT |

注意：地址 1 的 `000010` 如果被正常译码会是 MUL，但在 LIT 状态中它是数据，不经过普通指令译码。

### 18.2 栈变化

| 执行指令 | 执行前 | 执行后 | PC 变化 |
|---|---|---|---|
| `LIT 3` | `[]` | `[3]` | `0 -> 2` |
| `LIT 4` | `[3]` | `[3,4]` | `2 -> 4` |
| `ADD` | `[3,4]` | `[7]` | `4 -> 5` |
| `OUT` | `[7]` | `[]` | `5 -> 6` |
| `HALT` | `[]` | `[]` | `6 -> 7` |

Python 模拟器将它计为 5 个 cycle，因为两条 literal syllable 不单独计 step。

已在文档对应提交上实际运行验证：输出为 `7`，`completed=True`，`error=None`，共计 5 个 Python cycle。

### 18.3 对应硬件操作

```text
LIT 3:  T <- 3, depth <- 1
LIT 4:  S <- T, T <- 4, depth <- 2
ADD:    T <- S + T, depth <- 1
OUT:    out_data <- T, out_valid <- 1, depth <- 0
HALT:   state <- HALT
```

## 19. 推荐的最小硬件架构

### 19.1 第一版目标

第一版不是复制整个 Python 模拟器，而是运行上一节的小程序。

建议参数：

| 项目 | 第一版建议 |
|---|---|
| 数据宽度 | 3 trit |
| 指令宽度 | 6 trit，由两个 `reg3t` 组成 |
| 栈 | T/S 两个 3-trit 寄存器，先支持深度 0..2 |
| ALU | ADD、SUB、NEG、PASS、CMP |
| 指令存储器 | 至少 8 个 6-trit syllable |
| 数据存储器 | 暂不实现 |
| 分支 | 暂不实现或只实现 JZ |
| I/O | `out_valid + out_data` |

### 19.2 建议模块

| 模块 | 责任 |
|---|---|
| `trit_pkg/reference` | 仿真编码、转换和合法性检查 |
| `trit_reg` | 保存一个 trit |
| `reg3t` | 保存一个 3-trit 数据字 |
| `ir6t` | 两个 `reg3t` 组合成 6-trit IR |
| `trit_full_adder` | 单 trit 加法和 carry |
| `adder3t` | 3 级 ripple-carry adder |
| `alu3t` | ADD/SUB/NEG/PASS/CMP |
| `stack_top2_3t` | T/S、depth、push/pop/swap |
| `isa_decoder` | 解析 marker/type/opcode |
| `control_fsm` | FETCH/DECODE/EXEC/HALT |
| `instruction_memory` | 保存 6-trit 程序 |
| `ternary_cpu_min` | 顶层连接和 I/O |

### 19.3 建议控制信号

| 控制信号 | 含义 |
|---|---|
| `ir_write_en` | IR 写使能 |
| `pc_inc` | PC 自增 |
| `pc_load` | 分支写 PC |
| `stack_push` | 压栈 |
| `stack_pop1` | 弹出一个元素 |
| `stack_pop2_push1` | 二元 ALU 写回 |
| `stack_swap` | 交换 T/S |
| `alu_op` | 选择 ADD/SUB/NEG/CMP 等 |
| `imm_select` | 选择下一 syllable 立即数 |
| `out_write` | 输出寄存器写使能 |
| `halt_set` | 进入停机状态 |

### 19.4 SystemVerilog 结构建议

后续编写 RTL 时：

- 寄存器、PC、IR、状态机使用 `always_ff`；
- ALU、译码器、next-state 使用 `always_comb`；
- 时序逻辑使用非阻塞赋值 `<=`；
- 组合逻辑使用阻塞赋值 `=`；
- `always_comb` 先给所有输出默认值，避免锁存器；
- 非法 trit、非法 opcode、栈上下溢应进入明确错误状态。

本文暂不直接给 RTL，以免在三值器件接口尚未完全确定时固定错误编码。

## 20. 指令实现优先级

### 阶段 H0：跑通第一条程序

| 指令 | 原因 |
|---|---|
| `LIT` | 向数据通路送入常数 |
| `ADD` | 验证 3-trit adder |
| `OUT` | 观察结果 |
| `HALT` | 程序正常结束 |

### 阶段 H1：形成最小 ALU 和栈

| 指令 | 原因 |
|---|---|
| `SUB` | 验证 NEG + ADD 复用 |
| `NEG` | 最简单的三值一元运算 |
| `DUP` | 支持重复使用栈顶 |
| `DROP` | 基础栈管理 |
| `SWAP` | 调整二元运算顺序 |
| `CMP` | 产生 `T/0/1` 三向结果 |
| `NOP` | 调试和填充 |

### 阶段 H2：加入控制流

```text
JZ -> JN/JP -> JMP -> CALL/RET
```

### 阶段 H3：加入存储器

```text
FETCH -> STORE -> 统一地址格式 -> address syllable
```

### 阶段 H4：复杂运算

```text
ABS -> OVER/ROT -> MUL -> DIV -> macro/service 扩展
```

## 21. 必须先做出的硬件决策

开始写 CPU RTL 前，团队需要明确：

1. 一个物理 trit 的端口和测试接口怎样表示？
2. 第一版数据字是 3 trit 还是 6 trit？
3. ADD/SUB 超出 `-13..+13` 时怎样处理？
4. carry_out 是否写入状态寄存器？
5. T/S 栈只有两级，还是立即增加 stack RAM？
6. PC 使用普通二进制测试计数器，还是物理三值寄存器？
7. 6-trit IR 是否确定由两个 3-trit 寄存器组成？
8. instruction memory 的物理接口是什么？
9. `OUT` 是简单寄存器还是 valid/ready 握手？
10. 非法指令和栈下溢进入 HALT 还是 TRAP？

### 21.1 PC 宽度问题

Python 每页有 81 个 syllable，因此完整页内 offset 至少需要 4 trit。一个 3-trit PC 只有 27 个状态。

第一版可以选择：

| 方案 | 优点 | 代价 |
|---|---|---|
| 3-trit PC，最多 27 个 syllable | 符合当前基础模块 | 不兼容 Python 的 81 项页面 |
| 4-trit PC | 能覆盖完整一页 | 需要新的 4-trit 寄存器组合 |
| 两个 3-trit 寄存器组成更宽 PC | 复用现有模块 | 需要定义未使用高位和地址映射 |

推荐第一版使用 3-trit PC 和不超过 27 个 syllable 的程序，并把“完整 81 项页面”留到扩展阶段。

还要注意，平衡三进制 3-trit 数值解释是 `-13..+13`，而线性存储器下标通常是 `0..26`。若要用满 27 个位置，必须明确地址映射，例如：

```text
memory_index = pc_value + 13
```

采用这种偏置映射时，复位后的 `pc_value` 应为 `-13`，对应线性地址 0。也可以把 PC 当作 27 状态的模计数器，再单独由地址转换模块生成无符号存储器下标。

若 H0 阶段希望让 `pc_value` 直接等于程序地址，可以暂时只使用非负状态 `0..13`；本例只访问 `0..6`，足够跑通。无论选哪种方式，都必须在 PC 和 instruction memory 的接口定义中写清楚，不能一边按有符号数解释、一边按无符号下标寻址。

## 22. 验证计划

### 22.1 单 trit 模块

- NEG：3 组输入全部测试；
- full adder：`a/b/carry_in` 共 `3^3=27` 组全部测试；
- mux/decoder：所有选择值和非法输入测试。

### 22.2 3-trit 模块

- 3-trit 数值 `-13..+13` 全部转换测试；
- ADD：`27*27=729` 组输入全枚举；
- SUB：729 组输入全枚举；
- NEG：27 组输入；
- CMP：729 组输入；
- overflow/carry 与预先定义一致。

### 22.3 指令级

每条指令至少验证：

- IR 编码；
- 译码结果；
- 执行前后 T/S/depth；
- PC 变化；
- flags；
- 错误条件。

### 22.4 程序级

第一批程序：

```text
P1: 3 + 4 = 7
P2: 5 - 7 = -2
P3: NEG(-5) = 5
P4: CMP(4,4) = 0
P5: 故意空栈 ADD，检查 underflow
P6: 产生最高位 carry，检查 overflow 规则
```

### 22.5 不要直接用 Python 结果验证溢出

Python 使用无界整数，硬件使用固定 3 trit。正常范围内可以比较数值，超出范围时必须由我们自己的严格 golden model 判断。

## 23. Python 项目中需要警惕的地方

### 23.1 无界整数

ADD/MUL 等结果不限制在 3 trit 或 6 trit，不能直接代表硬件溢出。

### 23.2 `int_to_trits()` 静默截断

超过 6-trit 范围时不会报错，例如：

```text
365 -> TTTTTT -> -364
```

### 23.3 比较 flag 与跳转脱节

`CMP` 更新 `comparison_flag`，但条件跳转从栈中另取 `cond`。硬件必须决定保留哪一种语义。

### 23.4 OUT 会弹栈

打印后结果不再位于 T。原项目 demo 中因此出现 `5! = ERROR`，但最后仍打印全部 demo 成功。

### 23.5 IN 只是占位

当前固定压入 0，没有真实设备协议。

### 23.6 Macro 未实现

所有 macro 都静默当作 NOP。

### 23.7 Address length 未实现

代码能够解析 `length`，却始终只读取一个整数。

### 23.8 地址格式不统一

- address syllable：`page_reg + 4-trit offset`；
- JMP/CALL/FETCH/STORE：十进制 `page*100+offset`。

硬件必须重新统一。

### 23.9 没有自动化测试

仓库配置了 pytest，但没有 `tests/`。后续不能仅因为示例程序能运行，就认为所有指令正确。

## 24. 与真实 Setun-70 的主要区别

Zaneham Python 版保留了以下高层思想：

- 平衡三进制；
- 6-trit syllable；
- operation/address 两类 syllable；
- POLIZ 栈式执行；
- 分页和三个页寄存器。

但它简化或改变了：

- 真实机的 18-trit 栈 word；
- 完整的 27 basic、27 service 和 macro 系统；
- ROM/RAM、外存和 I/O；
- 中断和上下文；
- 指令的精确历史语义。

因此本文的硬件建议是“从这个 Python ISA 提炼最小教学 CPU”，不是“复刻历史 Setun-70”。

## 25. 推荐学习顺序

### 第一次阅读

只看：

1. 第 3 节：平衡三进制；
2. 第 6 节：T/S 和栈效果；
3. 第 7 节：6-trit 指令格式；
4. 第 11、12 节：算术和栈操作；
5. 第 18 节：`3+4` 程序。

目标：能手工跟踪栈。

### 第二次阅读

看：

1. 第 9 节：取指译码执行；
2. 第 13、14、15 节：控制流、访存和 service；
3. 第 19 节：最小硬件架构。

目标：能画出数据通路和控制信号。

### 第三次阅读

看：

1. 第 20 节：实现优先级；
2. 第 21 节：必须决策的问题；
3. 第 22 节：验证计划；
4. 第 23 节：软件陷阱。

目标：开始编写模块规格和测试。

## 26. 自测题

### 题 1

`00001T` 是什么指令？

答案：前两 trit 是 `00`，type=`0`，opcode=`01T=2`，所以是 `SUB`。

### 题 2

执行前栈为 `[5,2]`，执行 SUB 后是什么？

答案：`S-T=5-2=3`，栈变为 `[3]`。

### 题 3

`001000 0001T1` 表示什么？

答案：`001000` 是 LIT，下一 syllable `0001T1` 作为数值 7，不作为 `SWAP` 指令译码。

### 题 4

为什么 3-trit 第一版不适合运行 `(3+4)*5`？

答案：结果 35 超过 3-trit 的 `-13..+13`，而且 MUL 尚未进入第一阶段硬件。

### 题 5

CMP 后能否直接执行 JZ 检查 `comparison_flag`？

答案：按当前 Python 代码不能。JZ 从操作数栈弹出 `cond` 和 `addr`，不读取 flag。若硬件直接读 flag，必须记录为 ISA 修改。

## 27. 第一版硬件完成标准

满足以下条件，才算真正跑通：

- [ ] 单 trit full adder 27 组输入全部正确；
- [ ] 3-trit ADD/SUB 枚举测试通过；
- [ ] `reg3t` 能复位、写入和保持；
- [ ] `ir6t` 能保存并拆分 type/opcode；
- [ ] decoder 正确识别 LIT/ADD/OUT/HALT；
- [ ] T/S 栈深度变化正确；
- [ ] 控制 FSM 能从 instruction memory 连续取指；
- [ ] `3+4=7` 程序输出正确；
- [ ] HALT 后状态保持不变；
- [ ] 空栈、非法 opcode 和溢出行为有明确测试结果。

## 28. 术语表

| 术语 | 含义 |
|---|---|
| trit | 一个三值位，取 `-1/0/+1` |
| balanced ternary | 平衡三进制 |
| syllable | 本项目的 6-trit 指令/数据单元 |
| POLIZ | 逆波兰式、后缀表达式执行方式 |
| T | operand stack 栈顶 |
| S | operand stack 次栈顶 |
| operand stack | 数据和中间结果栈 |
| return stack | 子程序返回地址栈 |
| opcode | 指令操作码 |
| service | 立即数和 I/O 类操作 |
| macro | 用户宏操作，当前 Python 版未实现 |
| FSM | 控制有限状态机 |
| golden model | 用于验证 RTL 数值/行为的参考模型 |

## 29. 本地源码索引

| 内容 | 文件位置 |
|---|---|
| trit 转换 | `setun70-emulator/setun70.py:37-98` |
| syllable 编码 | `setun70-emulator/setun70.py:105-176` |
| opcode 常量 | `setun70-emulator/setun70.py:183-214` |
| 处理器状态 | `setun70-emulator/setun70.py:221-264` |
| 取指执行 | `setun70-emulator/setun70.py:361-406` |
| basic 指令 | `setun70-emulator/setun70.py:408-535` |
| service/macro | `setun70-emulator/setun70.py:537-562` |
| 汇编器 | `setun70-emulator/setun70.py:602-745` |
| 示例程序 | `setun70-emulator/examples/` |
| 项目分析报告 | `Setun70_Emulator项目分析报告.md` |
| 总学习规划 | `ternary_learning_plan.md` |

## 30. 最后记住三句话

1. Zaneham Python 版适合学习栈机和指令组织，不是历史 Setun-70 的完整复刻。
2. 6-trit 指令可以由两个 3-trit 寄存器组成，但数据通路应先从 3 trit 跑通。
3. 第一版只需 `LIT + ADD + OUT + HALT`，先让真实寄存器、ALU 和控制 FSM 连续工作，再扩展指令。
