# 05: 布局树：分割、关闭、焦点、比例

**What to build:** 一个工作区里可以把对话摆成任意的横竖嵌套布局。用户对某一格执行「向右分割」或「向下分割」，就在旁边开出一格并立即开一个新会话；关闭一格时它的兄弟节点顶替父节点的位置；正在输入的那一格有可见的焦点描边；分隔条可拖动且每格不会被拖到不可用。

**Blocked by:** 04

**Status:** resolved

- [x] 支持横向与纵向任意嵌套分割（不是固定网格，也不是三档固定模式）
- [x] 分割出的新格立即拥有一个新会话，可直接发消息
- [x] 关闭一格后结构归一：兄弟顶替父节点位置，不留空白格；焦点移到邻近格
- [x] 焦点格有清晰描边；点击窗格任意处即聚焦
- [x] 焦点切换后，dsh 认知的「当前会话」跟着变成该格的会话（不出现两个当前会话）
- [x] 分隔比例可拖动，每格有最小尺寸限制，拖动后不塌陷
- [x] 窗格内容在布局变化时不卸载（流式输出、滚动位置、输入草稿不丢）

状态形状以 spec 第 4.1 节为准，实现时保持这个类型形态（决策密集部分，勿改语义）：

```ts
type LayoutNode =
  | { kind: "leaf"; paneId: string }
  | { kind: "split"; dir: "row" | "col"; ratio: number; a: LayoutNode; b: LayoutNode };
```

## Comments

**落了什么**

- `src/client/layout-tree.js`：纯布局树（无 React / 无 dsh）：`createLayout`、`openPane`、`split`、`close`、
  `leaves`（深度优先、左→右 / 上→下）、`findLeafPath`、`focus`、`replaceSession`、`setView`、`paneOfSession`、
  `resize(path, ratio)`、`clampRatio` / `minRatioFor` / `ratioFromDrag`、`normalizeLayout`（解码 / 剪枝 / 修焦点）。
  所有变换不可变；无变化的变换返回同一对象。
- `src/client/layout-geometry.js`：把树投影成**扁平**的分数矩形 + 分隔条（`computeLayout`）。窗格是布局容器的
  绝对定位兄弟节点、按 `paneId` 做 key，所以分割 / 关闭只改 inline style，React 永不重新挂载某个窗格
  （这是"布局变化不丢流式 / 滚动 / 草稿"的实现机制）。分隔条额外带 `extent`（该 split 自身的尺寸），
  拖拽时按 split 而非整个工作区做像素级最小尺寸夹紧。
- `src/client/dsh-pane-host.js`：`createPaneController` 从单窗格升级为多窗格宿主。每个窗格一条
  `sessions.retain(id, {source:"hkcraftPane"})`；**只有**焦点窗格额外持有 `source:"mainView"`。焦点切换 =
  先释放旧 `mainView` 再取新的；关闭 / 换会话 / 收回面板 / 卸载都会释放对应引用。`reconcile()` 是唯一的引用
  对账点，`apply()` 失败会回滚到上一棵布局（分割 / 换会话因此是原子的）。
- `src/client/pane-view.js`：扁平窗格渲染、焦点描边（2px outline，`data-hkcraft-pane-active`）、每格
  `向右 / 向下 / 关闭` 头按钮、手写分隔条（8px 命中区 / 2px 可见线、pointer capture、`touch-action:none`）、
  空态（`.scratch` 里的 spec 5 节 "空态 hero" 的 v1 形态：说明 + 新会话）。
- `src/client/commands.js` + `index.js`：`/resume` 与 `/clear` 在窗格面板显示时改走窗格宿主
  （`replaceFocused` / `newConversation`），不再经 `uiWorkspace` 的 reveal 路径。
- `src/client/locale.js`：新增 `pane.close`、`pane.splitRight`、`pane.splitDown`、`pane.empty.workspace.*`、`pane.empty.new`（zh/en 同键）。

**新做的 dsh 假设（均已标在 `dsh-pane-host.js` 头注释）**

1. `sessions.create({workspaceId})` 解析为会话 id，且在解析前已发布会话目录行（`dsh-api-session-controller/lib/client.js:3965-3977`）。
   用它新建会话不会切主视图；原生 `uiWorkspace.startSession` 走 `replaceMain(..., "reveal")` →
   `selectPanel(null)`（`dsh-client-ui-workspace/lib/client.js:1500-1530, 1652-1676`），所以窗格宿主绝不调用它。
