# 清单读取收成一个只读视图，就绪口径统一为一条

`catalog.js` 是唯一解析 `sessions.list`、`workspaces.list` 与状态映射的地方，只回答领域问题；`openCatalog` 无订阅、无生命周期、不碰 `ctx`，同一组快照永远返回同一个对象，`readCatalogs` 是唯一知道客户端服务名的函数。就绪口径只有 `phaseReady`：缺 `phase` 算就绪，`pending` / `loading` 不算；只有 `complete()` 为真时才允许把「目录里没有这个会话」当成会话已消失。状态合并进 `signal(id)`（`running` / `started` / `waiting` / `unread`），五态灯规则仍留在 `workspace-status.js`，动作适配留在 `dsh-sessions.js` 与 `dsh-workspaces.js`。

**状态**：accepted
