# 桌面通知由渲染进程发送，按五类会话信号区分

通知由 `src/client/notifications.js` 在渲染进程用 `new Notification(...)` 发出，不新增 host 服务、路由或 IPC；设置存 origin 级 `localStorage["dsh.hkcraft.notifications.v1"]`。五类信号：审批 / 提问 / 计划审阅来自 `pendingInteraction.kind`，完成来自 `running` 的 true→false，失败来自 `api-session/error`；失败优先于完成，子代理会话不单独通知。点击通知切到对应会话（Windows 上不保证聚焦窗口，见下），`Notification` 缺失、权限被拒或构造失败时静默降级。

**Windows 平台限制（Desktop 0.2.2-rc.1）**：点击通知只切到对应会话，不保证把 Electron 窗口提到前台；渲染进程的 `window.focus()` 不能提升顶层窗口，且 dsh 未向渲染进程暴露主进程的聚焦 IPC。需要前台时由用户点任务栏或托盘。

**状态**：accepted
