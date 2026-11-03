# Domain Docs

工程类 skill 在探索本仓库代码前，按本文件消费领域文档。

## 动手前先读这些

- 根目录 **`GLOSSARY.md`**（领域语言：术语与要避免的同义词）。
- 若根目录存在 **`GLOSSARY-MAP.md`**：它指向每个上下文各自的 `GLOSSARY.md`，按主题读相关的那几个。
- **`docs/adr/`**：读与你即将改动的区域相关的 ADR。多上下文仓库还需检查 `packages/<pkg>/docs/adr/` 下与上下文相关的决定。

上述文件不存在时**静默继续**：不要提示缺失，也不要主动建议先创建；`/domain-modeling`（经 `/grill-with-docs` 与 `/improve-codebase-architecture` 触发）会在术语或决策真正收敛时按需创建。

## 文件结构

单上下文（本仓库）：

```text
/
├── GLOSSARY.md
├── docs/
│   ├── adr/0001-….md
│   ├── agents/
│   ├── research/
│   └── upstream-contracts.md
└── packages/dsh-hk-craft/src/
```

多上下文（根目录存在 `GLOSSARY-MAP.md` 为标志）本仓库当前不使用：

```text
/
├── GLOSSARY-MAP.md
├── docs/adr/                     ← 系统级决定
└── packages/<pkg>/
    ├── GLOSSARY.md
    └── docs/adr/                 ← 该上下文的决定
```

## 使用词汇表里的词

产出中提到某个领域概念（issue 标题、重构提案、假设、测试名）时，使用 `GLOSSARY.md` 中定义的术语，不要漂移到 `_Avoid_` 列出的同义词。

若需要的概念还不在词汇表里，这本身是个信号：要么你在自造项目不用的语言（重新考虑），要么存在真实缺口（记下来交给 `/domain-modeling`）。

## 主动标注 ADR 冲突

产出与既有 ADR 矛盾时，显式指出而不是静默覆盖：

> _与 ADR-0007（event-sourced orders）冲突，但值得重开，因为……_

本仓库 ADR 只增不改：与旧条目冲突时新增条目并写明取代关系，旧条目的正文不重写。
