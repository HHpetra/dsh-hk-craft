# Issue tracker: GitHub

本仓库的 issue 与开发记录走 **GitHub Issues**，统一用 `gh` CLI；仓库为 `HHpetra/dsh-hk-craft`。仓库里**不设** `spec/` 目录：spec、票据、任务只存在于 issue 里。

## spec 与票据

- **spec**：由 `/to-spec` 从对话直接发布成 issue，用固定模板（Problem / Solution / User Stories / Implementation Decisions / Testing Decisions / Out of Scope），打 `ready-for-agent` 标签。不要落成仓库文件。
- **tickets**：`/to-tickets` 把 spec 拆成 tracer-bullet 子 issue；阻塞关系写成原生依赖（sub-issue / blocked-by）。
- **取票**：只取阻塞项都已关闭的票（frontier）；一票一个会话，只带那张 issue 进上下文。
- **收口**：实现 + review 后关闭 issue；值得长期保留的结论进 `docs/adr/`，issue 不是决策的最终载体。

## 约定

- **新建**：`gh issue create --title "..." --body "..."`；多行正文用 heredoc。
- **读取**：`gh issue view <n> --json number,title,body,labels,comments`
- **列表**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按 `--label` / `--state` 过滤。
- **子 issue**：`gh issue create --parent <parent> ...`，或 `gh issue edit <parent> --add-sub-issue <child>`（gh 2.94+）；旧版用 `gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`。不支持 sub-issue 时，在子 issue 正文顶部写 `Part of #<parent>`。
- **阻塞**：优先用 GitHub 原生 issue 依赖：`gh issue create --blocked-by <n>,<n>` 或 `gh issue edit <child> --add-blocked-by <blocker>`（gh 2.94+）；旧版用 `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`（database id，不是 `#number`）。不可用时退回正文顶部 `Blocked by: #<n>, #<n>`；阻塞项全部关闭即解除。
- **开放阻塞数**：`gh api repos/<owner>/<repo>/issues/<n> --jq .issue_dependencies_summary.blocked_by`（只算 open；0 表示可开工）。`gh issue view <n> --json blockedBy` 含已关闭项，需要过滤。
- **评论**：`gh issue comment <n> --body "..."`
- **标签**：`gh issue edit <n> --add-label "..."` / `--remove-label "..."`
- **关闭**：先用 `gh issue comment` 写清原因，再 `gh issue close <n>`。

`gh` 在 clone 内会自动推断仓库。只往用户自己的仓库建 issue；在 fork 中先 `gh repo view --json nameWithOwner` 确认目标。

## PR 作为请求入口

**PRs as a request surface: no.**（改成 `yes` 后 `/triage` 会把外部 PR 按同样标签与状态处理。）

开启后：`gh pr view <n>` / `--comments` / `gh pr diff <n>` 读取；用 `gh api --paginate 'repos/{owner}/{repo}/pulls?state=open'` 过滤非成员 PR；用 `gh pr comment`、`gh pr edit --add-label`、`gh pr close` 处理。GitHub 的 issue 与 PR 共用一个编号空间，裸 `#42` 先用 `gh pr view 42` 再退回 `gh issue view 42`。

## 当 skill 说“发布到 issue 跟踪器”

新建一个 GitHub issue。

## 当 skill 说“取出相关工单”

按上面的「读取」取。

## Wayfinding（`/wayfinder`）

- **Map**：一个打 `wayfinder:map` 标签的 issue，正文承载 Notes / Decisions-so-far / Fog。
- **Child ticket**：作为 map 的 sub-issue；不支持时放进 map 正文的任务列表并加 `Part of #<map>`。标签 `wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）；认领后 assign 给执行者。
- **阻塞**：见「阻塞」。
- **Frontier**：map 下 open、无开放阻塞、无 assignee 的子 issue，按 map 顺序取第一个。
- **认领**：`gh issue edit <n> --add-assignee @me`。
- **解决**：`gh issue comment <n> --body "<answer>"` → `gh issue close <n>` → 把要点与链接追加到 map 的 Decisions-so-far。
