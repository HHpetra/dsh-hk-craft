# dsh 分屏插件调研：右侧边栏、主区接管方式与可借鉴设计

- **调研对象**：本插件（`dsh-hk-craft`）、dsh Desktop `0.2.1-rc.5`（安装版）、dsh `0.2.2-alpha.2` 源码 checkout，以及 GitHub 上可找到的 dsh 分屏/侧聊插件。
- **调研方式**：读本仓库分屏代码、上游 `@deepseek-ai/dsh-client-ui-*` 源码、其他插件的 README / 架构文档 / 客户端 bundle。只调研，不修改代码。
- **结论时效**：上游插件 API 仍在演进；本文的上游判断以 `0.2.1-rc.5` 的安装包契约为准，并用 `0.2.2-alpha.2` 源码复核了关键分支。

---

## 0. 结论（TL;DR）

1. **右侧边栏不是被“保留”出来的，而是默认就开着。** 上游只用一个条件决定它是否可见：

   ```text
   panelInfo.activePanelId === null
   ```

   只要分屏插件把 `activePanelId` 改成非 `null`，原生右侧栏就会隐藏，`ctx.sidebarRight` 也会失去“屏上会话”。

2. **本插件当前正好踩在这个条件上。** 它注册了一个新的 `main` key（`hkcraft.panes`）并调用 `ctx.layout.selectPanel('hkcraft.panes')`，所以 `activePanelId` 变成非 `null`。右侧栏消失不是实现细节差异，而是**接管位置**差异。

3. **其他分屏插件能保留右栏，是因为它们没有换 `main` key：**

   - **shadow `main` 的 `conversation` key**（`lehhair/dsh-split-panes`）：`activePanelId` 始终是 `null`，官方 `ConversationPanel` 被同 key、更低 `priority` 的条目遮住。
   - **`shell.overlay` 浮层**（`mhlywxl/dsh-split-workspace`、`yuloop/dsh-web-split` 的开发版、`Mintcolour/dsh-sidechat`）：原生会话面板继续挂着，窗格浮在它上面。
   - **把窗格放进右栏本身**（`WTPieh/dsh-split-screen`）：用 `sidebarRightTabs` + dockkit，右栏就是分屏容器，当然保留。
   - **只做侧聊抽屉 / 自定义右栏**（sidechat、sidecar、better-sidebar）：不碰主区或接管右栏，属于另一类产品形态。

4. **这些插件还共同做对了一件事：焦点窗格持有 `mainView` retention。** dsh 的“当前会话”是推导出来的：会话列表里第一个 `retainedBy.mainView > 0` 的行。只有焦点窗格持有它，右侧栏、文件链接、侧栏高亮才会跟着焦点走。

5. **对本插件，最小可行的重设计是“shadow `conversation` + 现有 per-pane `conversation.content`”**：不换 key、不 `selectPanel`，右栏自然回来；每个窗格仍然用官方 Factory 渲染完整对话。代价是窗格头部继续由插件自建，不渲染原生 header / lineage / hero。

6. 如果**必须**保留原生 header / lineage / 文件链接的完整原生表面，选 `shell.overlay`；如果只想加一个并排会话且完全不想碰主区，选“右栏原生 tab”。不建议继续走“新 main key 面板 + 自建右栏”。

---

## 1. 本插件现状与根因

### 1.1 接管路径

当前实现（`packages/dsh-hk-craft/src/client/`）：

- `index.js` 在 `main` 键控槽注册 `key: 'hkcraft.panes'`，声明一个 `scope: 'session'` 的子槽 `hkcraft.pane`。
- `dsh-pane-host.js` 的 `activate()` 调用 `ctx.layout.selectPanel('hkcraft.panes')`，把主区域切到插件面板。
- `pane-view.js` 渲染标签条 + 窗格网格；每个窗格：

  ```text
  <SessionProvider session={reference}>
    renderSlot('hkcraft.pane')
      → createPaneBody → renderFactorySlot('conversation.content', { variant: 'embedded' })
  ```

- 焦点窗格额外持有 `mainView` retention，其他窗格持有 `hkcraftPane` retention。
- 左侧栏的 `sidebar.workspaces` 被低 priority 条目替换成精简工作区列表。

这套分屏本身是成立的：per-pane `conversation.content` 能拿到真实 transcript、工具调用、composer、审批等；`mainView` 让 dsh 的“当前会话”跟着焦点走。

### 1.2 右侧边栏消失的完整链条

上游源码（以 `0.2.2-alpha.2` 复核，`0.2.1-rc.5` 行为一致）：

1. **`AppFrame` 只渲染当前 main key**

   `packages/client/ui-layout/src/client/AppFrame.tsx`：

   ```tsx
   const panelId = usePanelInfo(info => info.activePanelId)
   renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })
   ```

   所以 `selectPanel('hkcraft.panes')` 会把 `conversation` 换成插件面板。

2. **右栏 occupant 用同一个 `activePanelId` 决定可见性**

   `packages/client/ui-sidebar-right/src/client/shell/RightbarRoot.tsx`：

   ```tsx
   const visible = usePanelInfo(info => info.activePanelId === null)
   ```

   `visible === false` 时，所有 `SessionView` 都被 `hidden`。

