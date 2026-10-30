# 04: 单窗格挂载（分屏地基）

**What to build:** 主区域不再由 dsh 原生的单会话视图独占，而是可以被插件接管：接管后显示一个窗格，里面是**指定会话**的完整可交互对话——能发消息、能看到流式回复、能用停止按钮。同时必须能一键切回 dsh 原生界面，且原生界面行为不受影响。

**Blocked by:** 01

**Status:** resolved

- [x] 插件能激活自己的主区域面板，在其中为某个明确指定的会话渲染完整对话（不是只读快照）
- [ ] 在该窗格内发消息能正常得到回复；流式输出正常；停止按钮可用（待人工）
- [x] 可切回 dsh 原生对话视图，原生视图的一切行为与未装插件时一致
- [x] 启动时对 `conversation.content` 这个 Factory 做特性探测；缺失时退化为「单对话 + 明确提示」，不出现白屏或静默失败
- [x] 同一会话在同一时刻不会被挂载两次（不与原生视图并存）
- [x] 面板注销（如卸载插件）后自动回到原生视图，不需要手工清理

## Comments

- 挂载路径按 spec §1 实现：注册 `main` 键控槽条目 `hkcraft.panes`（声明 `hkcraft.pane` 子槽，`scope: "session"`），
  用 `ctx.layout.selectPanel("hkcraft.panes")` 激活、`selectPanel(null)` 切回；主区域渲染键因此从原生 `conversation` 切走，不会双挂。
- 窗格内容：`ctx.sessions.retain(sessionId, { source: "hkcraftPane" })` → `SessionProvider` → `renderSlot("hkcraft.pane")`
  → `renderFactorySlot("conversation.content", { variant: "main", phase, hero })`。`phase`/`hero` 复用原生推导。
- 目标会话由 footer 的可见切换按钮在激活时显式捕获：默认取 dsh 当前会话（`retainedBy.mainView > 0` 的第一行），
  controller 也接受显式 `activate(sessionId)`。没有当前会话时窗格显示「未选择会话」，可一键回原生。
- 特性探测走 `ctx.slots.snapshot("factory:conversation.content")`；缺失、抛错、或渲染期 Factory 崩溃
  （`ctx.slots.onEntryError` 的 `factory:conversation.content`）都显示带原因与返回按钮的降级面。
  窗格整棵子树与 Factory 各自套 ErrorBoundary。
- 引用释放：切回原生、外部把 `activePanelId` 切走（含面板注销时 `retainMainPanels` 复位）、插件卸载都会 `release()`；
  controller 用 sessionId → reference 的 Map，保证同一会话只 retain 一次。
- 交付文件：`src/client/dsh-pane-host.js`（纯适配/状态，集中全部 dsh 假设）、`src/client/pane-view.js`（薄 React）、
  `src/client/index.js`（注册/装配）。测试用 fake ctx/slots kit 覆盖探测、保留、释放、外部切回、崩溃监督。
- 已跑（merge feat/pane-workspace 后）：`node --test --test-isolation=none` 68 项通过；esbuild 产出 `lib/client.js`
  约 38.6 kB；`check-bundle` 29 项通过。
- 合入 ticket 02 与 esbuild 构建切换后，`src/client/index.js` 同时负责 `sidebar.workspaces` 覆盖与本票的主区域窗格；
  footer 保留诊断与「分屏窗格」两个动作，`inject` 增补 `sessions`/`layout`。
- 本子会话的沙箱仍禁止 Node 的管道子进程，`scripts/build-client.mjs` 的 esbuild JS API 会 `spawn EPERM`；
  已用等价的 esbuild CLI（`stdio: inherit`）产出同一 `lib/client.js` 并通过 `check-bundle`。全权限环境可直接跑脚本。
- **待人工验证**：安装到 desktop → 打开一个会话 → 点侧栏底部「分屏窗格」→ 发消息/看流式/点停止 → 点「原生视图」；
  再卸载插件重启，确认主区域回原生且无残留。
