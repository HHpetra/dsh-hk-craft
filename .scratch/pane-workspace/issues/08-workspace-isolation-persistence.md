# 08: 工作区隔离与布局持久化

**What to build:** 每个工作区有自己的一套窗格布局，互不干扰。切换工作区只换「看见哪些窗格」，不关闭任何窗格、不打断任何会话；切走期间会话继续在后台跑。关闭浏览器或重启 dsh 后，每个工作区的树形、分隔比例、焦点格和每格视图都原样恢复。

**Blocked by:** 05

**Status:** resolved

- [x] 三个工作区各有独立布局，切换时互不覆盖
- [ ] 切走再切回：布局、焦点恢复（已单测）；滚动位置与输入草稿**未验证**——保持挂载只是必要条件，
  不保证 dsh 的 composer/DOM 状态一定存活（需真实 dsh 人工冒烟）
- [ ] 切走期间会话继续运行；切回后能看到这期间产生的完整输出（宿主侧运行 + 引用保留；需人工）
- [x] 重启 dsh 后每个工作区的树形、比例、焦点、每格视图复原
- [x] 恢复时若某格绑定的会话已不存在，丢弃该格并把树规范化；树为空则显示空态
- [x] 布局状态的存储键按工作区区分，不会跨工作区串味

## Comments

**落了什么**

- `src/client/layout-store.js`（新）：纯编解码 + 存储接缝，不依赖 React / DOM / dsh。
  `layoutKey(workspaceId)` → `dsh.hkcraft.layout.v1.<workspaceId>`（无工作区 id 时返回 `null`，不落盘）；
  `encodeLayout` / `decodeLayout` / `readLayout` / `writeLayout`。解码永不抛：坏 JSON、缺字段、数组、非对象、
  版本不符、存储读失败（隐私模式/配额）一律退回该工作区的空布局。
- `src/client/layout-tree.js`：`normalizeLayout` 加固——叶子 `paneId` 以 panes 的键为准（载荷可省略记录里的
  `paneId`）、同一 paneId 的重复叶子只保留第一个（否则会渲染两个 key 相同的窗格并重复 retain）；
  新增纯函数 `renamePanes(layout, mapping)`（恢复时消除跨工作区 paneId 冲突）。
- `src/client/dsh-pane-host.js`：单棵 `layoutState` 换成 `layouts: Record<workspaceId, WorkspaceLayout>` +
  `activeWorkspaceId`。新增 `switchWorkspace(id)`（只换可见树，不动面板选择）、`reactivate()`（原生 reveal
  把面板踢回后重新选回窗格面板）、`focusedWorkspaceId()` 现在返回真实活动工作区。
  引用对账改为跨所有已加载工作区：每个窗格一条 `hkcraftPane`；**只有活动工作区焦点格**额外持有
  `mainView`（隐藏工作区只保留 pane 引用，所以 dsh 的「当前会话」永远指向可见焦点）。
- `src/client/pane-view.js`：`PaneWorkspace` + `workspaceGroups`——每个已加载工作区一层，非活动层用
  `display:none` 隐藏但**保持挂载**（React 不卸载，因此流式订阅与 DOM 状态**有机会**存活；
  滚动位置与输入草稿是否真的保留未在真实 dsh 中验证，见下方"接受的损失"）。
  07 的视图分段开关、09 的关闭确认弹窗、06 的标签条与 08 合并：弹窗提到 host 层只渲染一个；标签条只属于
  **可见**工作区层（隐藏层的标签条若也挂载，会给 Ctrl+1..4 注册重复的 document 监听），但隐藏层的窗格体
  全部保持挂载。
- `src/client/dsh-workspaces.js` + `index.js`：窗格面板显示时，侧栏点击工作区改走
  `controller.switchWorkspace(id)`，**不再**调用原生 `uiWorkspace.startSession`（那条路走
  `replaceMain(..., "reveal")` → `selectPanel(null)`，会把整块窗格面板卸掉，正是 D5 禁止的损失）；
  窗格面板未显示时保持原行为；`switchWorkspace` 拒绝时回退原生。