3. **右栏服务只把“屏上会话”交给控制器**

   `packages/client/ui-sidebar-right/src/client/index.ts`：

   ```ts
   show(layout.panelInfo.getSnapshot().activePanelId === null ? selected?.sessionId : undefined)
   ```

   面板激活时 `onScreen` 变成 `undefined`。

4. **写操作要求“屏上会话 + 已 adopt 的 store”**

   `service.ts` 的 `require()`：

   ```ts
   const sessionId = this.mounted.getSnapshot()
   const actions = sessionId === undefined ? undefined : this.actionsFor(sessionId)
   if (sessionId === undefined || actions === undefined) {
     throw new Error('sidebarRight: no session surface is mounted')
   }
   ```

   所以文件链接、`openResource` 等写操作会直接抛错。

5. **`mainView` 救不了它**

   `mainView` 只影响“当前会话”的推导（`uiSession.adapter.current`），不影响 `activePanelId` 这个开关。本插件虽然让焦点窗格持有 `mainView`，但右栏在第一步就被 `activePanelId !== null` 关掉了。

### 1.3 连带损失

把主区域换成新 key 之后，除了右栏，还有几处原生能力一起消失：

- **原生会话 header**：面包屑、View 标签、会话操作、子代理 lineage、右栏展开按钮都不再挂载。本插件用自建窗格头部补了模式徽章、子代理查看、视图切换和关闭，但不是原生 header。
- **文件/图片链接**：走 `sidebarRight.require()`，在面板模式下会报 `no session surface is mounted`。
- **原生“揭示会话”**：`uiWorkspace.openSession` / `startSession` 最终会 `selectPanel(null)`，把插件面板卸载。本插件只能绕开这些路径（用 `sessions.create`、`paneController.openInNewPane` 等）。
- **公开的“为某个会话打开右栏”**：`ctx.sidebarRight` 没有这样的方法；它只对“屏上会话”操作。

### 1.4 关键认识

本插件的问题不是“没有把右侧栏渲染出来”，而是**选择了会关闭右侧栏的主区接管方式**。只要继续保持新 `main` key + `selectPanel`，右栏就只能靠替换/自建，无法保留原生右栏。要保留，必须换接管位置，或者把窗格放进右栏。

---

## 2. 上游契约：右栏、当前会话与接管位置

### 2.1 `main` 是键控槽，`conversation` 是保留 key

`ui-layout` 的 `main` 是 `keyed` root slot。`conversation` 是官方保留 key，默认在 `activePanelId === null` 时渲染；其他 key 用于全局面板（插件页、设置页等），并且**不接收 Session binding**。

`ctx.layout.selectPanel(id)` 的语义：

- `selectPanel(null)`：回到 `conversation`，`activePanelId` 为 `null`。
- `selectPanel('conversation')`：**不是**回到 null，而是显式选中 `conversation`，`activePanelId` 变成 `'conversation'`，右栏仍然会隐藏。
- `selectPanel('hkcraft.panes')`：选中插件面板，右栏隐藏。

> 这一点很容易误判：Shadow 方案必须**完全不调用 `selectPanel`**，让 `activePanelId` 保持默认的 `null`；不能改成 `selectPanel('conversation')`。

### 2.2 槽位 shadowing 是公开语义

`@deepseek-ai/dsh-client-ui-slots` 的注册文档写得很明确：

- 非 chain 槽的 `priority` 是 **cell shadowing rank**，升序，最低的渲染。
- `single` 一个 cell；`keyed` 每个 `key` 一个 cell；`list` 每个 `id` 一个 cell。
- 同一 cell 可以注册多个不同 `priority` 的条目；**同一 priority 再注册会抛错**。
- 一个子槽只能有一个 declarer（`children` 声明重复会抛错）。

因此：

```text
官方 ui-conversation: main key='conversation', priority=0
插件:                 main key='conversation', priority=-1   ← 合法 shadow
```

插件条目会赢，官方 `ConversationPanel` 仍留在账本上；插件卸载/注销后，官方条目自动重新成为赢家。`dsh-split-panes` 用的就是这个缝。

**但要注意“一个子槽只能有一个 declarer”。** 官方 `ConversationPanel` 已经声明了 `main.conversation`，插件的 shadow 条目不能再声明同名子槽，也就不能在自己的条目里直接 `renderSlot('main.conversation')`。想在单窗格状态渲染原生 ConversationRoot，只有两条路：

- 注销 shadow 条目，让官方条目重新赢（推荐用于“单窗格回到原生”）；
- 或者像 `dsh-split-panes` 那样自己提供渲染器 host，把官方 `main.conversation` 条目重新挂载到窗格里（重）。

### 2.3 右栏的“屏上会话”来自 `mainView`

`ui-sidebar-right` 的 `SidebarSessionViews.select()` 跟随 `uiSession.adapter.current`。`select()` 会为选中的会话创建一个 view（**即使右栏没有打开 tab**），这个 view 在 `RightbarRoot` 里通过 `SessionProvider` + `renderSlot('rightbar.session')` 挂载，从而 mint / adopt 该会话的 sidebar-right store。

所以只要：

- `activePanelId === null`，且
- 焦点窗格持有 `mainView` retention，

右栏就会：

- 可见；
- 显示焦点窗格的会话；
- 拥有可用的 session surface（文件链接、tab 图标、展开/收起都能工作）。

这就是 `dsh-split-panes` 能保留右栏的完整机制：**不是它额外做了什么，而是它没有破坏这个链条。**

