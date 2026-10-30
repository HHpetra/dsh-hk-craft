# 域文档

工程类 skill 在探索本仓库代码时，应按本文件读取领域文档。

## 探索前先读这些

- 仓库根目录的 **`GLOSSARY.md`**（领域语言：术语与要避免的同义词）；或
- 仓库根目录的 **`GLOSSARY-MAP.md`**（若存在）：它指向每个上下文各自的 `GLOSSARY.md`，按主题读取相关的那几个。
- **`ai-docs/ADR/`**：先看 `README.md` 的索引，再读与你要改动的区域相关的 ADR（前期合并档为 `decisions.md`）。多上下文仓库还需检查 `src/<context>/docs/adr/` 下与上下文相关的决定。

若上述文件不存在，**静默继续**：不要提示缺失，也不要主动建议先创建它们。`/domain-modeling` skill（经 `/grill-with-docs` 与 `/improve-codebase-architecture` 触发）会在术语或决定真正收敛时按需创建。

架构导读在 `doc/`（只讲分层、安装路径、插件边界与关键数据流）；具体实现以代码为准。

## 文件结构

本仓库是 **single-context**（单上下文）：

```
/
├── GLOSSARY.md
├── ai-docs/ADR/
│   ├── README.md
│   └── decisions.md
├── doc/
└── packages/dsh-hk-craft/src/
```

多上下文形态（以根目录存在 `GLOSSARY-MAP.md` 为标志）本仓库当前不使用：

```
/
├── GLOSSARY-MAP.md
├── ai-docs/ADR/                     ← 系统级决定
└── packages/
    └── <pkg>/
        ├── GLOSSARY.md
        └── docs/adr/                ← 该上下文的决定
```

## 使用词汇表里的词

当你的产出中提到某个领域概念（issue 标题、重构提案、假设、测试名）时，使用 `GLOSSARY.md` 中定义的术语，不要漂移到词汇表明确要求避免的同义词。

若你需要用到的概念还不在词汇表里，这本身就是个信号：要么你在自造项目不用的语言（重新考虑），要么存在真实缺口（记下来交给 `/domain-modeling`）。

## 主动标注 ADR 冲突

若你的产出与既有 ADR 相矛盾，显式指出，而不是静默覆盖：

> _与 ADR-0007（event-sourced orders）冲突，但值得重开，因为……_

本仓库 ADR 只增不改：与旧条目冲突时追加新条目并写明取代关系，旧条目不重写。
