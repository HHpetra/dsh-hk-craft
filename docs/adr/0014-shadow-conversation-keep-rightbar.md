# shadow `conversation`，保留原生右侧栏

在 `main` 槽注册 `key: "conversation"`、`priority: -1` 的 shadow，全程不调用 `ctx.layout.selectPanel`，让 `activePanelId` 保持 `null`，右侧栏因此保持可见并跟随焦点窗格的 `mainView`。焦点窗格继续持有 `mainView`，标签条用 `ctx.sidebarRight.toggleExpanded()` 补一个右栏开关（后由 ADR-0015 换成原生工具图标）。v1 只剩一个窗格时仍显示插件窗格、不渲染原生 header / lineage；卸载 shadow 后官方 `ConversationPanel` 自动赢回该格。

**状态**：accepted
