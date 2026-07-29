# 基础门单 Trit 全加器示例设计

## 目标

把示例库中的“单 trit 全加器”从 `module.full_adder` 黑盒节点改为可展开观察的基础逻辑门网络。`module.full_adder` 本身和 3-trit 行波进位示例保持不变。

## 结构

示例只使用三类可见元件：

- `source.trit_input`：输入 `a`、`b`、`cin`
- `source.constant`：共享常量 `T`、`0`、`1`
- `gate.mux3`：构造 `sum` 和 `carry` 两条三级查表网络
- `sink.probe`：观察最终 `sum` 和 `carry`

`sum` 使用 6 个 MUX3。先按 `cin` 生成两种循环移位结果，再按 `b` 和 `a` 逐层选择。

`carry` 使用 8 个 MUX3。先按 `cin` 生成总和基值为 `-2`、`-1`、`1`、`2` 时的进位，再按 `b` 和 `a` 逐层选择。

整个示例不得包含任何 `module.*` 节点。默认输入保持 `a=1`、`b=1`、`cin=0`，期望 `sum=T`、`carry=1`。

## 验证

- 合同测试确认示例不含 `module.*`，且恰好包含 14 个 `gate.mux3`。
- 前端全量测试和生产构建必须通过。
- Playwright 加载示例后确认 Probe 输出 `sum=T`、`carry=1`。
- Playwright 依次枚举 27 组 `a/b/cin`，验证输出满足 `a+b+cin=sum+3*carry`。