**存储键与载荷**

```
key:  dsh.hkcraft.layout.v1.<workspaceId>
value（JSON 字符串）:
{ version: 1,
  root:  { kind:"leaf", paneId } | { kind:"split", dir:"row"|"col", ratio, a, b } | null,
  panes: { [paneId]: { paneId, sessionId, view: "chat"|"trajectory" } },
  activePaneId: string | null }
```

`workspaceId` 不进载荷：它只在键里，解码时由调用方传入，因此即使载荷里带着别的工作区 id 也不会串味。
每次布局变化（分割 / 关闭 / 焦点 / 比例 / 视图 / 换会话 / 恢复后的剪枝结果）都写回**当前工作区**的键；
写入失败只返回 `false`，绝不影响布局本身。

**恢复语义**

- 某工作区第一次被显示时才从其键读回（懒恢复；`activePanelId` 不会被 dsh 持久化，所以「启动」实际等于
  第一次显示窗格面板）。恢复后立即把剪枝结果写回，坏数据不会每次启动重复出现。
- 「会话是否还存在」取 `workspaces.items[].sessionIds` ∪ `sessions.list.byId` 的键；
  `workspaces.phase !== "ready"`（目录未加载完）时**不丢任何窗格**，避免启动竞态误删；
  工作区本身已不存在 → 该键解码为空布局。会话已删 → 丢该叶子、兄弟顶替、焦点修复，全丢则空态。
- 恢复出的 paneId 在每个应用实例里都是 `pane-1…` 起的序列，跨工作区必然重名；`renamePanes` 在加载
  第二、第三个工作区时给冲突 id 换新名并写回，保证 paneId 全局唯一（渲染 key、引用表 key 都靠它）。
- 恢复不创建、不 retain 任何会话引用；引用只在面板真正显示（activate / switch / reactivate）时建立。

**mounted-hidden 与接受的损失**

- 做法：所有已加载工作区的树都渲染在同一个布局容器里，隐藏层 `display:none` + `aria-hidden`。切换只改
  style，不 remount；引用也不释放（`reconcileAll` 保留所有 pane 引用）。这排除了"切换导致 React 卸载"
  这一类丢失，但**不保证**滚动位置与 composer 草稿一定保留：两者由 dsh 自己的 composer / 浏览器布局
  决定，未在本仓库验证。流式输出属于宿主侧会话状态，切走期间继续产生。
- 未加载过的工作区第一次切过去是**新挂载**（本来就没有可保留的滚动/草稿）。
- 仍存在的损失（记录，不修）：
  1. 从**插件侧栏之外**的原生路径切工作区（例如原生工作区选择器）仍走 `startSession` 的 reveal，
     会把窗格面板卸掉并丢失全部窗格的滚动/草稿——这是上游行为，本票只在插件侧栏路径上规避；
     重新打开面板后布局/焦点/视图仍在（从存储恢复），会话也没停（宿主侧运行）。
  2. 浏览器刷新 / 重启 dsh 会重建 DOM：布局、比例、焦点、每格视图恢复，但**滚动位置与未发送草稿不持久化**
     （只存「怎么摆」，不存会话内容；草稿归 dsh 自己的 composer 状态）。
  3. 切到「从未有过布局」的工作区显示空态，不会自动开新会话（留给 06 的标签条 / 10 的打磨决定）。

**新做的 dsh 假设**

1. `localStorage` 是浏览器源级共享的，所以必须按工作区键控（spec §9）；默认存储从 `globalThis.localStorage`
   惰性读取，读不到（隐私模式 / Node 测试）就退化为纯内存。
2. `workspaces.list` 在未就绪时 `phase !== "ready"` 或 `items` 不是数组——此时目录不可信，恢复不删任何窗格。
3. 每个 paneId 在所有工作区间唯一：dsh 侧没有跨工作区的 pane 概念，这是插件自己的约束，恢复时用
   `renamePanes` 强制成立。
