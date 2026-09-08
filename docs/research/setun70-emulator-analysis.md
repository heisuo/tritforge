# Setun70 Emulator 项目分析报告

> 分析对象：[`Zaneham/setun70-emulator`](https://github.com/Zaneham/setun70-emulator)
> 对应源码：[`Zaneham/setun70-emulator`](https://github.com/Zaneham/setun70-emulator)
> 分析提交：`3a5db33669577be65dd4b013e3f79fffab830204`
> 分析日期：2026-07-20

## 1. 结论

这个项目是一个**能运行、容易读、适合入门演示的 Python/Web 平衡三进制栈机**。它可以帮助我们理解：

- `-1/0/+1` 平衡三进制数的表示和转换；
- 6-trit syllable（音节字）的基本编码思路；
- POLIZ（逆波兰式）双栈执行模型；
- “取指 -> 译码 -> 执行 -> 单步跟踪”的模拟器结构。

但它不能直接作为以下内容的金标准：

- 真实 Setun-70 的完整 ISA 或周期精确模拟；
- 3-trit 定宽算术的参考实现；
- 单 trit 全加器、3-trit 寄存器或 ALU 的 RTL 实现；
- 真实三值器件的电平、时序和进位行为。

更准确的定位是：**受 Setun-70 架构思想启发的教学型功能原型**。对我们当前“3-trit 基础模块优先”的研究路线，它适合用来观察上层软件模型，不适合从它直接向下翻译硬件。

## 2. 项目快照

| 项目 | 结果 |
|---|---|
| 主要语言 | Python 3.10+、HTML/CSS/原生 JavaScript |
| 版本 | `1.0.0` |
| 许可证 | MIT |
| Python 运行时依赖 | 无 |
| 代码规模 | `setun70.py` 966 行；两个相同的 HTML 页面各 1058 行 |
| 示例程序 | `hello.s70`、`factorial.s70`、`quadratic.s70` |
| 自动化测试 | 配置了 pytest，但仓库中没有 `tests/` |
| 命令行入口 | `setun70 = setun70:main` |
| Web 版 | 静态页面，无后端 |

主要文件：

```text
setun70-emulator/
|-- setun70.py          # Python 模拟器、汇编器和演示程序
|-- setun70_spec.md     # 项目自带的体系结构说明
|-- README.md           # 安装、运行和架构简介
|-- pyproject.toml      # Python 打包配置
|-- examples/           # 三个 POLIZ 汇编示例
|-- index.html          # Web 演示器
`-- web/index.html      # 与根目录 index.html 完全相同
```

`pyproject.toml:42-43` 指定 Python `>=3.10` 且无运行时依赖；`pyproject.toml:63-65` 声明 pytest 应从 `tests/` 目录收集测试，但这个目录实际不存在。

## 3. 项目实现的机器模型

### 3.1 Trit 和 6-trit syllable

`setun70.py:37-41` 用枚举表示一个 trit：

```text
NEG  = -1，显示为 T
ZERO =  0，显示为 0
POS  = +1，显示为 1
```

`setun70.py:44-98` 提供以下转换：

- trit 数组到 Python 整数；
- Python 整数到指定宽度的平衡三进制数组；
- `T/0/1` 字符串与 trit 数组互转。

`Syllable` 在 `setun70.py:105-176` 中定义为固定 6 trit，理论数值范围为：

```text
-(3^6 - 1) / 2 = -364
 +(3^6 - 1) / 2 = +364
```

需要注意：这里没有独立的 3-trit 数据类型，也没有模拟一个 trit 在物理电路中的状态。trit 最终仍保存在普通二进制计算机的 Python `int` 和 `list` 中。

### 3.2 指令 syllable

代码在 `setun70.py:114-129` 中按前两个 trit 判断 syllable 类型：

```text
[0, 0, type, opcode2, opcode1, opcode0]
 ^^^^^^ operation 标志
```

- 前两个 trit 都是 0：操作 syllable；
- 第 3 个 trit：`0=basic`、`+1=service`、`-1=macro`；
- 后 3 个 trit：opcode，范围 `-13..+13`。

这种格式值得学习，因为“操作类型 + 3-trit opcode”天然体现三值字段；但项目中的具体 opcode 映射不能未经核对直接当作历史 Setun-70 ISA。

### 3.3 地址 syllable

`setun70.py:131-173` 将地址 syllable 解释为：

```text
[length, page_register, offset(4 trit)]
```

- `length`：理论上表示一次取 1、2 或 3 个 syllable；
- `page_register`：选择 `P[-1]`、`P[0]`、`P[+1]`；
- `offset`：4-trit 页内偏移，理论范围 `-40..+40`。

但 `execute_address()` 在 `setun70.py:390-394` 中只读取一个 Python 整数，完全没有使用 `length`。因此项目实际上没有实现 6/12/18-trit 三种长度的访存语义。

### 3.4 内存和状态

类常量在 `setun70.py:232-235` 中写成：

```text
27 pages x 81 syllables = 2187 syllables
3 page registers：-1、0、+1
```

复位后的主要状态见 `setun70.py:242-264`：

| 状态 | Python 实现 | 含义 |
|---|---|---|
| `operand_stack` | `List[int]` | 操作数栈 |
| `return_stack` | `List[int]` | 返回地址栈 |
| `memory` | `Dict[(page, offset), int]` | 稀疏内存 |
| `page_registers` | `{-1:0, 0:1, 1:2}` | 三个页寄存器 |
| `pc_page/pc_offset` | 两个整数 | 程序计数器 |
| `comparison_flag` | `-1/0/+1` | 比较结果 |

这里的“27 页、81 项”只是类常量。`read_memory()` 和 `write_memory()`（`setun70.py:310-316`）没有检查页号、偏移或 ROM 写保护，实际上任意 `(page, offset)` 都能写入字典。

### 3.5 双栈执行模型

项目使用 POLIZ，即逆波兰式。表达式：

```text
(3 + 4) x 5
```

写成：

```text
3 4 ADD 5 MUL
```

这使 ALU 指令不必携带源寄存器和目的寄存器字段。`ADD` 只需弹出栈顶 T 和次栈顶 S，再压回结果。对最小体系结构而言，这是一种值得考虑的“少地址”方案。

不过当前 Python 栈深度不受限制，也没有映射为 3-trit 或 18-trit 定宽存储单元。

## 4. 执行路径

`step()` 位于 `setun70.py:361-388`，流程为：

```text
PC 取 6-trit syllable
        |
        v
PC 先加 1
        |
        v
前两 trit 是否为 00？
   | 是                 | 否
   v                    v
operation            address
   |                    |
basic/service/macro   解析页寄存器并压栈
```

`run()` 位于 `setun70.py:564-576`，默认最多执行 10000 个 cycle。这里的 cycle 是“执行一次 `step()` 的软件计数”，不是硬件时钟周期；例如 `LIT` 在一个 `step()` 中额外读取下一个 syllable，但仍只增加一次 cycle。

## 5. 已实现的操作

### 5.1 Basic 操作

`setun70.py:408-535` 实现：

| 类别 | 操作 |
|---|---|
| 算术 | `ADD`、`SUB`、`MUL`、`DIV`、`NEG`、`ABS` |
| 比较 | `CMP` |
| 栈 | `DUP`、`DROP`、`SWAP`、`OVER`、`ROT` |
| 控制流 | `JMP`、`JZ`、`JN`、`JP`、`CALL`、`RET`、`HALT` |
| 访存 | `STORE`、`FETCH` |

算术全部直接使用无界 Python 整数，例如 `self.push(a + b)`。它没有逐 trit 进位，也没有 3-trit、6-trit 或 18-trit溢出规则。

控制流还使用了 `page * 100 + offset` 这种十进制临时编码（`setun70.py:463-528`），不是一个平衡三进制地址字。

### 5.2 Service 和 macro 操作

`setun70.py:537-562` 实际只实现：

- service 0：`LIT`，读取下一个 syllable 作为立即数；
- service 1：`OUT`，弹栈并打印；
- service 2：`IN`，暂时固定压入 0；
- 其他 service：静默忽略；
- 所有 macro：当作 NOP。

项目自己的 `setun70_spec.md:204-215` 却写成 `0=IN`、`1=OUT`、`2=DRUM_R`、`3=DRUM_W`。这与代码不一致，是使用该项目时必须先解决的内部矛盾。

## 6. 汇编器和 Web 版

### 6.1 Python 汇编器

`Setun70Assembler` 位于 `setun70.py:602-745`，采用两遍扫描：

1. 第一遍记录标签和 syllable 地址；
2. 第二遍生成 `Syllable` 对象；
3. `LIT n` 被展开成 service operation 和一个 literal syllable。

它足以运行仓库示例，但不是完整工具链：没有二进制/镜像文件格式、链接器、严格的字段范围检查或完整指令表。

另外，首遍标签保留原大小写，而解析指令时整行转大写，小写标签引用可能失败。未知伪指令还会静默生成 0 syllable（`setun70.py:738-745`），不利于发现汇编错误。

### 6.2 Web 演示器

根目录 `index.html` 与 `web/index.html` 内容完全相同。Web 版直接把程序编译成类似 `['ADD', null]` 的 JavaScript 高层操作数组，再操作 JavaScript 栈。

它没有复用 Python 模拟器，也没有实现：

- 6-trit 指令取指与译码；
- 分页内存；
- 地址 syllable；
- `CALL/RET` 和完整控制流；
- 定宽平衡三进制数据通路。

因此 Web 版适合交互演示，不适合用来校验 Python 模拟器或 RTL。

## 7. 本机运行验证

测试环境：Python 3.10.12；运行时设置 `PYTHONDONTWRITEBYTECODE=1`，没有安装额外依赖。

| 命令 | 结果 |
|---|---|
| `python3 setun70.py examples/hello.s70` | 退出码 0；输出 `90`；报告 7 cycles |
| `python3 setun70.py examples/factorial.s70` | 退出码 0；输出 `120`；报告 11 cycles |
| `python3 setun70.py examples/quadratic.s70` | 退出码 0；输出 `36`；报告 11 cycles |
| `python3 -m py_compile setun70.py` | 退出码 0 |
| `python3 -m pytest -p no:cacheprovider -q` | 退出码 5；没有找到测试；1 条配置警告 |

直接运行全部 demo 时，程序先输出：

```text
OUT: 120 (ternary: 011110)
5! = ERROR
```

最后仍然输出：

```text
All demos completed successfully!
```

原因是 `OUT` 会在 `setun70.py:548-551` 弹出栈顶结果，随后 `demo_factorial()` 又在 `setun70.py:896` 从已经为空的栈中取结果。最后的“全部成功”也没有检查 demo 状态。

## 8. 关键问题和风险

### 8.1 高优先级：定宽溢出没有定义

`int_to_trits()` 只生成指定数量的 trit，不检查剩余高位。实测：

```text
 365 -> TTTTTT -> -364
-365 -> 111111 ->  364
1000 -> 101001 ->  271
```

这不是经过明确设计的溢出语义，而是静默截断。若把它当作 RTL golden model，会让边界测试得到误导性结果。

### 8.2 高优先级：并非 trit 级算术模拟

ADD、SUB、MUL、DIV 都直接使用 Python 整数。项目没有：

- 单 trit 半加器或全加器；
- 平衡三进制 carry 真值表；
- 逐位 ripple carry；
- 固定位宽 wrap、饱和或异常策略；
- 真实三值寄存器和时序。

所以它能验证“数学结果”，不能验证我们即将实现的 3-trit 电路结构。

### 8.3 中优先级：规格、代码和 README 有不一致

- service opcode 映射不一致；
- address length 文档与历史资料的解释需要重新核对；
- README 把 2187 个 6-trit syllable 近似称为“约 20KB”，按信息量计算实际约为 13122 trit，即约 20.8 kilobit、2.54 KiB，而不是 20 KB；
- `setun70_spec.md:4` 声称来自 `POLIZ_PROGRAMMING_MANUAL.md`，但该文件和原始论文没有包含在仓库中。

### 8.4 中优先级：内存模型只是概念占位

- 无页号和 offset 边界检查；
- 无 RAM/ROM 区分和写保护；
- address length 被忽略；
- 返回地址用十进制拼接；
- 页面跨越没有检查总页数。

### 8.5 中优先级：没有回归测试

项目提供了 pytest 配置，但没有测试文件。示例能运行不等于边界正确，尤其缺少：

- `-364/+364` 附近的定宽算术；
- 负数除法规则；
- 栈下溢；
- 页面边界；
- 条件跳转和 CALL/RET；
- 非法 trit 和非法 opcode；
- Python 版与 Web 版一致性。

## 9. 与真实 Setun-70 的关系

仓库保留了若干与历史 Setun-70 一致的高层特征：

- 平衡三进制；
- 6-trit syllable；
- operation/address 两类 syllable；
- POLIZ 后缀程序和双栈；
- 81-syllable 页面和三个页面映射寄存器。

但仓库没有完整实现原机的基本、服务、用户操作系统，也没有完整的多 syllable 数据、ROM/RAM、磁鼓、通道、中断和微程序行为。项目仓库只有 7 次提交，代码注释和提交历史中还有明显的快速原型痕迹。

因此，涉及真实 Setun-70 的结论应继续以原始报告和历史博物馆资料为准，而不是以这里的 `setun70_spec.md` 为准。

## 10. 对我们 3-trit 研究路线的价值

### 10.1 可以借鉴

| 可借鉴内容 | 如何使用 |
|---|---|
| `T/0/1` 文本表示 | 作为 testbench 日志和测试向量格式 |
| 平衡三进制整数转换 | 改写成严格检查范围的 3-trit Python golden model |
| `NEG` | 3-trit 按位反相：`-1 <-> +1`，`0` 不变 |
| `CMP` 的三值结果 | 直接形成 `NEG/ZERO/POS` 三态 flag 思路 |
| POLIZ 栈机 | 后期最小 ISA 可考虑 T/S 两级栈顶寄存器，减少寄存器编码 |
| fetch/decode/execute | 用于软件参考模拟器和单步 trace |
| 示例表达式 | 转成 RTL 数据通路的端到端测试场景 |

### 10.2 不应照搬

| 不应照搬内容 | 原因 |
|---|---|
| 无界 Python 整数 ALU | 看不到 trit 级进位和定宽溢出 |
| 6-trit syllable作为第一版数据宽度 | 我们当前目标是先验证 3-trit 基础模块 |
| `page*100+offset` 地址 | 不是三进制硬件编码 |
| 27 页分页与完整双栈 | 第一版数据通路复杂度过高 |
| MUL/DIV、宏操作、磁鼓 I/O | 不属于最小跑通范围 |
| Web 版 | 不是位精确模拟器 |
| 仓库的 service opcode 和 length 解释 | 内部存在不一致，需查原始资料 |

## 11. 推荐使用方式

这个仓库最适合放在我们的学习链路末端，作为“上层栈机体验”和“最小指令流示例”，而不是基础模块的实现起点。

建议顺序仍然是：

```text
trit 编码和完整真值表
        -> 单 trit BUF/NEG/MIN/MAX
        -> 单 trit 寄存器
        -> 3-trit 寄存器
        -> 单 trit full adder
        -> 3-trit ripple add/sub
        -> 简化 ALU（PASS/NEG/ADD/SUB/MIN/MAX/CMP）
        -> T/S 两级寄存器或少量通用寄存器
        -> 最小 fetch/decode/execute
```

如果后续复用该项目，第一步应单独编写严格的 `word3t` 参考模型：

- 宽度固定为 3 trit；
- 数值范围固定为 `-13..+13`；
- 明确定义 overflow/carry；
- 对 27 组单 trit 全加器输入做穷举；
- 对两个 3-trit 输入的 `27 x 27 = 729` 组加减法做穷举；
- 再把结果与 RTL 仿真逐项对比。

## 12. 最终评价

| 评价维度 | 结论 |
|---|---|
| 入门学习 | 较好，短小且能直接运行 |
| 平衡三进制展示 | 较好，但超范围转换不安全 |
| 栈式 ISA 启发 | 有价值 |
| 历史 Setun-70 忠实度 | 有高层骨架，细节不足，不能视为权威实现 |
| 3-trit RTL 参考价值 | 低，需要另建定宽 trit 级 golden model |
| 直接用于本组第一版 CPU | 不建议 |

一句话总结：**用它学习“机器怎样组织”，不要用它证明“我们的 3-trit 电路怎样实现”。**

## 参考链接

- [Zaneham/setun70-emulator](https://github.com/Zaneham/setun70-emulator)
- [Russian Virtual Computer Museum: Setun](https://www.computer-museum.ru/english/setun.htm)
- [Douglas W. Jones: The Ternary Manifesto](https://homepage.cs.uiowa.edu/~jones/ternary/)
- [三进制体系结构学习规划](../learning/ternary-learning-plan.md)
