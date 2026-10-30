# 09: 关闭窗格即中断会话

**What to build:** 关闭一个窗格时，如果里面的会话正在跑，先确认再中断它并把会话释放掉；会话本身不会消失，历史还在，之后可以经 `/resume` 重新拉回某个窗格。取消关闭则什么都不发生。

**Blocked by:** 05

**Status:** resolved

- [x] 先查清插件侧可用的中断入口（spec 第 12 节 G2），把结论写进本票 Comments，再动手实现
- [x] 关闭正在运行的窗格：弹出确认，文案说明「会话将被中断并保留在历史中」
- [x] 确认后回合被真正中断（不是仅停止刷新），无孤儿流、无重复订阅
- [x] 取消关闭：会话继续运行，窗格不受影响
- [x] 关闭空闲窗格不弹确认，直接关闭
- [x] 被关闭的会话随后可从 `/resume` 重新打开并继续对话

## Comments

### G2 结论（2026-10-30，代码级核查；先于实现记录）

**A 档：公开、插件可达的中断入口存在。** 没有"关闭会话让宿主 agent 停下"的公开 API；正确语义是**两步**——先中断当前回合，再释放窗格持有的引用。

1. **中断入口（与壳的 stop 按钮同一条路）**：`ctx.sessions.scope(sessionId).get("conversation").cancel()`。
   - 壳的 stop 按钮：`scopedConversation(sessions, sessionId).cancel()` ——
     `dsh-client-ui-conversation/lib/client.js:19808-19810`。
   - 该 helper 的实现：`sessions.scope(id).get("conversation")` ——
     同文件 `19674-19680`。
   - `cancel()` 的实现：`this.scopedSession("cancel").cancel()`，失败时抛出并带错误码 ——
     同文件 `4940-4942`；`scopedSession` 落在 `sessions.binding(id).session` ——
     同文件 `4949-4953`。
   - 最终到宿主 RPC `remote.session.cancel({ sessionId })`（子代理地址走
     `subagents.interruptByParent`）—— `dsh-api-session-controller/lib/client.js:2429-2440`；
     类型声明见 `dsh-api-session-controller/lib/types/client/sessions/session.js:257-267`。
   - 跨 bundle 使用 `sessions.scope`/`sessions.binding` 本身就是壳自己的做法（ui-conversation
     与 ui-commands 都这么调），所以对插件是公开可达的；`binding(id)` 的公开声明见
     `dsh-api-session-controller/lib/types/client/sessions/service.js:412-414`。
2. **"释放会话"不会停宿主 agent**：`reference.release()` 只撤掉客户端 generation
   （本地会话数据、scoped context、历史流），**不保活也不杀死 Host Agent** ——
   `dsh-api-session-controller/README.md:82`（"References keep local Session data, scoped
   Contexts, and history streams alive, not Host Agents."）。因此关窗格不能靠 release 停回合。
3. **会话历史不受影响**：cancel 只停回合（宿主保留 pending inbox），release 只清客户端引用；
   两者都不删除磁盘上的会话，所以关闭后仍会出现在 `sessionController.list()` / `/resume` 中。

**实现决定**：适配层优先走 stop 按钮的 `scope(...).get("conversation").cancel()`，缺该服务时回退到
`sessions.binding(id).session.cancel()`（同一底层调用，需把 `{ok:false}` 归一为异常）；两者都不可用
时报"没有公开中断入口"。关闭 = 中断成功后释放该窗格的两个引用（pane + 可能的 mainView）。

### 实现与验证（2026-10-30）

- 适配层：`dsh-pane-host.js:interruptSession`；控制器新增 `pendingClose / closeBusy / closeError`
  与 `confirmClose()` / `cancelClose()`，`closePane()` 变为"请求关闭"：空闲立即关，运行中只挂起确认。
- 确认界面由 `pane-view.js:PaneCloseConfirm` 渲染（`shell.overlay` 未新增注册），文案
  「会话将被中断并保留在历史中」；中断失败时窗格保持挂载、引用不释放、错误显示在对话框内，可重试。
- 单测覆盖：空闲直接关；运行中先挂起且不动会话；取消无副作用；确认只中断一次、再释放；
  第二次确认被忽略；中断失败保持窗格与引用并可重试；release 后列表行仍在（`/resume` 数据未被删）。
- 共享文件：`dsh-pane-host.js`、`pane-view.js`、`locale.js`（与 06/07/08 相邻，冲突点集中在这三处）。
- 待人工验证（无 dsh 运行时，未做真实 UI 冒烟）：真实壳里 stop 路径的 `conversation` 服务是否按预期
  解析、对话框在真实布局中的视觉位置、以及关闭后从 `/resume` 拉回同一会话继续对话。
