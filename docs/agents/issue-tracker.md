# Issue Tracker

本仓库的 issue 用**本地 markdown** 记录，没有远程 issue 系统；`.scratch/` 要入库，不要 gitignore。

## 位置与格式

```text
.scratch/<feature-slug>/
├── brief.md            # 该 feature 的目标与背景（可选）
└── issues/
    ├── 001-<slug>.md
    └── 002-<slug>.md
```

- 一票一文件，三位编号递增；不重编、不复用。
- 每票至少写：**要做什么 / 为什么 / 验收标准**，以及 `Blocked by:` 行（没有就写 `none`）。
- 文件开头写 `Status:`：`open` / `in-progress` / `done` / `wontfix`。
- spec 不放这里：当前开发的 spec 在 `ai-docs/spec/`（短期，阶段结束清理）。

## 工作方式

- 按 `Blocked by` 的拓扑顺序取票：**只有阻塞项已完成的票才能开工**。
- 每票自包含；做完把结论收敛进代码与 `docs/adr/`，不要指望下一个人去读票据。

## 切换到 GitHub / GitLab

有 remote 之后再切换：把 `.scratch/<feature>/issues/*.md` 一次性建成 issue，并同步改掉 `AGENTS.md` 里的 Agent skills 块。

| 平台 | 创建 | 关闭 |
| :--- | :--- | :--- |
| GitHub | `gh issue create --title "…" --body-file <file>` | `gh issue close <n>` |
| GitLab | `glab issue create --title "…" --description "…"` | `glab issue close <n>` |

## Wayfinding（`/wayfinder`）

map 是一个文件，每个工单是它的一个 child 文件；这类工单记录调研/原型过程，与上面的实现型票分开。

- **Map**：`.scratch/<effort>/map.md`（承载 Notes / Decisions-so-far / Fog 正文）。
- **Child ticket**：`.scratch/<effort>/issues/NNN-<slug>.md`，正文写问题本身。`Type:` 行记录工单类型（`research`/`prototype`/`grilling`/`task`）；`Status:` 行记录 `claimed`/`resolved`。
- **阻塞**：靠上的 `Blocked by: NNN, NNN` 行；列出的每个文件都是 `resolved` 时解除阻塞。
- **Frontier**：扫 `.scratch/<effort>/issues/`，取未关闭、未阻塞、未被认领的文件；编号最小者优先。
- **认领**：把 `Status:` 设为 `claimed` 再开工；**解决**：在 `## Answer` 下追加答案、`Status: resolved`，并把要点 + 链接追加到 `map.md` 的 Decisions-so-far。
