# 多会话分屏与侧栏精简 — spec

**状态**：待用户确认后开工。**最后更新**：2026-10-30。
**术语**：见 [`GLOSSARY.md`](../../GLOSSARY.md)（会话 / 窗格 / 视图 / 布局树 / 标签条）。

## 1. 开工门槛（G1 已关闭）

**结论：A —— 原生支持，纯插件可实现，无需改上游。**（2026-10-30，代码级核查，未做运行时验证）

可行的挂载路径已确认，且比"覆盖层"更干净：

1. 注册一个 **`main` 键控槽**的条目（key 如 `hkcraft.panes`），并声明一个 `scope: "session"` 的子槽；
   —— 声明了非 root 子槽的条目会从 kit 拿到 `SessionProvider` 与 `renderSlot`（`dsh-client-ui-renderer:756-759`）。
2. 用 `ctx.layout.selectPanel("hkcraft.panes")` 把它切成中央列的活动面板；`main` 的渲染键是 `activePanelId ?? "conversation"`（`dsh-client-ui-layout:119`），所以**内置对话面板会卸载**，不会双挂。
3. 每个窗格：`sessions.retain(sessionId, {source:"hkcraftPane"})` → `<SessionProvider session={ref}>` → `renderFactorySlot("conversation.content", …)`。
   —— `renderFactorySlot` 在每个条目的 kit 里且**不校验归属**（renderer:740、1061-1089），官方自己就是这么挂对话的（`dsh-client-ui-conversation:17612`）。
4. 卸载安全：`retainMainPanels` 在面板注销后会重置 `activePanelId`（`layout:410-412`），不需要手工清理。

不能走的路（已排除）：直接 `renderSlot("conversation.view")` 会抛 `SlotOwnershipError`（槽只能由声明它的条目渲染，renderer:345-349）；`ctx.slots.renderSlot` 只接受 root 键（renderer:1531-1536）。

残留风险见第 12 节 G2/G4/G5。

## 2. 目标

1. 侧栏工作区区块只显示**工作区名 + 红绿灯**，不显示对话列表，不提供展开。
2. `/resume` 浏览并切换本工作区历史会话；`/clear` 新建会话。
3. 主区域支持 **VS Code 式任意分割**的多窗格，同一工作区多个会话并排。
4. 切换工作区**不停止**任何会话，只切换可见的窗格树。

## 3. 已定决策

| 编号 | 决策 |
| :--- | :--- |
| D1 | 窗格头是唯一的"标签"载体：`标题 + [对话\|轨迹] + ⋯`；视图是分段开关，不是 tab；视图选择**按窗格**记忆 |
| D2 | 布局是**手动分割树**，每个工作区各有一棵；窗格数量由用户分割行为决定，不由会话数量推导 |
| D3 | 窗格**不跨工作区**：一棵树只装同一工作区的会话 |
| D4 | 会话与窗格 **1:1**；`关闭窗格 = 关闭会话`（中断当前回合、释放会话，历史保留可 `/resume` 重开） |
| D5 | 切换工作区只换显示，**不关闭**窗格、不停止会话 |
| D6 | 保留**独立标签条**，列出当前工作区已打开的会话；点击聚焦对应窗格 |
| D7 | 侧栏工作区区块除工作区名与红绿灯外，只保留**添加工作区** |
| D8 | `/clear` = 当前窗格换成新会话；`Mod+N` 与新会话按钮同义 |
| D9 | `/resume` = 覆盖式浮层（复用 `popupSelect`），范围仅当前工作区，最近活动在前，选中替换聚焦窗格，`Ctrl+Enter` 新开一格 |
| D10 | `/resume` 过滤空白会话（`blank`）；标题缺失时回退首条提问；显示"已在窗格 N"徽标 |

## 4. 窗格模型

### 4.1 数据模型（每个工作区一份）

```ts
type LayoutNode =
  | { kind: "leaf"; paneId: string }
  | { kind: "split"; dir: "row" | "col"; ratio: number; a: LayoutNode; b: LayoutNode };

type Pane = { paneId: string; sessionId: string; view: "chat" | "trajectory" };

type WorkspaceLayout = {
  version: 1;
  workspaceId: string;
  root: LayoutNode | null;      // null = 该工作区没有打开的会话
  panes: Record<string, Pane>;
  activePaneId: string | null;
};
```

- `ratio` 存在 split 节点上（**分隔比例必须落盘**——Agent10 的已记录遗憾）。
- 叶子顺序 = 标签条顺序 = 深度优先、左→右 / 上→下。

### 4.2 动作

| 动作 | 语义 |
| :--- | :--- |
| `split(paneId, dir)` | 在该窗格旁新建**一格空窗格并立即创建新会话**；新格替换父节点位置，原格保留 |
| `focus(paneId)` | 移动"当前会话"（见 4.3）并高亮该格 |
| `close(paneId)` | 会话若在运行：**先确认**再中断；移除叶子，兄弟节点**顶替父节点位置**（递归规范化）；焦点移到邻近窗格 |
| `closeWorkspace`（不适用） | 切换工作区不动树 |
| `setView(paneId, view)` | 只改该窗格的视图 |
| `swap(a, b)` | 标签拖拽落到另一个标签上 = **交换两格内容**（不改变树形状） |
| `resize(splitId, ratio)` | 拖分隔条 |