### 2.4 `shell.overlay` 是另一个不碰 `activePanelId` 的缝

`ui-layout` 的 `shell.overlay` 是 root list 槽，渲染在 frame 的绝对定位浮层里：

```css
.overlayLayer { position: absolute; inset: 0; z-index: 20; pointer-events: none; }
.overlayLayer > * { pointer-events: auto; }
```

原生会话面板仍然挂着，`activePanelId` 仍是 `null`；浮层只是盖在会话列上。`dsh-split-workspace` 和 `dsh-sidechat` 都用这个缝。

### 2.5 原生会话的 DOM 缝

`ConversationContent.tsx`：

```tsx
<div data-conversation-content data-content-phase={phase}>
  <div className={css.scrollBody} data-conversation-scroll="">
    <Views />
    {composerSeat}
  </div>
  <WidthControls ... />
</div>
```

- `[data-conversation-scroll]` 同时包含 transcript 和 composer（composer 是 sticky 在滚动体底部）。
- 原生 header 在 `ConversationRoot` 里，不在这个滚动体内。

因此 overlay 方案可以只盖 `[data-conversation-scroll]`，把原生 header 露出来；也可以连 header 一起盖，自己画完整 chrome。两种做法对应不同的产品取舍。

---

## 3. 其他插件怎么做

### 3.1 总表

| 方案 | 代表插件 | 主区接管方式 | `activePanelId` | 原生右栏 | 原生 header / lineage | 每格原生对话 | 主要代价 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 新 `main` key 面板 | 本插件、`B635/dsh-split-view`、`yuloop/dsh-web-split` 1.0 | 换 key | 非 null | 隐藏 | 丢失 | `conversation.content` embedded | 右栏、文件链接、header 全丢 |
| Shadow `conversation` | `lehhair/dsh-split-panes` | 同 key priority -1 | null | 保留 | 保留（渲染原生 root） | vendored renderer | 渲染器维护重 |
| Shadow + Factory（建议） | 本文建议 | 同 key priority -1 | null | 保留 | 自建窗格头部 | `conversation.content` embedded | 无原生 header/hero |
| `shell.overlay` 浮层 | `mhlywxl/dsh-split-workspace`、`yuloop` 开发版、`dsh-sidechat` | 浮层盖住会话列 | null | 保留 | 保留（header 露出） | 重新挂载 / 覆盖 | 双份流式、测量、焦点、z-index |
| 右栏原生 pane | `WTPieh/dsh-split-screen` | 不动主区 | null | 保留（就是它） | 保留 | `conversation.content` embedded | 右栏宽度、composer shim、dockkit 复杂 |
| 自定义右栏 / 工作台 | `DSH-better-sidebar`、`dsh-sidecar` | 不动主区或替换右栏 | null | 替换/扩展 | 保留 | 自定义 | 不是原生右栏 |

### 3.2 `lehhair/dsh-split-panes`：同 key shadow + 官方渲染器

仓库：<https://github.com/lehhair/dsh-split-panes>

**做法**（`docs/ARCHITECTURE.md`、`src/client/index.ts`、`src/client/pane-store.ts`）：

- 在 `main` 槽以 `key: 'conversation'`、`priority: -1` 注册 `PaneWorkspace`，**永久占据**官方 `ConversationPanel` 的位置。
- 不调用 `selectPanel`，因此 `activePanelId` 始终是 `null`。
- 每个窗格不是用 `conversation.content` 工厂，而是把官方 renderer（`createSlotRenderer`）逐字节 vendor 进仓库，构造一个 pane 作用域的 `SlotRendererHost`，让官方 `ConversationRoot` 在窗格内渲染。
- 单个窗格时“逐字节等同原生”（无边框、无额外 chrome）。
- 焦点窗格 = 全局 current 的镜像；点窗格会 `sessions.open(id)`；点侧栏会话通过 capture 阶段反查行 DOM，写入焦点窗格。
- 新窗格是“新建对话”占位，不立刻创建 host 会话；在占位里选工作区才真正创建并绑定。
- 全屏只影响渲染，树不动；关闭窗格提升兄弟子树。
- `pane-store.ts` 把每个 store handle 的 `create(scopeKey)` 按 `(handle, scopeKey)` 记忆化，保证 core 渲染的右栏面板和 pane 内渲染的右栏展开按钮用**同一个 store 实例**。

**右栏为什么在**：`activePanelId` 一直是 `null`；右栏的 `RightbarRoot`、`show()`、`require()` 都按原生逻辑工作。它甚至保留了每个窗格原生 header 里的右栏展开按钮，并用 store sharing 让它和右栏面板共享状态。

**代价**：vendored renderer 需要随上游同步；作者用 `sync-renderer-vendor.mjs` + 逐字节 drift test 守门。基线与当前 `0.2.1-rc.5` 有差距（架构文档基线是 `0.1.5-alpha.2`），要用得先重新 vendor / 适配。

**可借鉴**：shadow 的位置、focus=current、单窗格原生、空白占位、全屏只改渲染、store sharing。

### 3.3 `mhlywxl/dsh-split-workspace`：`shell.overlay` + 重新挂载原生组件

仓库：<https://github.com/mhlywxl/dsh-split-workspace>

**做法**（`lib/client.js` 顶部架构图 + README）：

