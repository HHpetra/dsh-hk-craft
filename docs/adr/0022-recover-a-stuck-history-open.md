# 窗格自己重开卡住的历史，等宿主给不了就有限放弃

宿主把 `Session.openState` 置为 `"loading"` 后，只有“打开成功”和“RPC 级失败”两条出口；传输层失败（流载体被替换、WebSocket 在 open 前被拒或关闭、心跳判死）会被 `doOpen` 原样抛出，`finally` 只通知不落地状态，于是该会话在本代客户端里永远停在 `"loading"`，对话区一直显示“载入历史…”。插件重启时会把每个已加载工作区的窗格一次性 retain，正好撞上启动阶段载体最不稳定的时刻，所以“默认打开的那个工作区”最容易中招；切换一次工作区（新的一代客户端）反而正常。

决定：窗格内核自己修复，不等上游。`pane-open-recovery.js` 只给策略（停滞窗口、重试预算），内核按窗格读取 `reference.binding.session.openState`，对已失败的 open 用一次“额外的 retain 再立刻 release”触发宿主自己的 `Session.open()`（引用数净不变，不会把会话拆到 0 代）；对仍在飞行、可能永不应答的 open 调 `Session.resync()` 一次；每个会话的预算用尽后放弃，直到该会话被替换。读 `openState` 是轮询，因为宿主不为这个状态发事件，所以只在有窗格需要时持有一个 `unref` 定时器。

**后果**：插件在“宿主已放弃的状态”上多花最多几次 retain/resync；代价有界，且失败时行为与不修一样（窗格仍是载入历史…，可关掉重开）。`resync()` 与 `openPromise` 都不在公开文档的服务面上，属于和 `binding.session.eventSource` 同级的“宿主实现细节”，升级 dsh 时必须按 [Session history open](../upstream-contracts.md#session-history-open-openstate) 复验。

**状态**：accepted
