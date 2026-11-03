# 标签条使用原生右侧栏工具图标

工具图标来自 `ctx.sidebarRightTabs.guide()`，按注册表顺序画在标签条滚动区外，点击调用 `ctx.sidebarRight.openTab(kind)`，与 dsh 引导页卡片走同一条路径。展开图标只在右栏收起时出现，调用 `toggleExpanded()`；右栏已展开时收起仍由右栏自己的折叠按钮负责。两个服务都可选且都不进顶层 `inject`：缺 `sidebarRight` 时整组不渲染，缺注册表时只留展开图标。

**状态**：accepted