- 只在 **≥2 个窗格**时激活；0/1 个窗格渲染 `null`，原生单会话视图继续占满视口，workspace chooser / agent preset hero 都还在。
- 激活后注册 `shell.overlay`，把窗格浮层**约束在测量到的会话列**（四边都限制，测量失败则 fail-closed），第二个窗格关闭时把视口交还。
- 窗格不是 iframe，也不是 vendor renderer；它通过 `ctx.slots.entries()` 捕获原生注册条目（ChatView、InputBar、chat-node renderer、模型/计划/附件 seat、第三方 composer 插件等），按窗格重新组合 props 渲染。每个捕获的渲染都有 error boundary + fallback。
- 原生左侧栏/会话列表跟随焦点窗格；分屏工具栏有一个**两态**的右栏开关（关闭时右箭头，打开时高亮左箭头）。
- 明确**不**在每个窗格标题栏挂原生 rightbar seat：该 seat 是会话级的，自带 store handle，每格挂一份会为同一会话创建第二个 sidebar-right store，导致共享面板的标签图标失效；原生标题栏保留唯一的 store。
- 提供 minimize/restore：最小化隐藏分屏、显示原生单会话，保留窗格树；打开新建会话 / 插件 / 技能 / 设置面板时自动最小化，避免盖住。
- 安全层：kill switch、crash-loop safe mode、error budget、`window.__dshSplitWorkspace.health()`。

**右栏为什么在**：浮层不改变 `activePanelId`，原生会话面板仍在下面；焦点窗格持有 current，右栏跟着焦点。工具栏负责打开/收起同一个共享右栏。

**代价**：原生会话仍在遮罩下流式运行；浮层几何、焦点切换、composer 单例、第三方 composer 插件兼容都需要大量细节。

**可借鉴**：split-only 激活、overlay 约束到会话列、单例右栏、minimize/restore、安全层、失败关闭。

### 3.4 `yuloop/dsh-web-split`：panel 版踩坑，overlay 版修好

仓库：<https://github.com/yuloop/dsh-web-split>

**1.0 的 panel 版**：

- 注册 `main` `key: 'split'`，每个窗格 `SessionProvider` + `renderSlot` + `conversation.content` embedded。
- README 的“已知限制”明确记录：窗格里点文件/图片会报

  ```text
  无法打开文件 / sidebarRight: no session surface is mounted
  ```

  原因是文件链接走右侧栏的 `sidebarRight.require()`，而它只认“当前显示在会话列上的那个会话”；全局 `main` 面板不带会话上下文。

**DEVLOG 的 overlay 版**（`docs/DEVLOG.md` 第 9 期，未作为 1.0 发布；仓库当前 `client.js` 仍是 panel 版）：

- 改用 `shell.overlay`，网格**正好覆盖 `[data-conversation-scroll]`**（误差 ≤2px），原生会话面板保持激活。
- 结果：右侧栏能打开、header lineage 槽位在、窗格里的文件链接能打开右栏。
- 焦点切换非常克制：只在窗格正文按下鼠标时切官方会话；点标题栏按钮不切；在输入框/可编辑区不切；350ms trailing debounce；目标已经是屏上会话就不动。
- 文件链接需要先“交接”会话到屏上，再等右栏 surface 稳定后重放；后来用户干脆改成“分屏里打开文档/图片 ⇒ 退出分屏，回官方会话模式”。
- 测量不到会话列时不能立刻隐藏浮层（会导致点击右栏时闪屏/卡死），要留宽限期。

**可借鉴**：panel 与 overlay 的取舍有真实代价；overlay 不是“随便盖一层”，焦点、测量、文件链接都要单独设计。

### 3.5 `B635/dsh-split-view`：当前版本的 panel + Factory 参考

仓库：<https://github.com/B635/dsh-split-view>

- 在 `0.2.1-rc.5` 上验证的双栏面板。
- 注册 `main` `key: 'session-split'`，每个窗格 `SessionProvider` + 子槽 + `conversation.content` embedded。
- 每栏顶部有会话选择器、运行状态、交换、关闭、在主会话打开；带 Agent Teams 入口；每栏 error boundary；布局/比例 localStorage。
- 它同样会隐藏右栏（和本插件同一条 gate），README 也没有声称保留右栏。

**可借鉴**：`conversation.content` embedded 在 `0.2.1-rc.5` 上足够支撑一个完整窗格（transcript/composer/queue/tool/审批）；两栏的交互和持久化可以很薄。

### 3.6 `WTPieh/dsh-split-screen`：把第二个会话放进原生右栏

仓库：<https://github.com/WTPieh/dsh-split-screen>

- 不 split 主区；用 `sidebarRightTabs.register` 注册一个 pane tab 类型，在 `sidebar.right.pane.tab` 里渲染 `conversation.content` embedded。
- 会话生命周期用 `dsh-resource://splitscreen/session/<id>` owner + `sessions.retain`，tab 关闭时释放。
- 入口在侧栏会话行、右栏 `+` guide、tab `⋯` 菜单；支持与主会话交换。
- 右栏本来就是 dockkit 的容器，pane 可以 split / move / float。

**右栏为什么在**：它没有绕过右栏，而是把右栏当成分屏容器。

