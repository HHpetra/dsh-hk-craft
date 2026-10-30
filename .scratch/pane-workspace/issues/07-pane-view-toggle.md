# 07: 窗格视图开关（对话 / 轨迹）

**What to build:** 每个窗格的右上角出现一个「对话 | 轨迹」分段开关，点一下就切换该格显示的内容，另一格不受影响。原生那排「对话／轨迹」大按钮不再重复出现。

**Blocked by:** 05

**Status:** resolved

- [x] 每个窗格都有独立的分段开关，切换即时生效
- [x] 视图选择按窗格记忆：两格可以一格看对话、一格看轨迹，互不影响
- [x] 原生对话标题区那排视图按钮不再出现在窗格内
- [x] 轨迹视图不可用时（开发者工具关闭），开关相应禁用，行为与原生过滤一致
- [x] 切换视图不重建会话、不丢滚动位置与草稿

## Comments

**落了什么**

- `src/client/dsh-view-switch.js`（新）：唯一的对话 View 适配层。`activate(sessionId, viewId)` 走公开的
  `ctx.uiConversation.binding(sessionId).activate(viewId)`，对未知 / 非活动会话返回 `{ok:false,error}` 而不抛；
  `isTrajectoryAvailable()` / `subscribeAvailability()` 镜像 dsh 的开发者工具门；`effectiveView` / `viewSegments`
  是纯函数（轨迹不可用时显示为对话，并把轨迹段标成 disabled）。
- `src/client/dsh-pane-host.js`：`createPaneController(ctx, {viewSwitch})`。`setView(paneId, view)` 现在是
  “驱动 + 记忆”：先经适配层切真实 View，再写 `panes[paneId].view`；轨迹不可用时直接拒绝（不落一个不可达的选择）。
  新增 `restoreViewFor(sessionId)`（面板 mount 后按窗格记忆重新激活）与 `isTrajectoryAvailable` /
  `subscribeViewAvailability`；开发者工具重新开启时，把记住轨迹的窗格重新激活。视图切换只动 `view` 字段，
  不 retain / release、不换会话、不动树与焦点（有测试断言引用对象不变）。
- `src/client/pane-view.js`：窗格头新增 `PaneViewSwitch`（`role="group"` + 两段 `role="radio"`，紧凑分段样式，
  选中段有底色），位于标题与分割 / 关闭按钮之间；`PaneBody` 在会话就绪后 `restoreViewFor(sessionId)`。
- `src/client/locale.js`：`pane.view.title` / `pane.view.chat` / `pane.view.trajectory` /
  `pane.view.trajectoryDisabled`（zh/en 同键）。
- `src/client/index.js`：`createPaneController(ctx, { viewSwitch: createViewSwitch(ctx) })`。

**核实的关键证据（extract：`.scratch/_tmp/client/dsh-client-ui-conversation/lib/client.js`）**

1. **原生那排按钮为什么不出现**：`role="tablist"` 在 `ConversationSessionHeader`（18136-18255）；该组件注册进
   `conversation.session.header`（20038-20091），而 `conversation.session.header` 是 `ConversationHeader`
   （17962-17974）渲染的、`conversation.header` 的子槽；`conversation.header` 是 `main.conversation` 注册时声明的
   子槽（19929-19935）。窗格的 `main` 条目只声明 `hkcraft.pane` 子槽并只渲染 `conversation.content` factory，
   从不渲染 `conversation.header`，因此标题区和那排按钮在窗格内**根本不挂载**。未加任何隐藏用 CSS。
   `showTabs = !hideChrome && tabs.length > 1`（18142）只是原生头内部的额外条件。
2. **轨迹可用性规则**：`viewTabs()` 在 `!ctx.configForms.developerTools.enabled.getSnapshot()` 时跳过
   `id === "trajectory"` 的条目（19753-19758），并订阅该 store 重算（19798-19807）；`DeveloperToolsPreference`
   读 `value?.enabled ?? false`（ui-settings:1032-1052），即宿主值到达前为 false。适配层逐条照抄。
3. **切换不动会话**：原生 tab 点击 `selectView` → `activateView` → `binding.activate(id)`（19766-19768,
   20086-20089）。插件调用同一个方法，但**不写** dsh 自己的 per-session 偏好（记忆归布局树）。

**假设 / 取舍（供 08-10 复查）**

- 轨迹不可用时按本票写“禁用 + tooltip”，spec §6 写“不出现”；以票为准（两者都是 dsh 过滤的等价表达）。
- 窗格记忆要压过 dsh 的 per-session localStorage 偏好：`PaneBody` 在 `session !== undefined` 后调用
  `restoreViewFor`。假设 dsh 的 `restoreView`（在 `uiSession.provide` 的 resolve 阶段，19912-19927）早于子组件
  effect，所以我们的激活在后、生效。若实测被覆盖，改成在会话快照就绪后再断言一次即可（单点修改）。
- 没有适配层（缺 `uiConversation` / `configForms`）时窗格照常挂载、只保留对话段；不因此让整个插件不 apply。
- 开发者工具关闭时 dsh 自己会把 tracked binding 回退到 chat（`refreshViews` → `restoreView`）；插件不重复写布局，
  只保留 `pane.view` 的记忆，重新开启时恢复。

**验证**

- `cd packages/dsh-hk-craft; node --test --test-isolation=none`：**202 passed / 0 failed**
  （本票新增 13：`dsh-view-switch` 8，`dsh-pane-host` 5；另把原有 view 测试改成带适配层的断言）。
- `pnpm build`：14 modules、94.0 kB、id=`dsh-hk-craft`；`node scripts\check-bundle.mjs`：29/29。

**待人工验证（安装进 desktop 后）**

- 两格分别切到对话 / 轨迹，内容互不影响；原生那排大按钮在窗格内确实不出现。
- 轨迹视图下输入草稿、切回对话后草稿与聊天滚动位置仍在；流式输出不中断。
- 设置里关闭“显示代码工作视图”后轨迹段变灰、hover 有 tooltip；重新开启后记住轨迹的窗格自动回到轨迹。
- 关掉面板再切回窗格（同一次运行内）时，每格仍显示各自记忆的视图。