4. 侧栏的「当前工作区」高亮仍由 dsh 的 mainView 推导：`switchWorkspace` 把 `mainView` 移到目标工作区焦点格，
   高亮随之移动；目标工作区为空（无焦点格）时高亮暂时留在上一个工作区，直到新会话出现。

**共享文件冲突与解决**

- 上游 06（标签条）、07（视图开关）、09（关闭即中断）都改了 `dsh-pane-host.js` / `pane-view.js`，与 08 的
  按工作区重构冲突。解决方式：
  - `dsh-pane-host.js`：保留 07 的 `viewSwitch` 适配（`setView` 走 `activateView`、`restoreViewFor`、
    `subscribeViewAvailability` 遍历**所有**工作区的窗格）与 09 的 `requestClose` / `confirmClose` /
    `cancelClose`（`requestClose` 改为按 paneId 定位工作区；`confirmClose` 仍先中断再关，失败则窗格保留并
    显示 `closeError`）；`interruptSession` 原样保留。
  - 06 的 `splitPane` / `newInFocusedValue` 提取保留，但内部改为「定位 pane 所在工作区 + 应用到该工作区」；
    `newPane` / `openInNewPane` / `focusPaneAt` 的顺序改为取**可见工作区**的树（`activeLayout()`），
    `openInNewPane` 的会话若属于其他工作区则先切过去再开。
  - 新增：切换工作区会清掉上一个工作区暂存的关闭确认（弹窗不能跨工作区挂着）。
  - `pane-view.js`：以 06/07/09 的版本为底，把 `createPaneHost` 改成按工作区渲染 `PaneWorkspace`；
    `PaneStrip` 放进 `PaneWorkspace` 且只在可见层渲染；关闭确认弹窗放在 host 层（全局只有一个）；
    `PaneFrame`（含 07 的分段开关）原样复用。
- `layout-tree.js` 未被上游改动，无冲突。

**验证**

- `cd packages/dsh-hk-craft; node --test --test-isolation=none`：**286 passed / 0 failed**
  （本票新增 `layout-store` 22、`workspace-layout` 18、`pane-view` 4、`layout-tree` +3；
  合并 06/07/09 后 `dsh-pane-host` 共 58、`tab-strip` 10、`dsh-view-switch` 8）。
- `pnpm build`：16 modules、约 137 kB、id=`dsh-hk-craft`。`node scripts\check-bundle.mjs`：29 项全过。
- 纯函数覆盖：缺字段 / 坏 JSON / 版本过新或无版本 / 未知 session / 重复 paneId / 同一会话挂两格 / 比例越界 /
  未知 view / 焦点指向已删格 / 存储读或写抛错 / 两个工作区键互不覆盖 / 恢复时 paneId 重名改名并写回。

**待人工验证**（装到 desktop → 点插件面板 → **重启 dsh** → 重开窗格）

1. 三个工作区各分割出不同形状（如 w1 左右两格、w2 上下两格、w3 单格），切来切去：形状、比例、焦点、
   每格「对话/轨迹」、标签条内容互不覆盖。
2. 在 w1 发一条长回复，回复流式输出中切到 w2 再切回：输出没断（宿主侧运行）；**重点核对**滚动位置
   与输入草稿是否还在——保持挂载不构成保证，这一条尚未验证。
3. 切走期间 w2 让一个会话继续跑，切回时能看到期间的完整输出。
4. 刷新浏览器（或退出并重启 dsh）：每个工作区切过去后树形、比例、焦点、视图复原。
5. 删掉某个会话后再打开窗格：对应叶子消失、树规范化；整棵都失效时显示空态。
6. 打开两个工作区后 DevTools → Application → Local Storage：应看到两个
   `dsh.hkcraft.layout.v1.<workspaceId>` 键，值只含 `version/root/panes/activePaneId`。
7. 窗格面板显示时点侧栏另一个工作区：面板不退出、窗格不重挂，标签条切换为该工作区的会话；点「原生视图」
   再点回「分屏窗格」：所有已加载工作区的布局都还在。
8. 标签条的 `+` / Ctrl+1..4 / Ctrl+Enter（`/resume`）在切换工作区后只作用于当前可见工作区。