**代价**：右栏宽度有限；composer 是 shim（DSH 的 composer stack 是页面级单例，第二个可见 composer 还不能完全原生，作者引用了上游 discussion #9475）；不是主区 N 宫格。

**可借鉴**：如果产品目标是“旁边再看一个会话”，这是对右栏最友好的形态；如果目标是“主区工作台”，它不够。

### 3.7 `Mintcolour/dsh-sidechat` 与 `wangyili-1/dsh-sidecar`：伴随式侧聊

- **sidechat**：`shell.overlay` 抽屉 + host 半边的独立子 Session + 自有 timeline / composer。抽屉 `position: fixed` 在右侧，用 `[data-dsh-sidechat-split] { width: calc(100% - var(--dsh-sidechat-split-width)) }` 把整个 frame 收窄，主会话和右栏都不被覆盖（但会被挤窄）。它不渲染原生会话，而是自己的消息流。
- **sidecar**：自定义右侧面板，内部有网页 tab、侧聊 tab、上下分屏；有独立的 host 服务与状态存储。它扩展的是“侧栏工作台”，不是原生主区分屏。

**可借鉴**：如果只需要“主任务旁边再开一个轻量对话”，伴随式侧聊比主区 N 宫格简单得多；代价是对话 UI 不是原生的。

### 3.8 `omdsh-dev/DSH-better-sidebar`：右栏工作台

仓库：<https://github.com/omdsh-dev/DSH-better-sidebar>

- 把右侧栏做成完整工作台：文件树/编辑器、内嵌浏览器、终端、Git、后台任务；支持右侧栏 + 底部面板，拖 tab 拆分/合并。
- 暴露 `ctx.betterSidebar`，第三方插件可以 `registerTab` / `registerFileViewer`。
- 它不是“保留原生右栏”，而是**替换/扩展**右栏；适合“右栏工作台”这个产品方向，不适合“主区 N 宫格 + 原生右栏”的目标。

**可借鉴**：如果重设计决定把右栏也做成工作台，应该走服务化注册，而不是在插件里私有地塞 DOM。

### 3.9 机制回放：为什么它们能保留右栏

把上面的实现压缩成一条链：

```text
右栏可见
  ⇐ activePanelId === null
  ⇐ 没有换 main key（shadow conversation），或根本没动 main（overlay / 右栏 pane）
右栏有正确会话
  ⇐ onScreen = selected session
  ⇐ selected session = uiSession.adapter.current
  ⇐ 焦点窗格持有 mainView retention
右栏能执行写操作
  ⇐ 该会话的 sidebar-right store 已被 rightbar.session seat mint / adopt
  ⇐ 右栏是单例，没有被每格窗格各挂一份
```

所以“保留右栏”不是某个插件的独门技巧，而是**不要破坏这条链**：

- 不要 `selectPanel` 到自定义 `main` key；
- 不要卸掉原生会话面板（除非你用 shadow 且自己接管了同一 cell）；
- 让焦点窗格持有 `mainView`；
- 右栏保持单例，store 不被拆成多份。

本插件当前破坏了第一条；B1/B2/C/D 各自用不同方式保住了第一条（B2 是本文建议的新路线）。

---

## 4. 方案对比

### 4.1 五条路线

| 路线 | 代表 | 用户看到的分屏 | 右栏 | 原生 header | 实现复杂度 | 上游升级风险 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| A. 新 `main` key 面板 | 本插件、B635、yuloop 1.0 | 主区完全替换 | 消失 | 消失 | 低 | 中（`main`/Factory） |
| B1. Shadow + vendored renderer | dsh-split-panes | 主区同 key 替换 | 保留 | 保留 | 高 | 高（渲染器逐字节） |
| B2. Shadow + Factory | 本文建议 | 主区同 key 替换 | 保留 | 自建 | 中 | 中（Factory + shadow） |
| C. `shell.overlay` | dsh-split-workspace、yuloop 开发版 | 浮层盖会话列 | 保留 | 保留 | 高 | 中高（DOM 几何/焦点） |
| D. 右栏原生 pane | dsh-split-screen | 右栏里多一个会话 | 保留 | 保留 | 中高 | 中（dockkit/rightbar） |

### 4.2 为什么 B2 是本插件的最小改动

本插件已经具备 B2 需要的绝大部分能力：

- 每个窗格已经用 `SessionProvider` + `conversation.content` embedded 渲染；
- 已经有焦点窗格 + `mainView` 的单值推导；
- 已经有布局树、保留引用、视图切换、窗格头部、命令、侧栏工作区。

B2 只需要改“接管位置”：

- 不再注册 `main` `key: 'hkcraft.panes'`；
- 不再调用 `selectPanel('hkcraft.panes')`；
- 改为在分屏激活时注册 `main` `key: 'conversation'`、`priority: -1`，子槽仍然是现有的 `hkcraft.pane`；
- 分屏关闭时注销该条目，官方 `ConversationPanel` 自动回来。

这样 `activePanelId` 始终是 `null`，右栏的 gate 保持打开；焦点窗格的 `mainView` 让右栏跟着焦点。

**代价**：

- 不能在自己的 shadow 条目里 `renderSlot('main.conversation')`（一个子槽一个 declarer），所以单窗格状态要么自建（B2 的一格也是插件头部），要么注销回原生；
- 没有原生 header / lineage / hero；
- 右栏展开按钮要自己在窗格头部补一个。