### 4.3 与 dsh 的绑定

- dsh 的"当前会话"是**推导**出来的：全仓多处扫描"谁持有唯一的 `mainView` 引用"。因此：
  - **焦点窗格**独占 `source: "mainView"` 的引用。
  - 其余窗格用各自独立来源（如 `source: "hkcraftPane"`）持有引用。
  - 焦点切换 = 释放旧 `mainView` + 获取新 `mainView`，绝不让两个窗格同时持有。
- 非焦点窗格**保持挂载**（参考 Agent10 的做法：布局切换时不卸载，只切可见性），否则流式输出、滚动位置、输入草稿会丢。

### 4.4 挂载结构

```
main 键控槽（key = "hkcraft.panes"，由 ctx.layout.selectPanel 激活）
└── 标签条（当前工作区的已打开会话）
└── 布局树
    └── 叶子（窗格）
        └── <SessionProvider session={ref}>          ← kit 提供，来源 source:"hkcraftPane"
            └── 窗格头：标题 + [对话|轨迹] + ⋯
            └── renderFactorySlot("conversation.content") ← 完整对话界面
```

- 焦点窗格额外持有 `source:"mainView"` 的引用，维持 dsh "当前会话"的单值推导。
- 窗格视图切换用 `uiConversation.binding(sessionId).activate(viewId)`（公开 API），并隐藏内置的那排按钮、改用我们自己的分段开关。
- 一个会话**最多**挂在一个窗格里；不要用同一 sessionId 同时挂两处（composer/编辑器可能重复绑定）。

## 5. 标签条

沿用 Agent10 的形态（`WorkspaceTabBar.tsx`），并按树形布局修正：

| 项 | 采用 Agent10 的做法 | 我们的修正 |
| :--- | :--- | :--- |
| 高度/密度 | 36px，`px-2`，图标 13px，标题截断 128px | 同 |
| 内容 | 图标 + 标题 + 状态点 + hover 才出现的关闭 X | 去掉图标（会话无种类），保留状态点与关闭 X |
| 新增 | `+` 下拉菜单 | `+` = 新会话新窗格；另加"向右/向下分割"两个动作 |
| 重排 | 拖拽显示插入竖线，`6px` 阈值后才算拖拽 | 树形布局里"重排"无良定义 → 改为**拖到另一标签上交换内容** |
| 焦点 | 仅用标签背景色表示 | **标签高亮 + 窗格描边**（Agent10 平铺时看不出焦点，这个缺陷不复制） |
| 溢出 | 横向滚动 | 同 |
| 空态 | 无 | 无窗格时整块显示空态 hero（新会话 / 最近会话） |

## 6. 视图开关（对话 / 轨迹）

- dsh 的 `conversation.view` 是 `list` 槽，`chat`(order 0) 与 `trajectory`(order 10) 同时只渲染一个，上面那排按钮在"可用视图 < 2"时自动隐藏。
- 改动：**不动数据模型**，只把该按钮条从对话标题区挪到窗格右上角并压成分段开关（两段：对话 / 轨迹）。
- 状态落在 `WorkspaceLayout.panes[paneId].view`，按窗格记忆，不写全局。
- "轨迹"在 `developerTools.enabled` 关闭时不出现——沿用该过滤。

## 7. 侧栏精简

工作区区块（`sidebar.workspaces` 槽，`single` 类，可被更低 `priority` 覆盖）：

```
● 项目A            ← 红绿灯 + 名称，当前工作区高亮
● 项目B
● 项目C
＋ 添加工作区        ← 唯一保留的原功能
```

- **删除**：会话行、会话行悬停操作、分组模式（Group by Workspace / Workspace Tree / 扁平）、每工作区折叠、归档筛选、区块内搜索入口。
- **红绿灯**（名称前，优先级 红 > 黄 > 绿）：

| 灯 | 含义 |
| :--- | :--- |
| 🔴 | 该工作区有会话**在等你**（审批 / 追问 / 计划确认） |
| 🟡 | 有会话**运行中** |
| 🟢 | 无活动会话（全部完成或空闲） |

> **没有"出错"红灯**：dsh 0.2.0-rc.2 的客户端状态投影（`sessionStatus` 的
> `running` / `pendingInteraction` / `completionUnread`）与会话摘要都没有失败位；
> 判断"上一回合失败"只能逐个会话打开历史，侧栏不能这么做。因此红灯**只**表示
> "等你操作"，代码与文案不再保留错误分支（见 `doc/upstream-contracts.md#session-summary-fields`）。
> 若未来 dsh 提供失败信号，再加一档即可。

