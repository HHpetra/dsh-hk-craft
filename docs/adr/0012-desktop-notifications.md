# 桌面通知由渲染进程发送，按五类会话信号区分

通知由 `src/client/notifications.js` 在渲染进程用 `new Notification(...)` 发出，不新增 host 服务、路由或 IPC；设置存 origin 级 `localStorage["dsh.hkcraft.notifications.v1"]`。五类信号：审批 / 提问 / 计划审阅来自 `pendingInteraction.kind`，完成来自 `running` 的 true→false，失败来自 `api-session/error`；失败优先于完成，子代理会话不单独通知。点击通知聚焦窗口并切到对应会话，`Notification` 缺失、权限被拒或构造失败时静默降级。

**状态**：accepted