### 4.3 为什么不建议 A + 自建右栏

- 原生右栏的 tab 类型、文件预览、子代理、资源 pin、dockkit 分栏、store 持久化，都要重新实现；
- `sidebarRight.require()` 仍然会因为没有 on-screen session 而失败，除非把服务也替换掉；
- 用户已经装的其他右栏插件（better-sidebar、文件预览等）会一起失效；
- 维护成本远高于换一个接管位置。

---

## 5. 值得借鉴的设计

### 5.1 接管位置优先于渲染技巧

先决定“分屏是主区的一种模式，还是主区的替代品”：

- **模式**：shadow `conversation` 或 overlay，`activePanelId` 保持 `null`，右栏/原生 header 都还在。
- **替代品**：新 `main` key，右栏必然消失；除非你把右栏也一起接管。

本插件目前是“替代品”。如果重设计的目标是保留右栏，那它应该改成“模式”。

### 5.2 焦点 = 全局 current，且要在 pointerdown 就切

- 焦点窗格持有 `mainView`；点窗格正文/头部时立即 focus + retain，不要等 click。
- 这样右栏、文件链接、侧栏高亮、通知点击都在正确的会话上。
- 如果等 click 或 debounce，文件链接可能在 focus 生效前就调用 `sidebarRight.require()`，打开错误的会话或直接报错。
- 侧栏点会话要路由到焦点窗格（capture 阶段反查行 DOM，或订阅 current 变化），否则右栏会跟着原生 current 走，而窗格内容不动。

### 5.3 右栏是单例，不要每格挂一份

- 原生 `rightbar` 是一个 occupant，共享一个右侧栏。
- 不要在每格窗格标题栏挂原生 rightbar seat（`rightbar.session`）：它会为同一会话 mint 第二个 sidebar-right store，导致共享面板的标签图标/展开状态看起来失效（`dsh-split-workspace` 的明确踩坑）。
- 如果渲染原生 header（B1），要让 pane host 和 core 共享同一个 `(store handle, scopeKey)` 实例（dsh-split-panes 的 `pane-store.ts`）。
- 分屏工具栏/窗格头部只放一个右栏开关，调用 `ctx.sidebarRight.toggleExpanded()`；服务缺失时安静隐藏。

### 5.4 Split-only 激活与 minimize

- 0/1 个窗格时不要接管：原生单会话视图、workspace chooser、hero 都还在。
- ≥2 个窗格才进入分屏；关闭到 1 格时交还视口。
- 打开设置 / 插件 / 技能等全局面板时自动最小化分屏，避免盖住或卸载后状态错乱；返回会话时恢复。
- 这比“插件一加载就永久接管”更接近用户预期，也减少右栏/原生 header 的常驻损失。

### 5.5 新窗格先占位，选工作区才创建会话

- `dsh-split-panes` 的新窗格是“新建对话”占位，不立即创建 host 会话；用户在占位里选工作区/预设后才创建并绑定。
- 好处：不会因为“点了一下分屏”就留下空会话；占位窗格也能渲染原生 hero。
- 本插件当前是 split 即创建会话；重设计可以改成占位 + 懒创建。

### 5.6 全屏 / 最大化只改渲染，不动树

- `fullscreenPaneId` 只影响渲染；退出全屏精确回到原比例和所有窗格。
- 关闭全屏窗格、或树塌成单叶时自动清空。
- 这比“最大化时销毁其他窗格再恢复”稳得多。

### 5.7 布局与拖拽

- 自动布局：2 列、3 个 L 形、4 个 2×2、5+ 按 `sqrt(n)` 均衡网格；拖拽手动排布保留。
- 拖到窗格边缘 = 分屏/移动；拖到中心 = 替换/交换；分隔线拖动只画 ghost，松手才提交 ratio。
- 窗格加 `contain: layout paint`，拖动期间冻结尺寸观察/输入框测量，避免每帧重排整段对话。
- 持久化树要校验：会话唯一、深度上限、比例夹取；坏树丢弃而不是恢复坏工作区。

### 5.8 生命周期与降级

- 每个窗格一个 error boundary；渲染失败只坏一格，不炸整个主区。
- kill switch、crash-loop safe mode、error budget、`health()` 诊断（dsh-split-workspace）。
- 可选服务（右栏、agent preset、subagent、settings）缺失时安静降级；不要因为一个 seat 缺失导致整个分屏不挂载。

### 5.9 原生导航与文件链接

- `uiWorkspace.openSession` / `startSession` 会 `selectPanel(null)`：
  - 在 panel 模式下会卸载分屏；
  - 在 shadow/overlay 模式下是 no-op（activePanelId 已经是 null），不会拆掉分屏。
- 文件链接/图片走 `sidebarRight.openResource`，要求目标会话是 on-screen 且 store 已 adopt：
  - 先 focus 窗格（pointerdown），再让链接走原生路径；
  - 如果 surface 还没就绪，做短轮询/重试，或明确“退出分屏再打开”；
  - 不要在 focus 未生效时吞掉点击。
- 如果保留原生 header（overlay/B1），右栏展开按钮和 lineage 会自然存在；如果自建 header（B2），要补右栏开关和子代理入口。

### 5.10 不要 iframe

- Desktop 的 preload 只在顶层 frame 运行；同源 iframe 会停在 “Loading plugins…”。
- 窗格引擎必须在顶层 client 里，按会话重新挂载原生组件/factory。
- 这也是 dsh-split-workspace 明确记录的限制。

