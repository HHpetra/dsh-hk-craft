# 06: 标签条

**What to build:** 主区域顶部出现一条标签条，横着列出当前工作区**已打开的会话**。点一项就聚焦它所在的窗格；鼠标悬停出现关闭按钮；末尾的 `+` 新开一个会话并新开一格；`Ctrl+1..4` 直接聚焦第 N 格。标签上带状态点，能看出谁在跑、谁在等你。

**Blocked by:** 05

**Status:** resolved

- [x] 标签条列出当前工作区所有已打开的会话，顺序等于布局树的叶子顺序（深度优先、左→右／上→下）
- [x] 点击标签聚焦对应窗格；`Ctrl+1..4` 聚焦第 N 个标签对应的窗格
- [x] 悬停显示关闭按钮，点击关闭该窗格；该格会话正在运行时先弹确认
- [x] `+` 新开一个会话并在聚焦格旁新开一格
- [x] 标签显示状态点，能区分运行中／等待你／出错
- [x] 标签过多时横向滚动，不换行、不压缩到不可读
- [x] `/resume` 的 `Ctrl+Enter` 在聚焦格旁新开一格并打开所选会话（补上 03 欠下的行为）

> 跨票接口：03 的 `/resume`、`/clear` 目前经由"切换当前会话"落地，而那条路径会 `selectPanel(null)`
> ——分屏面板会被关掉。本票必须把这两条命令改接到窗格感知的动作上（替换聚焦格内容 / 新开一格），
> 否则 `/resume` 在多窗格下等于"退出分屏"。

## Comments

- 落点：`tab-strip.js`（纯投影：叶子顺序、标题、状态点、快捷键）+ `pane-view.js`（`TabStrip` 组件，挂进
  `PaneHost` 的 tab strip + pane area 两层盒）+ `dsh-pane-host.js`（`newTab` / `openInNewPane` /
  `requestClosePane` / `focusTab`）+ `commands.js`（`/resume` 的 `onSelect` 接 Ctrl+Enter）+ `index.js`
  （命令面加 `openInNewPane`）。标签就是窗格，没有第二层 tab，也没有任何 per-session 列表。
- **Ctrl+Enter 的接法（新 dsh 假设）**：dsh 的 popupSelect 只按 `Enter` / `Tab` 选中，事件修饰键被忽略
  （`dsh-client-ui-commands/lib/client.js:1913-1939`，`Enter` 分支 1923-1926）；`onSelect(option, context)`
  也不带事件（同文件 1250）。插件无法包住该键盘处理器，所以 `commands.js` 在 document 捕获阶段记录
  Ctrl/Cmd+Enter，`onSelect` 同步 `consume()` 一次；`keyup` 兜底清空，避免漏掉的组合键把下一次普通
  Enter 误判成新开格。若上游以后在 `onSelect` 里给修饰键，删掉 tracker 即可，业务分支不变。
- **标题与状态点（新 dsh 假设）**：使用 root standard hooks `useSessions` / `useSessionStatus`
  （ui-session 提供 `sessions` / `sessionStatus`，`dsh-client-ui-session/lib/client.js:1104-1113`）；
  状态映射是 `Map<sessionId, {running, pendingInteraction, completionUnread}>`（同文件 1120-1126）。
  `waiting` = `pendingInteraction != null`，`running` = status 或 summary 的 `running`；dsh 目前没有失败位，
  `error` 分支只在调用方提供 `errored` 时出现（与侧栏红绿灯的已知缺口一致），状态不参与排序。
- `+` 调 `controller.split(focusedPaneId, 'row')`：会话由 host 既有的 `sessions.create({ workspaceId })`
  路径创建，新格在聚焦格右侧并接管焦点；空布局时退化为开第一格。Ctrl+Enter 用
  `split(..., 'row', { sessionId })`，已打开的会话只聚焦、不重复挂载。
- **关闭保护（接 09）**：标签 × 调 `controller.closePane(paneId)`。空闲格直接关；运行中的格由 09 的
  `requestClose` 暂存 `pendingClose`，由 `PaneCloseConfirm` 弹确认、确认后先 `interruptSession` 再释放窗格，
  取消则回合与窗格都不动。标签条**不另做**确认 UI；合并 09 后删掉了临时 `requestClosePane` + `window.confirm` 方案。
- `Ctrl+1..4` 用 document 捕获监听（焦点在 composer 里也生效），`Ctrl+5+` 与带 Shift/Alt 的组合键忽略；
  只在前四个标签上显示快捷键提示。标签条只在有窗格时挂载，空态仍走原来的 hero。
- 布局树目前只有一棵（"当前工作区"由 08 的 per-workspace store 落实）；本票只做投影，不引入工作区键。
- 溢出：标签在独立的横向滚动视口里，`overflowX: auto` + `nowrap`，标题 `max-width: 128px` 省略号；
  `+` 固定在右侧，不随标签滚走。
- **合并**：`git merge feat/pane-workspace` 到 `258f838`（含 07 视图开关与 09 关格中断）。自动合并
  `commands.js` / `dsh-pane-host.js` / `index.js` / `locale.js`（清掉了与 09 重复的 close 方案）；唯一冲突在
  `pane-view.js` 的 `PaneHost` 返回结构（07 的 Fragment + 关闭对话框 vs 本票的 workspace 盒）与导出表——
  保留 07 的 `PaneCloseConfirm` 对话框，把 tab strip + pane area 收进 workspace 盒。
- 已跑（本 worktree，合并后）：`pnpm build` 15 modules / 117.7 kB；`node --test --test-isolation=none`
  234 项通过；`node scripts/check-bundle.mjs` 29/29。
- **待人工验证**（装到 desktop → 重启 dsh）：
  1. 开 2–4 个窗格：标签顺序与布局左→右／上→下一致；点击标签，窗格描边与标签高亮一起移动。
  2. `Ctrl+1..4` 从 composer 里按也能聚焦；`Ctrl+5` 无反应。
  3. 悬停标签出现 ×；空闲窗格直接关；运行中的窗格先弹确认，取消后窗格与回合都还在。
  4. `+` 在聚焦格右侧新建会话并聚焦新格，中央面板不退回原生对话。
  5. `/resume` Enter 替换聚焦格；Ctrl+Enter 在右侧新开一格；两种都不退出分屏。
  6. 标签多到溢出时横向滚动、不换行、标题省略；运行中/等待你的状态点分别变黄/红，标签顺序不变。
  7. 页脚 "分屏窗格 / 原生视图" 切换仍然可用，切回原生后标签条消失、再切回布局与标签还在。
