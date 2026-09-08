# Ternary CPU 5500 ISA 学习笔记

## 1. 文档来源
参考材料如下：

- ISA 页面：[索引页](https://www.ternary-computing.com/docs/assembly/ISA/doc_index.html)、[指令列表页](https://www.ternary-computing.com/docs/assembly/ISA/isa.php)、[指令详情页](https://www.ternary-computing.com/docs/assembly/ISA/isa.php?view=Detail)
- 架构说明文档：[指令格式说明](https://www.ternary-computing.com/docs/assembly/ISA/Documentation/Format.pdf)、[数据对齐说明](https://www.ternary-computing.com/docs/assembly/ISA/Documentation/Data%20Alignment%205500.pdf)、[CPU ID 指令说明](https://www.ternary-computing.com/docs/assembly/ISA/Documentation/CPU_ID%205500%20instruction.pdf)、[同步指令说明](https://www.ternary-computing.com/docs/assembly/ISA/Documentation/Synchronization%20instructions.pdf)
- 硬件相关文档：[5500FP 复位状态说明](https://www.ternary-computing.com/docs/assembly/ISA/Documentation/Reset%20state%205500FP.pdf)、[5500FP 引脚定义说明](https://www.ternary-computing.com/docs/assembly/ISA/Documentation/PINOUT_5500FP.pdf)

## 2. 基本规格与指令格式
来源：[指令格式说明](https://www.ternary-computing.com/docs/assembly/ISA/Documentation/Format.pdf)、[ISA 指令列表页](https://www.ternary-computing.com/docs/assembly/ISA/isa.php)、[ISA 指令详情页](https://www.ternary-computing.com/docs/assembly/ISA/isa.php?view=Detail)、[5500FP 引脚定义说明](https://www.ternary-computing.com/docs/assembly/ISA/Documentation/PINOUT_5500FP.pdf)

基础规格如下：

- 处理器型号为 `5500FP`
- ISA 版本为 `1.1`
- 每条指令固定为 `4 trytes`
- 指令地址按 `4` 对齐
- 数据总线宽度为 `24 trits`
- 地址总线宽度为 `22 trits`
- ISA 区分 `User Mode` 与 `Kernel Mode`


该 ISA 固定使用 `24-trit` 指令宽度，并根据用途划分出 `A/B/C/D/E/F/J/J2/J3/J4` 几种格式。编码规则较为整齐，便于从格式层面分析寄存器字段和立即数字段的分配方式。

| 格式 | 字段特征 |
| --- | --- |
| `A` | `OpCode + Rs4 + Rs3 + Rs2 + Rs1 + Rd` |
| `B` | `OpCode + Rs3 + Rs2 + Rs1 + Rd` |
| `C` | `OpCode + Rs2 + Rs1 + Rd` |
| `D` | `OpCode + Rs1 + Rd` |
| `E` | `OpCode + Rd` |
| `F` | 仅保留 `OpCode` |
| `J` | `OpCode + Immediate 20` |
| `J2` | `OpCode + Immediate 12 + Rs1 + Rd` |
| `J3` | `OpCode + Immediate 12 + Rs1 + Imm4` |
| `J4` | `OpCode + Immediate 16 + Rd` |

其中，`ADDI` 详情页给出的立即数范围是 `-265720` 到 `265720`，表明 `12-trit` 立即数字段已经可以覆盖一段较宽的常数区间。

指令格式原图请查看[官方《指令格式说明》PDF](https://www.ternary-computing.com/docs/assembly/ISA/Documentation/Format.pdf)。

平衡三进制计算背景如下：

- 单个 trit 的三种取值 `- / 0 / +`，分别对应 `-1 / 0 / +1`
- 一个寄存器里的数值，本质上是按 `3` 的幂次展开
- 如果某个 trit 串写成 `a2 a1 a0`，则其数值表示为 `a2×3^2 + a1×3^1 + a0×3^0`

`+0-` 的数值表示为：

```text
+0- = (+1)×3^2 + 0×3^1 + (-1)×3^0 = 9 - 1 = 8
```

平衡三进制加法的关键在于“每一位最后都要重新归一化回 `- / 0 / +`”。如果某一位的中间结果超出这个范围，就要把它改写成“当前位结果 + 向高位的进位”。因此：

- `(+1) + (+1) = 2`，但 `2` 不能直接作为单个 trit 保存，所以要改写成 `2 = (-1) + 3×(+1)`；也就是说，当前位写成 `-`，同时向高位产生一个 `+` 进位
- `(-1) + (-1) = -2`，但 `-2` 也不能直接作为单个 trit 保存，所以要改写成 `-2 = (+1) - 3×(+1)`；也就是说，当前位写成 `+`，同时向高位产生一个 `-` 进位

后面看 `ADD`、`ADDI`、`SUM` 这几条指令时，基本都离不开这个归一化过程。

结合详情页示例，可将“格式”和“汇编写法”对应如下：

| 格式 | 常见写法 | 代表指令 | 阅读要点 |
| --- | --- | --- | --- |
| `C` | `OP Rd,Rs2,Rs1` | `ADD`、`ANY`、`TXOR` | 目的寄存器在前，后面跟两个源寄存器 |
| `J2` | `OP Rd,Rs1,#Imm12` | `ADDI`、`ANYI` | 也是目的寄存器在前，只是最后一个操作数换成 12-trit 立即数 |
| `E` | `OP Rn` | `JR`、`CID`、`LDSP`、`STSP` | 单寄存器指令，通常作用于一个显式寄存器或一个隐式系统对象 |
| `J` | `OP label` | `JMP`、`JSR` | 目标由长立即数字段给出，常用于跳转和子程序调用 |

详情页示例显示，汇编写法多数采用“目的在前，来源在后”的顺序。

## 3. 关键指令学习笔记
来源：[ISA 指令详情页](https://www.ternary-computing.com/docs/assembly/ISA/isa.php?view=Detail)

### 3.1 算术类

这一组的核心差别有两点。第一，`ADD` / `SUB` 处理的是完整的 `24-trit` 数值，而不是单个 trit 的局部逻辑。第二，带 `S` 的版本采用饱和算术，结果超出可表示范围时直接钳位，不发生回绕。

可直接确认的写法和最小例子如下：

| 指令 | 结构 | 最小例子 | 计算含义 |
| --- | --- | --- | --- |
| `ADD` | `ADD Rd,Rs2,Rs1` | `ADD R3,R2,R1`；若 `R2=8`、`R1=5`，则 `R3=13` | 对两个寄存器做完整多 trit 加法 |
| `ADDI` | `ADDI Rd,Rs1,#Imm12` | `ADDI R3,R2,#23`；若 `R2=8`，则 `R3=31` | 把 `12-trit` 立即数并入完整加法 |
| `SUB` | `SUB Rd,Rs2,Rs1` | 若 `R2=8`、`R1=5`，执行后 `R3=3` | 以平衡三进制方式做完整减法 |
| `SUBI` | `SUBI Rd,Rs1,#Imm12` | 若 `R2=8`，执行 `SUBI R3,R2,#5` 后 `R3=3` | 把立即数作为减数 |
| `INC` | `INC Rn` | `INC R5`；若 `R5=8`，则执行后 `R5=9` | 单寄存器自增 1 |
| `DEC` | `DEC Rn` | `DEC R5`；若 `R5=8`，则执行后 `R5=7` | 单寄存器自减 1 |
| `ADDS` | `ADDS Rd,Rs2,Rs1` | 若 `R2` 已是最大可表示值，`R1=1`，执行后 `R3` 仍保持最大值 | 饱和加法 |
| `ADDSI` | `ADDSI Rd,Rs1,#Imm12` | 若 `R2` 距上界仅差 `2`，执行 `ADDSI R3,R2,#5` 后结果钳位到上界 | 立即数饱和加法 |
| `SUBS` | `SUBS Rd,Rs2,Rs1` | 若 `R2` 已是最小可表示值，`R1=1`，执行后 `R3` 仍保持最小值 | 饱和减法 |
| `SUBSI` | `SUBSI Rd,Rs1,#Imm12` | 若 `R2` 距下界仅差 `2`，执行 `SUBSI R3,R2,#5` 后结果钳位到下界 | 立即数饱和减法 |

需要单独说明的是 `MUL` 和 `DIV`。这两条是 `B` 格式，说明它们涉及的字段比普通三寄存器算术更多；但详情页只给出短标题，没有给出完整操作数模板，因此目前只宜写它们的数值语义，不宜把汇编骨架写死。

| 指令 | 已确认信息 | 数值例子 |
| --- | --- | --- |
| `MUL` | `B` 格式，短描述为 `Multiplication` | 若参与运算的两个值为 `4` 和 `5`，则乘法结果应为 `20` |
| `DIV` | `B` 格式，短描述为 `Division` | 若被除数为 `15`、除数为 `3`，则主结果应为 `5` |

其中 `ADD` 的内部过程最值得单独说明。它并不是“先把寄存器整体转成十进制再相加”，而是先做逐位求和，再把超出 `- / 0 / +` 范围的中间结果重新改写成“当前位结果 + 向高位进位”。

最简单的一位进位如下：

```text
(+1) + (+1) = 2
2 不能直接留在一个 trit 中
因此改写为 2 = (-1) + 3×(+1)
于是当前位写成 - ，同时向高位进 +
```

因此，`ADD` / `ADDI` 的本质是“逐位相加 + 逐位归一化 + 逐位传递进位”，而 `SUM` 不属于这一类。

### 3.2 三值原生函数

这组指令和算术类不同，它们不是把整个寄存器当作一个大数统一处理，而是把两个输入寄存器按位拆开，对每一对 trit 分别查真值表，再把结果重新拼成一个寄存器值。因此，看懂这组指令，关键不在十进制换算，而在“单个 trit 输入什么、输出什么”。

目前可以直接展开的核心指令如下：

| 指令 | 结构 | 最小例子 | 按 trit 的理解 |
| --- | --- | --- | --- |
| `ANY` | `ANY Rd,Rs2,Rs1` | `ANY R8,R0,R5` | `ANY(0,x)=x`，因此可用 `R0` 完成寄存器复制 |
| `ANYI` | `ANYI Rd,Rs1,#Imm12` | `ANYI R22,R0,#65` | 把立即数按 trit 拼成常量后写入寄存器 |
| `EQUAL` | `EQUAL Rd,Rs2,Rs1` | 若某一位上 `Rs2=+`、`Rs1=+`，则结果位为 `+`；若 `Rs2=+`、`Rs1=-`，则结果位为 `-` | 逐 trit 判断是否相同 |
| `TXOR` | `TXOR Rd,Rs2,Rs1` | 若某一位上 `Rs2=+`、`Rs1=-`，则结果位为 `+`；若 `Rs2=+`、`Rs1=+`，则结果位为 `-` | ternary XOR，不等同于二进制 XOR |
| `MAX` | `MAX Rd,Rs2,Rs1` | 若某一位上 `Rs2=-`、`Rs1=0`，则结果位取 `0` | 逐 trit 取较大者 |
| `MIN` | `MIN Rd,Rs2,Rs1` | 若某一位上 `Rs2=+`、`Rs1=0`，则结果位取 `0` | 逐 trit 取较小者 |
| `SUM` | `SUM Rd,Rs2,Rs1` | 若某一位上 `Rs2=+`、`Rs1=+`，则结果位变成 `-` | 只保留本位结果，不向高位传递进位 |
| `CONS` | `CONS Rd,Rs2,Rs1` | 按真值表，若某一位上两个输入都为 `+`，则结果仍为 `+`；若输入互相冲突，则结果会退向中间状态 | 逐 trit 求“共识”结果 |

这一组最容易和算术类混淆的是 `SUM`。例如在某一位上，`(+1)+(+1)=2`，完整加法会把这个 `2` 继续拆成“当前位 `-`、向高位进 `+`”；而 `SUM` 只保留“当前位 `-`”这一部分，不会继续生成跨位进位。因此：

- `ADD` 关心的是整个 `24-trit` 数如何加法进位
- `SUM` 关心的是单个 trit 位置在真值表里的输出

其余一元变换类指令目前也能确认结构，但公开材料没有给出像 `ADD`、`ANY` 那样完整的程序例子，因此这里先记录“怎么写”和“属于哪一类变换”，不把它们过度展开成尚未验证的代数规则。

| 指令族 | 结构 | 可确认的最小例子 | 备注 |
| --- | --- | --- | --- |
| `CLD`、`CLU` | `OP Rd,Rs1` | `CLD R10,R1`、`CLU R10,R1` | `D` 格式，一元 trit 压缩类变换 |
| `ENTI`、`NTI`、`PTI`、`EPTI` | `OP Rd,Rs1` | 官方唯一直接示例是 `ENTI R10,R1` | 一元 inverter/decoder 类变换 |
| `ROD`、`ROU`、`SHD`、`SHU` | `OP Rd,Rs1` | `ROD R10,R1`、`SHU R10,R1` | 一元 trit 重映射类变换 |
| `SWN`、`SWP` | `OP Rd,Rs1` | `SWN R10,R1`、`SWP R10,R1` | 一元 trit 交换类变换 |

### 3.3 真值表
来源：[ISA 指令详情页](https://www.ternary-computing.com/docs/assembly/ISA/isa.php?view=Detail)

下面列出几种关键 ternary 原生函数的真值表。

**ANY**

原始真值表见[官方 ISA 指令详情页](https://www.ternary-computing.com/docs/assembly/ISA/isa.php?view=Detail)。

**EQUAL**

原始真值表见[官方 ISA 指令详情页](https://www.ternary-computing.com/docs/assembly/ISA/isa.php?view=Detail)。

**TXOR**

原始真值表见[官方 ISA 指令详情页](https://www.ternary-computing.com/docs/assembly/ISA/isa.php?view=Detail)。

**SUM**

原始真值表见[官方 ISA 指令详情页](https://www.ternary-computing.com/docs/assembly/ISA/isa.php?view=Detail)。

真值表显示，`SUM` 与 `TXOR` 在 ternary 逻辑中并不等价。

按真值表可归纳出以下关系：

- `EQUAL` 很直接，相同输出 `+`，不同输出 `-`
- `ANY` 中，`0` 这一行会把另一个输入原样放出，因此可用于寄存器复制
- `SUM` 可以看成“只保留本位结果，不向更高位传递进位”的单 trit 加法
- `TXOR` 则表现为“对非零符号做比较”的三值逻辑，而不是完整加法

因此，虽然 `SUM` 和 `ADD` 都带有“加”的意味，但两者背后的计算层次并不一样：

- `SUM` 是逐 trit 的局部规则
- `ADD` 是把整串 trit 当作一个数，连同进位一起做完整加法

### 3.4 跳转与过程调用

这一组最重要的是把“跳到哪里”和“返回到哪里”区分开。`JMP` 只改 `PC`，`JSR` 则在改 `PC` 之前先把返回地址保存到 `R26`，因此可用于过程调用。

| 指令 | 结构 | 最小例子 | 执行含义 |
| --- | --- | --- | --- |
| `JMP` | `JMP label` | `JMP exit` | 直接把 `PC` 改成目标标签地址 |
| `JSR` | `JSR label` | `JSR myRoutine` | 先把下一条指令地址写入 `R26`，再跳到子程序 |
| `JR` | `JR Rn` | `JR R26` | 把寄存器内容当作新 `PC`，因此常用于返回 |
| `JEQ` / `JNE` | `OP Rx,Ry,label` | 官方给出的代表例子是 `JNE R65,R3,pippo` | 先比较两个寄存器，再决定是否跳转 |
| `JEQI` / `JNEI` / `JBI` / `JBEI` | immediate 版本 | 一个比较操作数改成立即数字段 | 适合把寄存器与小常量直接比较 |
| `JB` / `JBE` | `OP Rx,Ry,label` | 例如可用于比较两个索引或边界值 | 按平衡三进制顺序做“小于 / 小于等于”判断 |

最基本的调用框架如下：

```asm
JSR myRoutine
JMP exit

myRoutine:
JR R26
```

若把它写成执行步骤，可以分成三步：

1. `JSR myRoutine` 取出“下一条指令地址”
2. 把这个地址写入 `R26`
3. 把 `PC` 改成 `myRoutine`

子程序末尾执行 `JR R26` 时，又把 `R26` 里的地址送回 `PC`。因此，`R26` 在这套 ISA 中就是显式可见的返回地址寄存器。

### 3.5 访存、地址与栈

这一组要分成两层理解。一层是普通访存，程序显式给出“寄存器 + 偏移”；另一层是栈操作，程序只给出寄存器，真正的地址由隐式栈指针决定。

| 指令 | 结构 | 最小例子 | 执行含义 |
| --- | --- | --- | --- |
| `LD.W` | 按 `J2` 格式推导为 `LD.W Rd,Rs1,#Off` | 若 `R20=1000`，执行 `LD.W R3,R20,#4` 后，`R3` 取自地址 `1004` 处的 word | 典型“基址 + 偏移”取数 |
| `ST.W` | 按 `J2` 格式推导为 `ST.W Rd,Rs1,#Off` | 若 `R20=1000`、`R3=25`，执行 `ST.W R3,R20,#4` 后，地址 `1004` 处被写成 `25` | 典型“基址 + 偏移”存数 |
| `LD.S` / `LD.T` | `J2` 格式 | 与 `LD.W` 相同，只是访问粒度改为 short / tryte | 读不同宽度的数据 |
| `ST.S` / `ST.T` | `J2` 格式 | 与 `ST.W` 相同，只是写入粒度改为 short / tryte | 写不同宽度的数据 |
| `LEA` | `J4` 格式 | 若标签 `myData` 的地址为 `4096`，则执行 `LEA R20,myData` 后，`R20=4096` | 不访存，只形成地址 |
| `PUSH.W` | `PUSH.W Rn` | 若当前 `SP` 已设置好，执行 `PUSH.W R5` 可把 `R5` 压入栈 | 围绕隐式 `SP` 完成压栈 |
| `POP.W` | `POP.W Rn` | 若栈顶保存的是 `25`，执行 `POP.W R5` 后可把 `25` 读回 `R5` | 围绕隐式 `SP` 完成出栈 |
| `STSP` | `STSP Rn` | `STSP R60` | 用显式寄存器改写当前活动的隐式 `SP` |
| `LDSP` | `LDSP Rn` | `LDSP R60` | 把当前活动的隐式 `SP` 读回寄存器 |

官方明确给出的栈指针设置示例如下：

```asm
ANYI R60,R0,#8000    ; R60 = 8000
STSP R60             ; 把 8000 写入当前活动 SP
ANY  R60,R0,R0       ; 清空 R60
```

这里可以直接看到三条指令的配合关系：

1. `ANYI` 先构造栈底常数
2. `STSP` 再把这个常数写入当前模式下的隐式 `SP`
3. 后续 `PUSH.W` / `POP.W` 才有了可用的活动栈

因此，`LD.W` / `ST.W` 解决的是“普通地址如何形成”，`PUSH.W` / `POP.W` 解决的是“围绕当前栈顶怎样自动访存”。

### 3.6 Trit Test and Set

这一组不是把寄存器当作一个整体数值，而是先“找到某个 trit”，然后再问它当前是 `-`、`0`、还是 `+`，或者把它直接改写成这三种状态之一。

| 指令 | 已确认作用 | 概念例子 |
| --- | --- | --- |
| `TTF` | Test if Trit is False | 若被选中的 trit 当前为 `-`，则测试成立 |
| `TTT` | Test if Trit is True | 若被选中的 trit 当前为 `+`，则测试成立 |
| `TTU` | Test if Trit is Unknown | 若被选中的 trit 当前为 `0`，则测试成立 |
| `TTFI` / `TTTI` / `TTUI` | immediate 版本的 trit 测试 | 作用与上面相同，只是 trit 位置来自立即数字段 |
| `STF` | Set Trit to False | 若把某个 trit 置为 False，则该 trit 会被改写成 `-` |
| `STT` | Set Trit to True | 若把某个 trit 置为 True，则该 trit 会被改写成 `+` |
| `STU` | Set Trit to Unknown | 若把某个 trit 置为 Unknown，则该 trit 会被改写成 `0` |
| `STFI` / `STTI` / `STUI` | immediate 版本的 trit 设置 | 作用与上面相同，只是目标 trit 位置来自立即数字段 |
| `MSKP` | 同属该组，但详情页未给完整语义 | 目前只宜保留其分组与格式信息，等待模拟器验证 |

和二进制的“测试某一位是否为 1”相比，这一组多了第三种状态，因此背后的判断模板实际上是：

1. 先确定要观察或修改的是哪一个 trit
2. 再判断它属于 `- / 0 / +` 中的哪一种
3. 或者把它覆写成目标状态

也正因为对象是“单个 trit”，这一组指令不涉及多 trit 进位，也不涉及完整数值加减。

### 3.7 特权态与系统控制
来源：[ISA 指令详情页](https://www.ternary-computing.com/docs/assembly/ISA/isa.php?view=Detail)、[CPU ID 指令说明](https://www.ternary-computing.com/docs/assembly/ISA/Documentation/CPU_ID%205500%20instruction.pdf)

这一组大多是 `Kernel Mode` 指令，作用对象不再是普通寄存器运算，而是 `CPU` 的状态字、栈指针、异常返回路径和平台标识。

| 指令 | 结构 | 最小例子 | 执行含义 |
| --- | --- | --- | --- |
| `CID` | `CID Rn` | `CID R12` | 把 CPU type、Version、SubVersion、Core version 等字段打包写入 `R12` |
| `CHST` | `CHST Rn` | 若 `R5` 中准备好了新的状态字，执行 `CHST R5` 后只是“挂起”状态变更 | 状态修改并不立即生效，要配合 `RTI` |
| `DI` | `DI` | 在关键区入口执行 `DI` | 关闭中断响应 |
| `EI` | `EI` | 在关键区末尾执行 `EI` | 重新开启中断响应 |
| `LDITBR` | `LDITBR Rn` | 若中断表基址当前为 `2048`，执行后可把该值读回指定寄存器 | 读取中断表基址寄存器 |
| `STITBR` | `STITBR Rn` | 若 `R20` 中准备好了新中断表基址，执行后可把它写入 `ITBR` | 设置中断表基址寄存器 |
| `LDSP` | `LDSP Rn` | `LDSP R60` | 读取当前活动栈指针 |
| `STSP` | `STSP Rn` | `STSP R60` | 改写当前活动栈指针 |
| `RTI` | `RTI` | 中断处理末尾执行 `RTI` | 返回中断现场，并应用挂起的状态修改 |
| `HLT` | `HLT` | 空闲或停机路径执行 `HLT` | 让 CPU 进入停止状态 |

`CID` 最值得单独说明。它并不是返回一个“单编号”，而是把多个字段压进同一个 `24-trit` 字：

- 最低位字段表示 `CPU Type`
- 更高的字段依次表示 `Version`、`SubVersion`、`Core version`
- 再往上的高位保留

因此，若执行 `CID R12` 后，`R12` 的最低 `4 trits` 解析为 `----`，按《CPU ID 指令说明》就可以把该平台识别为 `5500FP`。

## 4. 数据对齐、同步与硬件接口
来源：[数据对齐说明](https://www.ternary-computing.com/docs/assembly/ISA/Documentation/Data%20Alignment%205500.pdf)、[同步指令说明](https://www.ternary-computing.com/docs/assembly/ISA/Documentation/Synchronization%20instructions.pdf)、[5500FP 引脚定义说明](https://www.ternary-computing.com/docs/assembly/ISA/Documentation/PINOUT_5500FP.pdf)

### 4.1 数据对齐

文档对存储规则写得比较清楚：

- 指令地址按 `4` 对齐
- 每条指令固定大小为 `4 trytes`
- 数据采用 tryte 编址

数据定义相关指令有：

- `DC.T`
- `DC.S`
- `DC.W`

其中：

- tryte 可以放在任意地址
- short 可以从模 4 的 `0/1/2` 位置开始
- word 只能从 `4` 的倍数地址开始

此外，还提供了 `DC4.T`、`DC4.S`、`DC4.W` 三种强制 4 对齐的写法。文档给出的字符串示例如下：

```asm
str_myString DC4.T 10,13,"Hello World!",0
```

ternary 存储单位虽然不同于常见二进制体系，但访存效率和总线访问仍然受到明确的对齐规则约束。

### 4.2 原子同步

《同步指令说明》明确指出，这些同步指令是原子的，并且会激活 CPU BUS 上的 `LOCK` 信号，以支持多处理器系统。

重点指令包括：

- `CAS`
- `FAA`
- `FAAI`

其中，`CAS` 的语义与常见的 compare-and-swap 一致；`FAA` 与 `FAAI` 会先读取共享内存原值，再把更新后的结果写回。这些语义直接对应共享内存并发控制。

PDF 给出的模板如下：

- `CAS (Rm),Rc,Rn`
  其中 `Rm` 存放内存地址，`Rc` 存放比较值，`Rn` 存放准备写入的新值。
- `FAA (Rm),Rn,Rc`
  其中 `Rm` 指向共享内存，`Rn` 用来接收原始值，`Rc` 提供要累加的值。
- `FAAI (Rm),Rn,#Imm4`
  和 `FAA` 类似，只是加数来自 4-trit 立即数。

对应语义可以简写为：

```asm
CAS  (Rm),Rc,Rn     ; 若 (Rm)==Rc，则 (Rm)<-Rn，否则 Rc<-(Rm)
FAA  (Rm),Rn,Rc     ; Rn<-(Rm)，随后 (Rm)<-(Rm)+Rc
FAAI (Rm),Rn,#Imm4  ; Rn<-(Rm)，随后 (Rm)<-(Rm)+Imm4
```

`CAS` 失败时并不是简单返回标志位，而是把内存中的旧值回写到比较寄存器 `Rc`。

执行过程可用下列例子表示：

- 假设 `Rm` 指向的内存当前值为 `10`，`Rc=10`，`Rn=25`
- 执行 `CAS (Rm),Rc,Rn` 后，由于比较成功，内存会被改写成 `25`
- 如果内存原值其实是 `12`，那么比较失败，内存保持 `12` 不变，但 `Rc` 会被改写成 `12`

`FAA` 也是同样的两步结构：

- 先把原值读出来交给 `Rn`
- 再把“原值 + Rc”写回原内存位置

例如：

```text
若 (Rm)=30，Rc=4
执行 FAA (Rm),Rn,Rc 后
Rn = 30
(Rm) = 34
```

这一组指令的关键在于，“读旧值”和“写新值”被捆成了一次不可分割的总线事务。

### 4.3 硬件接口

`5500FP` 使用 `80-position` 的 Hirose 连接器，关键引脚包括：

- 电源与地
- `24-trit` 数据总线
- `22-trit` 地址总线
- 给 `5501` 预留的额外 2 trits 地址线
- `CLOCK`
- `Reset#`
- `INT` / `INT_A`
- `R_W`
- `M_IO`
- `Wait`
- `MSync`
- `SSync`
- `Lock`

完整引脚定义图请查看[官方 5500FP 引脚说明 PDF](https://www.ternary-computing.com/docs/assembly/ISA/Documentation/PINOUT_5500FP.pdf)。

引脚定义中的 `Lock` 信号与同步指令文档中的说明能够直接对应，表明 ISA 级原子操作与总线级硬件接口是一体设计的。

## 5. CPU ID 与复位状态
来源：[CPU ID 指令说明](https://www.ternary-computing.com/docs/assembly/ISA/Documentation/CPU_ID%205500%20instruction.pdf)、[5500FP 复位状态说明](https://www.ternary-computing.com/docs/assembly/ISA/Documentation/Reset%20state%205500FP.pdf)

### 5.1 `CID`

`CID` 指令用于把 CPU 身份信息写入寄存器，字段包括：

- CPU type
- Version
- SubVersion
- Core version
- Reserved

文档中较关键的几项信息如下：

- CPU type 的 `-40` 对应 `5500FP`
- 硬件版本 `4.2` 已列出，但备注说明该版本尚未实现 `CID`
- `5.1` 被标注为第一次 Efinix FPGA 实现
- `ES3.1` 之前的 subversion 存在硬件问题
- core version `1` 对应 `No FPU, No SIMD`

这些信息具有明显的平台演进记录性质，说明文档对应的是一个真实原型平台，而不是单纯的纸面设计。

### 5.2 复位状态

复位文档给出了上电或 reset 后若干寄存器的初始化值，其目的在于便于快速测试 CPU 与主板功能。

比较重要的几项包括：

- `PC = -15,690,529,804`，对应 22-trit 地址总线最小值
- `SP User = 0`
- `SP Kernel = 8000`

文档还列出了一组带有明显测试性质的预装值，例如：

- `R5 = 66`，即 `'B'`
- `R6 = 105`，即 `'i'`
- `R7 = 97`，即 `'a'`
- `R8 = 103`，即 `'g'`
- `R9 = 111`，即 `'o'`
- `R10 = 10`，即换行
- `R11 = 13`，即回车

这组预装值带有明显测试性质，可用于硬件 bring-up 阶段的快速功能确认。

## 6. 目前仍需继续验证的点
来源：[ISA 指令详情页](https://www.ternary-computing.com/docs/assembly/ISA/isa.php?view=Detail)

目前仍有几项内容需要结合实验继续确认：

1. `MUL`、`DIV` 目前只能确认其属于 `B` 格式和基本数值语义，完整操作数模板仍需汇编器或模拟器验证。
2. `LD.W`、`ST.W`、`LEA`、`PUSH.W`、`POP.W` 这几条的例子有一部分是按格式反推的，尤其是栈顶移动方向和访存参数顺序，还需要实测确认。
3. 某些 ternary 一元变换指令虽然给出了真值表或短标题，但缺少更完整的示例程序，语义边界仍不宜过度推断。
4. ABI、调用约定和运行时模型没有在现有材料中系统展开。

后续工作可结合模拟器或样例程序，对关键指令逐条做小规模验证。

## 7. 小结
来源：[ISA 索引页](https://www.ternary-computing.com/docs/assembly/ISA/doc_index.html)、[ISA 指令详情页](https://www.ternary-computing.com/docs/assembly/ISA/isa.php?view=Detail)

现有文档足以勾勒 `5500 ISA` 的基本轮廓：固定 `24-trit` 指令长度、明确的格式划分、成组的三值原生函数、独立的同步机制，以及与之对应的系统控制和硬件接口。

仍未充分公开的部分主要集中在若干指令的完整语义、调用约定以及更细的运行时模型，这些内容仍需依赖后续实验补全。