---

## 6. 对本插件重设计的建议

### 6.1 推荐：B2 — Shadow `conversation` + 现有 Factory 窗格

**目标形态**：

- 单会话：原生 dsh 视图（或至少不接管）；右栏、header、lineage、文件链接全原生。
- 多会话：主区变成窗格网格；右栏仍然可见，并跟随焦点窗格。
- 设置/插件/技能等全局面板：正常 `selectPanel`，右栏按原生规则隐藏；返回会话时恢复分屏。

**示意注册**（不是要求照抄，只说明位置）：

```text
ctx.slots.inject('main', function* () {
  yield ctx.slots.register({
    name: 'main',
    key: 'conversation',
    priority: -1,                    // 低于官方 0，赢得 conversation cell
    children: { 'hkcraft.pane': { kind: 'single', scope: 'session' } },
  }, PaneHost)
  yield ctx.slots.register({ name: 'hkcraft.pane' }, PaneBody)
})
```

**关键约束**：

- 不调用 `selectPanel('hkcraft.panes')`；
- 不在 shadow 条目里声明 `main.conversation`（一个子槽一个 declarer）；
- 分屏关闭时 dispose 这个条目，官方 `ConversationPanel` 自动回来；
- 需要从全局面板回到会话时，调用 `selectPanel(null)`，不是 `selectPanel('conversation')`。

**需要补的产品件**：

1. **单会话入口**：在 `conversation.session.header.actions` 注册一个“分屏”按钮（官方 header 存在时可见），点击创建/聚焦第二格并激活 shadow。
2. **右栏开关**：在窗格头部或分屏工具栏放一个按钮，调用 `ctx.get('sidebarRight')?.toggleExpanded()`；服务缺失时隐藏。展开状态的可观测性需要单独确认（目前公开面没有明显的 expanded observable）。
3. **焦点路由**：窗格 `onPointerDownCapture` 立即 focus + retain mainView；侧栏会话点击 capture 阶段路由到焦点窗格，避免右栏跟着原生 current 走。
4. **原生导航处理**：`openSession` / `startSession` 在 shadow 模式下不会拆面板；如果它们把 current 切到不在窗格里的会话，定义策略（聚焦已有窗格 / 替换焦点窗格 / 忽略）。
5. **全局面板**：设置/插件页选中时，分屏自然卸载；返回时恢复。必要时加 minimize/restore。
6. **单窗格策略**：二选一
   - A2（推荐）：<2 格回原生单会话，保留“恢复分屏”入口；
   - A1：永久 shadow，单格也显示插件头部/标签条（需要接受不是原生 header）。

**预期收益**：

- 右栏可见、可展开、可打开文件、tab 图标正常；
- 文件链接不再报 `no session surface is mounted`；
- 原生 header/lineage 的缺失范围可控（自建窗格头部已有模式/子代理/视图/关闭）；
- 复用现有 pane controller / layout / retention / view switch，改动集中在一个注册点。

**需要实测的点**：

- shadow 条目在 `0.2.1-rc.5` 上的 priority 行为；
- `activePanelId` 是否始终 `null`；
- 右栏是否跟随焦点窗格；
- 文件链接是否打到正确会话；
- 如果后续把原生 header / rightbar seat 挂进窗格，右栏 tab 图标是否因 store 双实例失效；
- 关闭到 1 格后原生视图/右栏是否恢复。

### 6.2 备选：C — `shell.overlay` 浮层

**适合**：必须保留原生 header / lineage / 原生 header 里的右栏按钮；可以接受原生会话在下面继续挂载。

**做法**：

- 注册 `shell.overlay`；
- 用 `[data-conversation-scroll]` 或会话列的 `getBoundingClientRect()` 定位，四边约束，测量失败时 fail-closed；
- 原生会话面板保持 `activePanelId === null`；
- 每个窗格用 `SessionProvider` + `conversation.content` embedded（yuloop）或重新挂载原生组件（mhlywxl）；
- 焦点切换只在窗格正文 pointerdown；输入框/可编辑区内不切；必要时 debounce；
- 右栏打开会改变会话列宽度，用 ResizeObserver 跟随；测量暂时失败时不要立刻隐藏（宽限期）；
- 文件链接先交接会话、等 surface 稳定，再打开；做不好就明确“退出分屏打开”。

**代价**：双份流式/隐藏 composer、几何与 z-index、焦点切换、与设置/插件页的遮挡关系、第三方 composer 插件兼容。比重设计注册点复杂得多。

### 6.3 备选：D — 右栏原生 pane

**适合**：产品目标是“主任务旁边再看一个会话”，不要求主区 N 宫格。

**做法**：`ctx.sidebarRightTabs.register` + `sidebar.right.pane.tab` + `sessions.retain`（resource owner）+ `conversation.content` embedded；用 dockkit 的 split/tab 能力；composer 需要 shim 或等待上游 occurrence-scoped composer。

**收益**：主区/header/右栏全部原生；右栏就是分屏容器。
**代价**：右栏宽度、composer 单例、不是主区工作台。

### 6.4 不建议：A + 自建右栏

保留新 `main` key，然后在插件里重新实现右栏 tab、文件预览、子代理、dockkit。工作量大、与生态插件冲突、`sidebarRight` 写路径仍然不可用，收益最低。

