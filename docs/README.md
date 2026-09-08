# TritForge 文档导航

这里汇总 TritForge 的使用说明、设计文档和三进制计算研究资料。

## 学习路线

- [三进制体系结构学习规划](learning/ternary-learning-plan.md)：从单 trit 基础门、3-trit 模块到最小处理器的阶段性学习路线。
- [Ternary CPU 5500 ISA 学习笔记](research/ternary-cpu-5500-isa-study-notes.md)：24-trit 指令格式、寄存器、原生三值函数和硬件接口笔记。

## Setun 与 Setun-70

- [Setun 系列计算机架构入门](guides/setun-architecture-guide.md)：配合架构图讲解第一代 Setun、Setun-70、双栈和分页机制。
- [Zaneham 模拟器 Web 架构图](images/setun-guide/setun70-emulator-web-architecture.svg)：浏览器界面、Python 适配层和模拟器内核的关系。
- [Zaneham Python 版 Setun70 指令集学习文档](research/zaneham-setun70-isa-guide.md)：偏硬件实现的教学型模拟器 ISA 拆解。
- [Zaneham Setun70 Emulator 项目分析](research/setun70-emulator-analysis.md)：项目定位、实现范围和研究价值。
- [smaslovski/Setun70 项目分析](research/smaslovski-setun70-analysis.md)：Fortran 模拟器的数据通路、存储与指令机制。
- [三进制与 Setun 论文资料综合分析](research/setun-literature-analysis.md)：对历史资料、3-trit 教学机和现代三值电路论文的分类分析。
- [论文资料索引](research/setun-literature-index.csv)：分析时使用的论文清单、页数和可检索性记录；原始论文和压缩包不随仓库分发。

## TritForge 设计与实现

- [项目总体设计与演进路线](Logsim-Ternary项目总体设计与演进路线.md)
- [仿真核心算法图](images/ternary-simulator-core-algorithm.svg)
- [`docs/superpowers/specs`](superpowers/specs)：各阶段功能设计。
- [`docs/superpowers/plans`](superpowers/plans)：各阶段实现计划和验收记录。

## 资料边界

仓库只收录我们编写的学习笔记、分析报告和自制图。第三方源码仓库、论文 PDF、压缩归档、字体、依赖缓存和构建产物不在此仓库中；相关资料尽量在文档内链接到原始来源。
