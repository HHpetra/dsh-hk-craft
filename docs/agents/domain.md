# 领域文档（Domain Docs）

本仓是**单上下文**（根目录只有一份 `GLOSSARY.md`，无 `GLOSSARY-MAP.md`）。以下规则供所有 Agent / skill 在探索代码前遵守。

## 动手前先读

1. 根目录 `GLOSSARY.md` —— 领域语言（窗格、布局树、分屏上限、清单快照等叫法）。写 issue 标题、测试名、重构提案时用表内词汇，不要漂移到 `_Avoid_` 列出的说法。
2. `docs/adr/` —— 读与你即将改动的区域相关的 ADR。ADR 记的是"为什么这么做"；**不要重新讨论已被 ADR 定下的事**（例如插件装入现有 profile、单 bundle 两面、只用 pnpm）。
3. `docs/upstream-contracts.md` —— 改动客户端对 dsh 的依赖前，先查这里记录的契约与复验方式。

文件不存在时**静默跳过**：不要提示"缺少 ADR / 术语表"，也不要主动创建。术语或决策真正落定时，由 `domain-modeling` 按需创建。

## 冲突要显式标注

输出与既有 ADR 矛盾时，不许静默覆盖，必须写明：

> 与 ADR-0001（插件装入现有 profile）冲突，但值得重开，因为…

只在摩擦真实存在时才提；不要罗列 ADR 理论上禁止的所有重构。

## 何时新增 ADR

三条**同时**满足才写，缺一条就跳过：

1. **难以回退** —— 以后改主意的代价是实打实的
2. **没有上下文会让人困惑** —— 后人看到代码会问"为什么这么做"
3. **真有过取舍** —— 存在被放弃的备选方案，且选它有具体理由

## 文件结构

```text
/
├── GLOSSARY.md
├── docs/
│   ├── README.md              # 架构导读
│   ├── adr/                   # 0001-slug.md … 一决策一文件
│   ├── agents/                # domain / issue-tracker / triage-labels
│   └── upstream-contracts.md  # dsh 上游契约
├── ai-docs/spec/              # 短期 spec，阶段结束清理
└── packages/dsh-hk-craft/src/
```