- 侧栏其余部分（品牌、折叠、Plugins/自动化图标行、More 菜单、Settings、底部动作）**原样保留**。
- 实现方式：覆盖 `sidebar.workspaces` 槽即可，不改上游；卸载必须干净可逆。

## 8. `/clear` 与 `/resume`

两者都是**纯客户端命令**（`commandUi.register`），不发往模型。

- `/clear`：`ui:[kind:'action']`，新建会话并替换聚焦窗格内容；旧会话留在历史。等价于现有 `session.new`（`Mod+N`、侧栏新会话按钮）。
- `/resume`：`ui:[kind:'popupSelect', searchMode:'fuzzy-label']`，壳提供 ↑↓ / Enter / Esc。
  - 数据：会话摘要（`running` / `formatStatus` / `updatedAt` / `blank`）+ 标题（投影读取，缺失回退首条提问）。
  - 排序：最近活动在前；运行中的会话不置顶、但带运行中徽标。
  - 已在某窗格中的会话：显示"已在窗格 N"，选中 = 聚焦该窗格。
  - 归档会话：v1 不进列表（归档入口随侧栏搜索一起移除，见第 11 节）。

## 9. 持久化

- 全部走客户端 store（`defineStore({persist})` → localStorage），**每个工作区一个键**：
  `dsh.hkcraft.layout.v1.<workspaceId>` → `{ root, panes, activePaneId }`
- 键必须带工作区 id：客户端存储是浏览器源级的，天然跨工作区共享，不键控会互相覆盖。
- 恢复策略：会话 id 已不存在（被删）→ 丢弃该叶子并规范化树；树变空 → 空态。
  若首次读取时工作区目录尚未就绪，先保留所有叶子；目录变为就绪后**重跑**同一剪枝，
  不能因为"这棵树已缓存"就永远不剪。
- 不落主机端（会话历史归 dsh 自己管，我们只存"怎么摆"）。

## 10. 切片与验收

| 切片 | 内容 | 验收 |
| :--- | :--- | :--- |
| **S0** | 运行时冒烟（G1 已用代码核查关闭） | 插件能激活 `main` 面板并为两个不同 sessionId 各渲染一个可交互对话；两个窗格能同时流式输出 |
| **S1** | 侧栏精简 + 红绿灯 + `/clear` + `/resume` | 侧栏只剩名称/灯/添加工作区；两条命令可用；**不依赖分屏**，可独立交付 |
| **S2** | 窗格树 + 标签条 + 视图开关 + 持久化 | 任意分割；关闭窗格中断会话；切工作区不中断；重启后布局与比例复原 |
| **S3** | 打磨 | 拖拽交换、快捷键全表、空态引导、焦点描边、状态点动效 |

S1 先于 S2 交付：它不依赖 G1，即使探针失败也仍然有价值。

## 11. 已知损失

侧栏工作区区块被整块替换后，原 `WorkspaceBrowser` 消费的两个快捷键失去消费方：

- `Mod+K`（区块内搜索，含会话正文、限 20 条）随 D7 一并移除。
- `Mod+O`（添加工作区）也是原生区块的绑定，替换后变成空操作；添加工作区仍可点
  保留的「＋ 添加工作区」按钮（`Mod+O` 不再重新绑定，属于已接受的损失）。

v1 的补偿：

- 找本工作区历史 → `/resume`（标题 + 首条提问，模糊匹配，**不含正文**）。
- 找其它工作区历史 → 先切工作区再 `/resume`。
- 加工作区 → 侧栏的「＋ 添加工作区」入口。

若实际使用中"找不到旧对话"变成高频抱怨，S3 增补一个全局 `Mod+K` 面板（宿主 `sessionController.search` 已现成，20 条上限）。**这是待议项，不是 v1 范围。**

## 12. 未验证假设

| 编号 | 假设 | 状态 / 验证方式 |
| :--- | :--- | :--- |
| G1 | 插件可为主区域任意窗格渲染指定会话的完整对话 | **已关闭（A 档）**；S0 做运行时冒烟 |
| G2 | 关闭窗格时可通过公开 API 中断运行中的回合 | **已关闭（A 档）**：`ctx.sessions.scope(id).get("conversation").cancel()`，与壳 stop 按钮同一条路；`reference.release()` 只清客户端引用、不停宿主 agent。证据见 `issues/09-close-pane-stops-session.md` 的 Comments |
| G3 | 非焦点窗格可用独立 retain 来源持有会话，且不破坏"当前会话"推导 | **已关闭**：`source` 是自由字符串，`mainView` 无唯一性校验（仅推导取第一个） |
| G4 | `conversation.view` 的按钮条可被挪位而不重写对话组件 | 🟡 半关闭：改用公开的 `uiConversation.binding(id).activate(viewId)` 驱动 + 隐藏内置按钮条；S2 验证隐藏方式（作用域 CSS）是否稳定 |
| G5 | `"conversation.content"` 这个 Factory 名是字符串契约，上游改名即断 | 🔲 缓解：启动时特性探测，缺失则退回"单对话 + 提示"降级形态，并锁定 dsh 版本范围 |
