# 插件重挂载恢复自己的视图，不跟随旧的原生 current

`activate()` 不带 session 时先按记住的可见工作区恢复该工作区的布局；焦点窗格已有会话时焦点就是目标，`catalog.current()` 只在该工作区没有已恢复窗格时兜底。新增插件自有键 `dsh.hkcraft.active-workspace.v1` 记住可见工作区，它只是提示：读取时先对照目录验证，目录已就绪而工作区不存在则连同布局键一起清掉。`settleBootWorkspace` 在树已恢复且仍有焦点时直接落地，不再用 `focusOrOpenWorkspaceConversation` 把焦点换成最近一段旧对话；挂载完成之后，原生 current 仍按 `syncCurrent` 跟到焦点窗格。

**状态**：accepted