### 6.5 建议的验证顺序

1. **只做注册点 spike**：把 `hkcraft.panes` 改成 shadow `conversation`，不调用 `selectPanel`，看右栏是否回来、是否跟随焦点。先不改产品交互。
2. **右栏写路径**：在窗格里点文件链接，确认 `sidebarRight.require()` 拿到的是焦点窗格会话；确认右栏 tab 图标正常（store 单例）。
3. **焦点路由**：点不同窗格、点侧栏会话、通知点击，确认 current/右栏/高亮一致。
4. **单窗格/全局面板**：关闭到 1 格、打开设置/插件页、返回会话，确认原生视图和右栏状态正确。
5. **性能**：2/4 格同时流式、拖分隔线，确认没有重复 composer、没有整段重排。
6. 再决定是否需要 overlay / 原生 header 的进一步投入。

---

## 7. 风险与未决问题

1. **上游 gate 可能变化**：右栏可见性、`sidebarRight.show`、`mainView` 推导都在上游；升级 dsh 时必须复验。本文只覆盖 `0.2.1-rc.5` / `0.2.2-alpha.2`。
2. **shadow 的“一个子槽一个 declarer”**：不能在自己的条目里直接渲染官方 `main.conversation`；单窗格原生只能靠注销条目，或走 vendored renderer。
3. **`selectPanel('conversation')` 不是 null**：重设计时不要误用；只有 `selectPanel(null)` 才保持 `activePanelId === null`。
4. **右栏展开状态的可观测性**：`ctx.sidebarRight` 有 `isExpanded()` / `toggleExpanded()`，但公开面没有明显的 expanded 订阅；按钮的两态图标需要额外确认（读 store / DOM / 轮询都不是理想解）。
5. **焦点与文件链接的时序**：必须在 pointerdown 就 focus + retain；否则 `openResource` 可能打到上一个会话。overlay 方案尤其容易踩。
6. **composer 单例**：overlay/右栏 pane 都可能遇到“第二个可见 composer”问题；shadow + factory 每个窗格挂的是 embedded occurrence，当前实现已经验证可用，但仍需观察第三方 composer 插件。
7. **性能**：N 个真实会话同时流式，布局/重排成本高；拖拽时只画 ghost，`contain` + memo + 窄订阅。
8. **左侧栏替换是独立决策**：它不影响右栏 gate，但会影响用户如何选会话、如何把会话放进窗格；重设计时可以保留，也可以重新考虑。
9. **其他插件的版本基线**：dsh-split-panes 基线是 `0.1.5-alpha.2`，其 vendored renderer 不能直接假设兼容 `0.2.1-rc.5`；yuloop 的 overlay 只存在于 DEVLOG（仓库当前 `client.js` 仍是 panel 版）。借鉴的是设计，不是可直接复制的代码。

---

## 8. 参考

**上游（本地 checkout 复核）**

- `packages/client/ui-layout/src/client/AppFrame.tsx`：`main` keyed slot、`RightbarColumn`、`shell.overlay` layer。
- `packages/client/ui-sidebar-right/src/client/shell/RightbarRoot.tsx`：`activePanelId === null` 可见性。
- `packages/client/ui-sidebar-right/src/client/index.ts`：`show(activePanelId === null ? selected : undefined)`、rightbar 注册。
- `packages/client/ui-sidebar-right/src/client/service.ts`：`require()` / `no session surface is mounted`。
- `packages/client/ui-sidebar-right/src/client/session-views.ts`：selected session 的 view 创建与 retain。
- `packages/client/ui-conversation/src/client/apply.ts`：`main` `key: 'conversation'` 注册。
- `packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx`：`data-conversation-scroll`、composer 位置。
- `packages/client/ui-slots/src/index.ts`：priority / cell shadowing / 一个 declarer 规则。
- 本仓库 [`docs/upstream-contracts.md`](../../docs/upstream-contracts.md)：`main` keyed slot、`selectPanel`、`conversation.content`、`mainView`、右栏隐藏的既有记录。

**其他插件**

- `lehhair/dsh-split-panes` — <https://github.com/lehhair/dsh-split-panes>（`docs/ARCHITECTURE.md`、`src/client/index.ts`、`src/client/pane-store.ts`）
- `mhlywxl/dsh-split-workspace` — <https://github.com/mhlywxl/dsh-split-workspace>（`lib/client.js` 架构图、README）
- `yuloop/dsh-web-split` — <https://github.com/yuloop/dsh-web-split>（README“已知限制”、`docs/DEVLOG.md` 第 9 期）
- `B635/dsh-split-view` — <https://github.com/B635/dsh-split-view>（`client.js` 顶部注释与 `apply`）
- `WTPieh/dsh-split-screen` — <https://github.com/WTPieh/dsh-split-screen>（README“How it works”）
- `Mintcolour/dsh-sidechat` — <https://github.com/Mintcolour/dsh-sidechat>（`src/client/plugin.tsx`、`SideChatDrawer.tsx`）
- `wangyili-1/dsh-sidecar` — <https://github.com/wangyili-1/dsh-sidecar>（README“标签与上下分屏”）
- `omdsh-dev/DSH-better-sidebar` — <https://github.com/omdsh-dev/DSH-better-sidebar>（README“双工作台”）