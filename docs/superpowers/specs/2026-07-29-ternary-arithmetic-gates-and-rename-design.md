# 三进制算术基础门、分层示例与节点改名设计

## 目标

1. 新增平衡三进制基础门 `MOD_SUM` 和 `CONSENSUS`。
2. 用两个基础门展示单 trit 半加器。
3. 用两个 Half Adder 模块和一个 `MOD_SUM` 展示单 trit 全加器。
4. 支持双击画布节点快速修改显示名称。

## 门语义

`MOD_SUM(a,b)` 输出 `a+b` 的平衡三进制本位结果：

- `-2 -> 1`
- `-1 -> T`
- `0 -> 0`
- `1 -> 1`
- `2 -> T`

`CONSENSUS(a,b)` 在两个输入相等时输出该值，否则输出 `0`。

两个门沿用普通门的元状态规则：任一输入为 `E` 时输出 `E`；否则任一输入为 `X/Z` 时输出 `X`。

## 示例

基础门半加器：

```text
a,b -> MOD_SUM -> sum
a,b -> CONSENSUS -> carry
```

分层全加器：

```text
a,b       -> HA1 -> partial_sum, carry1
partial_sum,cin -> HA2 -> sum, carry2
carry1,carry2   -> MOD_SUM -> carry
```

Half Adder 模块代表对前一个基础门示例的封装。当前阶段不实现用户自定义子电路。

## 双击改名

双击任意节点打开浏览器名称输入框。取消不修改；空白名称被拒绝；有效名称只更新 `data.label`，不改变稳定 ID、类型、端口、连线或仿真状态。

## 验证

- 穷举两个新门的 9 组已知输入及元状态传播。
- 半加器示例只含一个 `MOD_SUM` 和一个 `CONSENSUS`。
- 全加器示例只含两个 Half Adder 和一个 `MOD_SUM`，穷举 27 组输入。
- Playwright 验证双击改名后仿真结果和连线保持不变。