2. 面板激活期间 shell 自己会把"当前会话"的消费者按 `activePanelId !== null` 关掉：侧栏行不再高亮 mainView 行
   （ui-workspace:3026-3028, 3357, 3463），rename/fork 快捷键被挡（ui-workspace:143-148）。插件没有公开 API 能在
   不 reveal 的情况下释放原生 `uiWorkspace.mainReference`，因此只能保证**自己**的 mainView 引用唯一（焦点格一条）。
   真实 shell 里若原生引用仍存在，属于运行时冒烟要看的点（见下）。
3. 工作区归属仍用 `workspaces.list` 快照（`dsh-sessions.js:workspaceIdOf`）推导；没有任何已打开会话时，
   "第一个工作区"作为兜底（host 顺序，与侧栏一致），否则 `/clear` 与空态按钮会无事可做。ticket 08 会用真正的
   按工作区布局替换这个兜底。

**行为取舍（已记录，供 06-09 复查）**

- 关闭规则：兄弟子树整体顶替父节点位置；焦点移到"被关闭格原本位置上的邻格"（关闭 a → 兄弟子树 first leaf，
  关闭 b → last leaf），不是简单取渲染序下一个。
- 同一会话不会被挂进两个窗格：`split({sessionId})` / `replaceFocusedSession` 遇到已打开的会话就聚焦已有窗格。
- 分割失败（新建会话失败 / retain 失败 / 主视图取不到）整笔回滚，不留下半成品窗格；已经建出来的空白会话留在
  历史里（可 `/resume` 找回），不做删除。
- `/clear` 在窗格面板显示时总是留在窗格内（含空态），即使没有聚焦格——这正是本票要修的"命令把分屏关掉"。
  `/resume` 只在有聚焦格时走窗格；窗格面板空态下的选择仍回原生（ticket 06 的空态 hero 会补上）。

**验证**

- `cd packages/dsh-hk-craft; node --test --test-isolation=none`：**189 passed / 0 failed**
  （本票新增：layout-tree 32、layout-geometry 8、pane-host 由 17→38、commands 由 8→13）。
- `pnpm build`（worktree 内）：13 modules、84.0 kB、id=`dsh-hk-craft`。`node scripts\check-bundle.mjs`：29 项全过。

**留给后续票的接缝（明确点名的入口）**

- 06 标签条 / `Ctrl+Enter` / `+`：`controller.split(paneId, dir, {sessionId})`（带显式会话即"在聚焦格旁打开已有会话"，
  不会重复挂载）；`leaves(root)` 给标签顺序；`focusPane` / `closePane` / `paneOfSession` 已就绪。
  `commands.js` 的 `/resume` `onSelect` 是 Ctrl+Enter 分支的唯一落点。
- 07 视图开关：`layout.panes[id].view` 与 `controller.setView(paneId, view)` 已就绪；还缺的是
  `uiConversation.binding(sessionId).activate(viewId)` 适配 + 隐藏原生按钮条（作用域 CSS，G4）。
- 08 工作区隔离 / 持久化：`normalizeLayout` 是解码入口；`createPaneController(ctx, {nextPaneId})` 让恢复的 pane id
  可注入（已避开与现存 id 冲突）；把单棵 `layoutState` 换成按 `workspaceId` 的 Map，并替换
  `focusedWorkspaceId()` 的"第一个工作区"兜底。
- 09 关闭即中断：`closePane(paneId)` 目前只做结构与引用；确认框 + 中断 API（G2）应在调用它之前。
- 10 打磨：`swap(a, b)`（拖拽交换）与标签条状态点未实现；焦点描边已就位。

**待人工验证**（装到 desktop → 重启 dsh）

1. 侧栏底部「分屏窗格」→ 一格对话；点该格右上 `⫽` 向右分割、`⫙` 向下分割；每格立即能发消息。
2. 在 A 格发一条长回复，回复流式输出时在 B 格分割 / 关闭一格：A 格的流式输出、滚动位置、输入草稿都不丢。
3. 点 B 格任意处：B 格出现描边，A 格描边消失；此时侧栏/快捷键认知的"当前会话"应跟随 B（若出现两个当前会话，
   记录原生 mainReference 的影响，见假设 2）。
4. 拖动分隔条：能连续改变比例；拖到极端时两格都不会小于约 120px；重启后（08 未做，暂不验）比例不丢。
5. 关闭全部窗格 → 空态；点「新会话」应能开回第一格。
6. `/clear` 与 `/resume` 各执行一次：面板不退出、其余窗格不动、被替换的格内容换成新/选中的会话。
7. 点「原生视图」再点回「分屏窗格」：布局与焦点仍在，会话不重新创建。
