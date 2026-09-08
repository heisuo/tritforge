# smaslovski/Setun70 项目分析报告

> 分析对象：[`smaslovski/Setun70`](https://github.com/smaslovski/Setun70)
> 对应源码：[`smaslovski/Setun70`](https://github.com/smaslovski/Setun70)
> 分析提交：`aece8ce5bd5b28d57acccbeda95ac3439e0cbc34`
> 分析分支：`main`，浅克隆
> 分析日期：2026-07-20

## 1. 结论

这个项目是一个**以 1970 年 Setun-70 算法描述为依据、用 GNU Fortran 2008 和 trit 数组重写的结构化模拟器**。与 `Zaneham/setun70-emulator` 的教学型 Python 栈机相比，它更接近“把原始机器算法翻译成可执行程序”：

- 主存、外存和寄存器都明确表示为 trit 数组；
- 6-trit syllable 和 18-trit word 都有实际数据结构；
- T/S 不是无界列表，而是主存中的 18-trit 栈顶和次栈顶；
- 指令按 macro/basic/special 三类分派；
- 代码保留 27 个基本操作和 27 个特殊操作；
- 包含 ROM 镜像、I/O 通道、中断、Consul-254 终端和单步调试框架。

它的研究价值明显高于前一个 Python 项目，尤其适合回答“Setun-70 的寄存器、栈、分页和操作是怎样组织的”。但是，它仍不是我们 3-trit 硬件的现成 RTL 方案：

- 数据通路主体是 18 trit，不是 3 trit；
- trit 数组运算多数会先转换成 Fortran 整数，再回写数组，不是门级进位链；
- 体系结构包含分页、宏操作、外存、三路 I/O、OpenMP 和中断，第一版照搬会严重超出范围；
- 外存页面搜索过程 `SUIT()` 目前为空；
- 仓库没有自动化测试；
- 本机缺少 `gfortran` 和 `xterm`，本次无法完成真实编译与交互运行。

准确定位是：**适合做历史架构与指令语义参考，不适合直接移植成第一版 3-trit CPU。**

## 2. 项目快照

| 项目 | 结果 |
|---|---|
| 主要语言 | GNU Fortran 2008，部分 `.F90` 使用 C 预处理宏 |
| 并发 | OpenMP |
| 许可证 | GPL-3.0 |
| 当前提交 | `aece8ce5bd5b28d57acccbeda95ac3439e0cbc34` |
| main 最近提交日期 | 2024-12-06 |
| 源代码规模 | Fortran/头文件/算法描述/ROM CSV 合计约 2495 行 |
| 构建工具 | GNU Make、gfortran、OpenMP |
| 运行环境 | Linux/POSIX、Bash、xterm、FIFO、stty、tee、tail |
| 自动化测试 | 未找到测试文件或 CI 配置 |
| 当前演示能力 | README 表述为带 I/O 和中断支持的简单 echo 流程 |

远端分支状态：

| 分支 | 当前提交 | README 定位 |
|---|---|---|
| `main` | `aece8ce...` | 当前开发分支 |
| `original` | `aece8ce...` | 按 1970 年描述实现原始 ISA；当前与 main 同提交 |
| `structural` | `d25d3b1...` | 面向结构化程序设计的 ISA 修改分支 |

本报告只分析当前 `main`，不把 `structural` 分支的设计混入结论。

## 3. 文件结构和职责

```text
Setun70/
|-- setun70.F90          # 机器全局状态、执行循环、27 basic + 27 special 操作
|-- setun70.h            # C 预处理标签：START/CYCLE/B1..B27/S1..S27
|-- setun70_vars.h       # T/S/tt/c1/ch/ca 等寄存器切片宏
|-- ternary_arith.f90    # Trit 类型、定宽数组转换、算术和比较运算符
|-- service.F90          # 初始化、ROM.csv 装载、状态转储、信号和延时
|-- service.h            # service 的 include 文件
|-- io_module.f90        # I/O 设备结构和 balanced nonary 编解码
|-- disasm.f90           # 54 个 basic/special mnemonic 的反汇编
|-- consul254.f90        # Consul-254 键盘/打印机终端模拟
|-- Setun70.alg          # 从 1970 年报告 OCR 并修订的类 Algol 算法描述
|-- ROM.ods              # 带宏的启动 ROM 表格与翻译器
|-- ROM.csv              # 模拟器实际读取的 ROM 镜像
|-- run                  # 建立 FIFO 并启动四个 xterm 窗口
|-- Makefile             # gfortran/OpenMP 构建
`-- docs/                # 原始/整理后的俄文报告、符号表和指令表
```

README 很短，但明确说明 `Setun70.alg` 来自 1970 年报告的 OCR 和人工编辑，Fortran 是对该算法描述的可编译转写，见 `README.md:5-6`。

## 4. Trit 表示和算术层

### 4.1 Trit 类型

`ternary_arith.f90:16-19` 定义：

```fortran
type :: Trit
  sequence
  integer(tsz) :: val
end type
```

`modulo_tri()` 在 `ternary_arith.f90:89-102` 把任意整数余数归一化到 `-1/0/+1`：

```text
余数 -2 -> +1
余数 -1 -> -1
余数  0 ->  0
余数 +1 -> +1
余数 +2 -> -1
```

这个 `Trit` 类型比 Python 项目更适合做软件参考模型，因为数组中的每个元素确实被限制为一个三值数字。

### 4.2 整数与 trit 数组转换

整数写入 trit 数组时，`assign_i2ta()` 从最低位向最高位逐位执行：

```text
当前 trit = balanced_mod_3(d)
d = (d - 当前 trit) / 3
```

对应代码为 `ternary_arith.f90:110-119`。trit 数组读回整数时，`assign_ta2i()` 在 `ternary_arith.f90:127-135` 执行：

```text
i = 3*i + trit
```

这两个过程可以直接借鉴到我们的 Python/C++ golden model，但应额外检查写入结束后 `d` 是否为 0，从而显式报告定宽溢出。当前代码和 Python 项目一样，没有单独返回 overflow。

### 4.3 算术的真实层次

`ternary_arith.f90` 重载了 `+ - * /` 和比较操作，但多数数组运算并非逐 trit 实现。例如：

- `add_ta_ta()`：先把一个数组转成普通整数，再相加，见 `ternary_arith.f90:164-169`；
- `sub_ta_ta()`：转成整数后相减，见 `ternary_arith.f90:198-202`；
- `mul_ta_ta()`：转成整数后相乘，见 `ternary_arith.f90:225-230`；
- 比较：转换成整数后比较，见 `ternary_arith.f90:240-341`。

因此它是**定宽 trit 数组上的功能级模型**，比无界 Python 整数更接近硬件，但仍没有展示单 trit full adder、carry 传播和门级时序。

## 5. 主存、外存和寄存器

### 5.1 主存的两种视图

`setun70.F90:28-41` 定义：

```text
m(page=-13..13, offset=-40..40, trit=1..6)
mw(page=-13..13, word=-13..13, trit=1..18)
```

两者通过 `equivalence` 共用同一片 Fortran 存储：

- `m` 视图：27 页，每页 81 个 6-trit syllable；
- `mw` 视图：27 页，每页 27 个 18-trit word；
- 3 个相邻 syllable 正好组成一个 18-trit word。

这比 Python 项目的稀疏字典更接近真实机器组织，也是该仓库最值得研究的部分之一。

### 5.2 外存

外存定义为：

```text
f(bank=-1..1, page=-3280..3280, offset=-40..40, trit=1..6)
```

并有三个 8-trit 页面指针 `q(-1:1,1:8)`。`COPY()` 和 `LOAD()` 在 `setun70.F90:666-700` 负责外存页与主存页之间的整页复制。

但 `SUIT(i)` 在 `setun70.F90:168-186` 只有注释，没有任何执行语句。它本应模拟外存寻页并在完成后发出中断，当前却直接返回。因此外存框架虽然存在，异步换页过程并未完整实现。

### 5.3 主要寄存器

| 名称 | 宽度 | 代码位置 | 作用 |
|---|---:|---|---|
| `h(-1:1)` | 每个 3 trit | `setun70.F90:32` | 三个主存页选择寄存器 |
| `c` | 32 trit | `setun70.F90:33` | 模式、指令页/地址和中断上下文 |
| `p` | 10 trit | `setun70.F90:34` | 栈页和栈指针，两套上下文 |
| `k` | 6 trit | `setun70.F90:35` | 当前指令 syllable |
| `e` | 6 trit | `setun70.F90:36` | 指数/短算术寄存器 |
| `R` | 18 trit | `setun70.F90:36` | 长算术寄存器 |
| `Y` | 18 trit | `setun70.F90:36` | 长算术扩展寄存器 |
| `g` | 三组、每组 7 trit | `setun70.F90:37` | I/O 数据寄存器 |
| `u` | 三组、每组 4 trit | `setun70.F90:37` | I/O 控制寄存器 |
| `v/w` | 9/4 trit | `setun70.F90:38` | 中断请求和中断原因 |

### 5.4 T/S 不是独立数组

`setun70_vars.h:1-3` 用宏把 T、S 和 `tt` 映射到主存：

```text
T  = 当前栈页、当前 pa 指向的 18-trit word
S  = 当前栈页、pa-1 指向的 18-trit word
tt = T 中与当前 syllable 对齐的 6-trit 部分
```

这说明 Setun-70 的栈不是 Python 那种无限列表，而是主存页上的固定 18-trit word 栈。`pa` 只有 3 trit，范围为 `-13..+13`，一页容纳 27 个栈 word。

对我们以后设计最小栈机很有启发：硬件可以先做 T/S 两级快速寄存器，后面再决定是否把更深栈映射到小型 RAM。

## 6. 取指、译码与地址引用

执行主循环位于 `setun70.F90:222-271`：

```text
检查 start 和中断请求
        |
        v
k <- m[ch, ca]，取 6-trit syllable
        |
        v
k1==0 且 k2==0？
   | 是                     | 否
   v                        v
按 k3 分为               引用 syllable
MACRO/BASIC/SPEC          复制 1/2/3 个 syllable 到 T
```

字段宏见 `setun70_vars.h:9-13`：

```text
k1 = k(1)       # 引用长度字段
k2 = k(2)       # 页面寄存器选择
k3 = k(3)       # 操作类别
ka = k(3:6)     # 4-trit 地址/宏操作字段
ko = k(4:6)     # 3-trit opcode，-13..+13
```

### 6.1 三种指令类别

当 `k1=k2=0` 时，代码用 `k3+2` 分派：

| `k3` | 类别 | 行为 |
|---:|---|---|
| `-1` | MACRO | 进入 ROM/软件宏操作分派 |
| `0` | BASIC | 27 个基本机器操作 |
| `+1` | SPEC | 27 个特殊/系统操作 |

### 6.2 引用 syllable 的长度

`REFSYL()` 在 `setun70.F90:613-625` 复制：

```text
k1 + 2 个 syllable
```

所以长度字段的正确关系是：

| `k1` | 复制 syllable 数 | 数据宽度 |
|---:|---:|---:|
| `-1` | 1 | 6 trit |
| `0` | 2 | 12 trit |
| `+1` | 3 | 18 trit |

这也证明前一个 Python 项目 `setun70_spec.md` 中 `-1 -> 3`、`+1 -> 1` 的表是反的。

## 7. 27 个基本操作

基本操作在 `setun70.F90:291-462`，助记符表在 `disasm.f90:16-24`。

| 组别 | 操作 |
|---|---|
| 移位/规格化 | `LST`、`COT`、`XNN` |
| e 寄存器 | `E-1`、`E=0`、`E+1`、`T-E`、`E=T`、`T+E` |
| 三向条件 | `CLT`、`CET`、`CGT` |
| 控制/寄存器 | `T=C`、`R=T`、`C=T`、`T=W`、`YFT`、`W=S`、`Y=T` |
| 三值逐位 | `SMT`、`SAT` |
| 基础算术 | `S-T`、`TDN`、`S+T` |
| 长算术 | `LBT`、`L*T`、`LHT` |

对我们第一版最相关的是：

- `S-T`：18-trit 减法，`setun70.F90:435-437`；
- `TDN`：T 取负，`setun70.F90:439-441`；
- `S+T`：18-trit 加法，`setun70.F90:443-445`；
- `CLT/CET/CGT`：按负/零/正三种情况改变控制流，`setun70.F90:356-378`；
- `SMT`：两个 word 逐 trit 相乘，`setun70.F90:411-417`；
- `SAT`：逐 trit 的三值组合规则，`setun70.F90:423-433`。

其中 `SMT` 和 `SAT` 值得单独抄出完整 9 项真值表，作为基础三值逻辑候选；但命名和语义应回到原始报告核对，不能仅凭英文缩写猜测。

长算术和规格化操作同时使用 S/T/R/Y/e，明显超出第一版 3-trit ALU 的需要。

## 8. 27 个特殊操作和宏操作

特殊操作在 `setun70.F90:464-587`，主要包括：

- 三组 I/O 数据传入/传出：`COPYG1..3`、`LOADG1..3`；
- 三组外存页复制和写回：`COPYF1..3`、`LOADF1..3`；
- 三个外存页面指针：`LOADQ1..3`；
- 栈指针/上下文：`COPYP`、`EXCHP`、`LOADP`；
- 模式上下文：`COPYMC`、`RETNMC`、`LOADMC`；
- 页面寄存器：`LOADH1..3`；
- I/O 控制：`LOADU1..3`。

宏操作入口在 `setun70.F90:274-289`。它切换模式和上下文后，把控制转到主存页面 `-13` 的宏程序。`ROM.ods` 是带宏的启动 ROM/翻译器，`ROM.csv` 是模拟器实际读取的镜像。

这套设计说明 Setun-70 把许多复杂操作下放到软件/ROM，而不是全部做成硬连线 ALU。这个思想适合我们的最小 CPU：第一版只保留少量硬件操作，复杂运算以后用指令序列完成。

## 9. ROM、I/O 和中断

### 9.1 ROM 装载

`INIT_EMU()` 默认读取 `ROM.csv`，见 `service.F90:46-53`。内部 `load_dump()`：

1. 从首行读取页数、页码和行数；
2. 用 balanced nonary 编码转换页号和地址；
3. 把每个 6-trit 单元写入 `m(page, offset, 1:6)`。

对应代码为 `service.F90:125-151`。

`ROM.csv` 首行声明 5 个页面和 58 行数据。`ROM.ods` 内含 LibreOffice Basic 宏和 ROM 翻译逻辑，不只是一个普通数据表。

### 9.2 Balanced nonary 文本编码

`io_module.f90:39-78` 用 3 个九进制字符表示数值，每个字符对应 `-4..+4`：

```text
W X Y Z 0 1 2 3 4
-4      0       +4
```

这种表示把两个 trit 合并成一个 balanced nonary digit，适合 ROM CSV 和日志，不代表硬件中增加了九值器件。

### 9.3 三组 I/O

`io_unit(-1:1,-4:4)` 表示三组、每组最多 8 个有效设备号，见 `io_module.f90:14-25`。默认连接包括：

- 控制台寄存器；
- 纸带读入；
- 纸带打孔输出；
- Consul-254 终端输入和输出。

`INOUT(-1/0/+1)` 是三个无限循环的异步设备进程，见 `setun70.F90:117-151`。数据传输后通过 `v(i+3)` 提交中断请求。

### 9.4 OpenMP 并发

主程序在 `setun70.F90:706-758` 启动 5 个 OpenMP section：

```text
INOUT(-1)
INOUT(0)
INOUT(+1)
WATCH 定时器
CPU + 信号处理
```

这种写法模拟异步外设和中断，但不是确定性硬件时序模型。共享的 `a/v/u/g` 等状态也没有显式锁或原子同步，不能把软件线程调度顺序当作硬件事件顺序。

## 10. 调试和运行方式

`DUMP()` 在每个机器循环输出：

- cycle 计数；
- 当前/下一条指令和反汇编；
- `h/k/c/p/t/e/T/S/R/Y/v/u/g` 等状态。

相关代码见 `service.F90:157-205`。默认 `single_step=.true.`，每个 cycle 后把 `start` 清零，再由控制台选择：

```text
0 Restart
1 Run
2 Step
```

`run` 脚本会在 `/tmp` 建立命名 FIFO，并启动四个 xterm：

1. Setun-70 CPU；
2. Consul-254；
3. 键盘纸带码日志；
4. 键盘字符日志。

这套环境适合历史演示，但不适合作为自动化回归测试入口。

## 11. 本机验证结果

### 11.1 成功完成的静态验证

| 验证 | 结果 |
|---|---|
| `git rev-parse HEAD` | `aece8ce5bd5b28d57acccbeda95ac3439e0cbc34` |
| `git status --short --branch` | `main...origin/main`，工作树干净 |
| `make -n all` | 成功展开完整 gfortran/OpenMP 编译和链接命令 |
| `bash -n run` | 退出码 0 |
| `unzip -t ROM.ods` | 压缩结构完整，无错误 |
| 两个 docs ODS 的 `unzip -t` | 压缩结构完整，无错误 |
| ROM/文档文件类型 | ODS、PDF、DjVu 类型均可识别 |

### 11.2 未能完成的动态验证

本机没有 `gfortran`。实际执行 `make all` 的结果是：

```text
gfortran -g -fopenmp --syntax-only -c ternary_arith.f90
make: gfortran: No such file or directory
make: *** [Makefile:36: ternary_arith.mod] Error 127
```

`make` 退出码为 2。由于第一步就失败，没有生成 `.o`、`.mod` 或可执行文件。

本机也没有 `xterm`，所以即使存在已编译二进制，仓库默认的四窗口 `make run` 流程也不能直接启动。本次没有安装系统包，也没有声称模拟器运行成功。

## 12. 项目的优点

### 12.1 历史依据清楚

仓库直接包含：

- 1970 年算法描述扫描件；
- 从报告 OCR 后修订的 `Setun70.alg`；
- 俄文指令表和符号表；
- Fortran 转写；
- ROM 表格和镜像。

`Setun70.alg:1-7` 与 `setun70.F90:28-39` 的核心数组能够逐项对应，主循环标签和 27 个操作也保持相同结构。相比快速编写的教学模拟器，它更便于追溯“代码为什么这样写”。

### 12.2 数据宽度明确

6-trit syllable、18-trit word、3-trit/4-trit 地址字段和各寄存器宽度都在数组维度中体现，而不是仅写在注释里。

### 12.3 暴露了真实架构复杂度

它展示了一个可用三进制系统不仅有 ALU，还涉及：

- 栈页和上下文；
- macro/basic/special 操作；
- ROM 软件层；
- 内外存换页；
- I/O 通道；
- 中断；
- 终端编码。

这对后期体系结构设计很有价值，也提醒我们第一版必须主动控制范围。

## 13. 局限和风险

### 13.1 高优先级：外存寻页过程为空

`SUIT(i)` 只有注释，没有执行逻辑。S7-S9 虽然调用它加载外存页号，但不会真正模拟搜索延迟和完成中断。因此不能认为外存子系统已完整实现。

### 13.2 高优先级：缺少自动化测试

仓库没有单元测试、指令级回归、ROM 启动结果断言或 CI。当前 README 只说明 echo 流程，没有给出可自动判断成功/失败的命令。

后续若把它当 ISA 参考，应至少补：

- trit 转换边界；
- 27 个 basic 操作逐项测试；
- 27 个 special 操作逐项测试；
- 1/2/3 syllable 引用；
- T/S 栈边界和中断；
- ROM 冷启动；
- Consul-254 echo 的可重复测试。

### 13.3 中优先级：不是门级或周期精确模型

Fortran 整数承担了多数算术；OpenMP 和 `usleep` 承担异步外设。机器循环计数和宿主线程调度不能直接对应硬件时钟周期。

### 13.4 中优先级：平台依赖强

运行依赖 GNU Fortran、OpenMP、POSIX signal/usleep、Bash、xterm、命名 FIFO 和终端控制。它不是开箱即用的跨平台库。

### 13.5 中优先级：实现和历史资料仍需交叉验证

虽然仓库的追溯链比 Python 项目完整，但 `Setun70.alg` 本身是 OCR 和编辑后的文本，Fortran 又为单步、线程和宿主 I/O 做了修改。关键指令语义仍应同时核对原始扫描件。

### 13.6 许可证约束

源码为 GPL-3.0。学习算法、运行和内部实验没有问题；如果把代码直接复制进需要闭源或采用不兼容许可证的工程，必须先评估 GPL 传播义务。对硬件项目更稳妥的方式是：从公开架构说明和真值表重新实现，并保留来源说明，而不是逐行翻译 GPL Fortran。

## 14. 对我们 3-trit 基础模块路线的价值

### 14.1 现在就可以借鉴

| 内容 | 建议用途 |
|---|---|
| `Trit` 与数组转换算法 | 做严格 3-trit 软件 golden model |
| `SMT`/`SAT` | 提取 9 项真值表，评估是否纳入基础逻辑库 |
| `TDN` | 验证 balanced ternary 取负即逐 trit 反相 |
| `S+T`/`S-T` | 作为未来 ALU 指令语义参考 |
| `CLT/CET/CGT` | 形成 NEG/ZERO/POS 三向条件控制 |
| 1/2/3 syllable 引用 | 后期设计可变长度 6/12/18-trit 访存时参考 |
| T/S 映射到主存栈 | 后期最小栈机的数据通路参考 |
| ROM 实现宏操作 | 用软件序列代替复杂硬件操作 |

### 14.2 第一版不要照搬

| 内容 | 原因 |
|---|---|
| 18-trit 主数据通路 | 当前目标是先跑通 3-trit 基础模块 |
| 27 页 x 81 syllable 主存 | 会提前引入地址和存储复杂度 |
| 外存 `f/q/SUIT` | 当前实现还不完整，且不属于最小链路 |
| 27 basic + 27 special + macro | 第一版 opcode 和控制器过大 |
| R/Y/e 长算术与规格化 | ALU 复杂度远超 `ADD/SUB/NEG/CMP` |
| 三组异步 I/O 和中断 | 先用简单输入输出寄存器或测试台代替 |
| OpenMP 线程模型 | 不对应同步 RTL 时序 |
| Consul-254 和纸带 | 属于历史外围设备，不是当前验证重点 |

## 15. 推荐提取路线

不要尝试把整个项目翻译成 Verilog/SystemVerilog。建议只提取四层知识：

### 第一层：3-trit golden model

- 固定 3 trit，范围 `-13..+13`；
- 明确 `-1/0/+1` 的 RTL/器件接口；
- 对转换过程增加 overflow 检查；
- 作为所有后续模块的共同参考。

### 第二层：基础三值逻辑

- 从 `SMT`、`SAT`、`TDN` 提取单 trit 规则；
- 写完整真值表；
- 与 Jones 的 `NEG/MIN/MAX` 体系对照；
- 只保留语义清晰且能映射到现有 3bit 器件的操作。

### 第三层：3-trit 算术和寄存器

- 单 trit full adder 27 项真值表；
- 3 个 full adder 串成 3-trit ripple adder；
- `NEG + ADD` 实现减法；
- 3-trit T/S 两个寄存器先代替完整内存栈。

### 第四层：最小栈式数据通路

第一版只考虑：

```text
LIT / PUSH
ADD
SUB
NEG
CMP 或三向条件
DROP / SWAP（二选一或按需要加入）
HALT
```

复杂运算通过短指令序列实现。等 3-trit ALU 和寄存器稳定后，再评估 6-trit 指令 syllable、T/S 栈和 ROM 宏操作。

## 16. 与 Python 项目的对比

| 维度 | Zaneham/setun70-emulator | smaslovski/Setun70 |
|---|---|---|
| 上手难度 | 低，直接运行 Python | 高，需要 gfortran/OpenMP/xterm |
| 代码规模 | 小 | 中等，且含历史资料和外围设备 |
| trit 表示 | Python int/list | 明确的 Trit 和定宽数组 |
| 主数据宽度 | 名义 6 trit，实际整数无界 | 6-trit syllable、18-trit word |
| 栈 | Python 列表 | 主存中的固定 word 栈 |
| 指令覆盖 | 简化自定义子集 | 27 basic + 27 special + macro 框架 |
| 历史追溯 | 原始资料不在仓库 | 扫描件、OCR 算法和代码同仓库 |
| 自动化测试 | 无 | 无 |
| 对 3-trit RTL 的直接价值 | 低 | 中等，适合提取语义，不适合直接翻译 |

两个项目不是互相替代关系：

- Python 项目适合快速体验 POLIZ 栈机；
- Fortran 项目适合深入研究 Setun-70 的真实组织方式；
- 我们自己的 3-trit RTL 仍需独立设计和穷举验证。

## 17. 最终评价

| 评价维度 | 结论 |
|---|---|
| 历史架构学习 | 很有价值 |
| trit 定宽数据结构 | 有价值 |
| 指令和寄存器研究 | 很有价值 |
| 开箱即用程度 | 较低 |
| 实现完整性 | 核心 CPU 框架较完整，外存寻页和验证链不完整 |
| 3-trit 基础模块参考 | 中等，应只提取小模块语义 |
| 直接作为第一版 CPU | 不建议 |

一句话总结：**把它当作 Setun-70 的“可读结构图和算法档案”，从中挑小模块；不要把整台 18-trit 历史机器搬进我们的第一版设计。**

## 参考链接

- [smaslovski/Setun70](https://github.com/smaslovski/Setun70)
- [Russian Virtual Computer Museum: Setun](https://www.computer-museum.ru/english/setun.htm)
- [Douglas W. Jones: The Ternary Manifesto](https://homepage.cs.uiowa.edu/~jones/ternary/)
- [三进制体系结构学习规划](../learning/ternary-learning-plan.md)
- [Zaneham Setun70 Emulator 项目分析](setun70-emulator-analysis.md)
