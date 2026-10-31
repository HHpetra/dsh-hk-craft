# Issue 跟踪器：本地 Markdown

本仓库的 issue、spec 与开发记录都以 markdown 文件存放在 `.scratch/` 下。没有远程 issue 系统，不使用 `gh` / `glab`。

## 约定

- 一个 feature 一个目录：`.scratch/<feature-slug>/`
- 该 feature 的 spec 是 `.scratch/<feature-slug>/spec.md`
- 实现型 issue 一文件一票：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 编号；**不要**写成单个合并的 tickets 文件
- triage 状态写在每个 issue 文件靠上的 `Status:` 行（取值见 `triage-labels.md`）
- 评论与对话历史追加到文件末尾的 `## Comments` 小节下

当前在用的 effort：

- `.scratch/inception/`（`spec.md` 范围与边界、`roadmap.md` 里程碑与验收）

已清理：

- `.scratch/pane-split-limit/`（局部分栏与可配置分屏上限）。行为以 ADR-0009、ADR-0010、`doc/README.md` 与 `GLOSSARY.md` 为准。

## 当 skill 说“发布到 issue 跟踪器”

在 `.scratch/<feature-slug>/` 下新建文件（目录不存在则创建）。

## 当 skill 说“取出相关工单”

读取对应路径的文件。用户通常会直接给出路径或编号。

## Wayfinding 操作

供 `/wayfinder` 使用。**map** 是一个文件，每个工单是它的一个 **child** 文件。

- **Map**：`.scratch/<effort>/map.md`（承载 Notes / Decisions-so-far / Fog 正文）。
- **Child ticket**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 编号，正文写问题本身。`Type:` 行记录工单类型（`research`/`prototype`/`grilling`/`task`）；`Status:` 行记录 `claimed`/`resolved`。
- **阻塞**：靠上的 `Blocked by: NN, NN` 行。当它列出的每个文件都是 `resolved` 时，该工单解除阻塞。
- **Frontier**：扫 `.scratch/<effort>/issues/`，取未关闭、未阻塞、未被认领的文件；编号最小者优先。
- **认领（Claim）**：把 `Status:` 设为 `claimed` 并保存，然后才开始工作。
- **解决（Resolve）**：在 `## Answer` 标题下追加答案，把 `Status:` 设为 `resolved`，再把上下文指针（要点 + 链接）追加到 `map.md` 的 Decisions-so-far。

## 清理

spec 与 issue 都是**短期**产物，阶段结束后清理；需要长期保留的结论升入 `ai-docs/ADR/`、`doc/` 或 `GLOSSARY.md`。
