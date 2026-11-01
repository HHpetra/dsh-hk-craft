# 架构说明

面向用户与 Agent 的**架构与关键原理**介绍。只写架构和关键原理；具体实现以阅读代码为准。

## 1. 运行时

本项目没有自己的运行时。插件由**用户已安装的 dsh** 装载，默认 profile 为 `desktop`：

```text
用户现有 dsh（Desktop 内置运行时 0.2.1-rc.5）
  └─ profile desktop
       ├─ bundle: @deepseek-ai/dsh-base
       ├─ bundle: @deepseek-ai/dsh-web-app
       ├─ bundle: dsh-mcp / 其他已装插件
       └─ bundle: dsh-hk-craft        ← 本项目
            └─ cordis.patch.yml → insert row id/name = dsh-hk-craft
                 └─ host: src/index.js
                 └─ client: lib/client.js（经 dsh.client 声明）
```

dsh 的端口、`DSH_HOME`、会话存储与登录态都不归本项目管理。安装与卸载只改变 profile 的 bundle 依赖和 `dsh.profile.bundles`。

## 2. 配置层顺序

一个 profile 的有效配置按以下顺序合成，后层按 `id` 覆盖前层：

1. `dsh.profile.bundles` 中每个 bundle 的 patch，按列表顺序。
2. profile 自己的 `cordis.patch.yml`。
3. `$DSH_HOME/cordis.patch.yml`。
4. 启动时的 `--patch` overlay。

因此用户可以在自己的 profile patch 中按 `id: dsh-hk-craft` 覆盖本插件的配置，而无需修改本仓库。覆盖会**整段替换** `config`，必须重述全部键。

## 3. 插件边界

| 面 | 位置 | 职责 |
| :--- | :--- | :--- |
| host | `packages/dsh-hk-craft/src/index.js` | 宿主服务、工具、路由、会话粘合；经 Cordis `ctx` 使用 dsh 公开能力 |
| client | `packages/dsh-hk-craft/src/client/` | 浏览器面板 / 设置页；构建为 `lib/client.js`，经 `dsh.client` 声明 |
| config | `packages/dsh-hk-craft/cordis.patch.yml` | 只插入一条 `dsh-hk-craft` 行；不复制上游配置 |

host 与 client 同属一个包、同一版本，避免半套升级。客户端入口 id 必须与 patch 行 `name` 完全一致。

client 依赖的 dsh 契约（`main` 键控槽、`selectPanel`、`SessionProvider`、会话保留、
`conversation.content`、视图切换、命令面板、工作区目录等）逐条记录在
[`upstream-contracts.md`](upstream-contracts.md)，代码注释指向那里而不是临时目录或上游行号。

## 4. 为什么不设 `apps/`

模板默认的 launcher + 产品 profile + 桌面壳会引入第二个启动入口、独立 home 与端口，和“完全在 dsh 中使用”冲突。ADR-0001 已明确取代该形态。需要新的宿主进程能力时，应优先使用 dsh 的插件服务与工具接口，而不是新建应用入口。

## 5. 工作区状态与五态灯

这是**插件内部的 UI 定义**，不是上游契约；dsh 侧的布局键归属、`blank` 字段、`completionUnread`
与会话汇总形状见 [`upstream-contracts.md`](upstream-contracts.md)。

- **启用（工作区）**：该工作区在分屏里打开过。判据只有两条——窗格控制器里有已加载的布局，
  或插件自己的布局键 `dsh.hkcraft.layout.v1.<workspaceId>` 存在。原生视图里打开工作区不算启用：
  它走 `uiWorkspace.startSession`/`openSession`，从不经过窗格控制器，也不会写键。
  删除工作区后插件清掉该键，避免重启后出现“幽灵”灰灯行。
- **五态灯**：灰 = 未启用，或已启用但还没有对话开始（会话全是空白）；**蓝（空闲）** = 已启用、
  至少一段对话已经开始，且当前没有运行、等待或未读完成；绿 = 至少一段对话在你不在看时结束
  （dsh 的 `completionUnread`），且当前没有运行或等待；黄 = 有会话运行中；红 = 有会话等你操作
  （审批 / 提问 / 计划确认）。
  优先级红 > 黄 > 绿 > 蓝 > 灰。灰灯是“没有已开始的对话”的兜底，不是“最近没活动”；
  会话列表未就绪（`phase` 不是 `ready`）时也全部按灰处理。
- **未读完成**：`completionUnread` 在非当前会话由运行转为空闲时置位，在该会话成为当前会话
  （例如被聚焦）或再次开始运行时清除。因此后台跑完的窗格先亮绿，回到该工作区查看后回到蓝。
  重启后已经空闲的工作区没有未读完成，显示蓝而不是绿。
- **计算位置**：`workspace-status.js` 只吃纯信号（`running` / `waiting` / `started` / `unread`）
  与“启用集合”，不读 dsh 记录；`dsh-workspaces.js` 把快照转成这些信号，侧栏与窗格控制器通过
  公开服务提供“是否启用”。没有错误灯：dsh 没有可靠的“上一回合失败”字段。

## 6. 当前状态

插件已交付首个能力 **多会话分屏 + 侧栏精简**（ADR-0005 ~ 0014），并在其上补齐本轮管理功能
（ADR-0007/0008）。分屏 shadow `main` 的 `conversation` 单元格，不改变 `activePanelId`
（ADR-0014）：

- **分屏**：shadow `main.conversation`（priority -1），全程不调用 `selectPanel`，所以
  `activePanelId` 保持 null，原生右侧栏保持可见，并跟随焦点窗格的 `mainView`。每个窗格承载恰好一个会话；`+`、`Ctrl+Shift+E` 与
  `/resume` 的 Ctrl+Enter 在焦点窗格右侧插入新窗格，并按当前窗格数均分这一排的宽度，不重排顺序。
  每个工作区默认最多 4 格，可在 HK Craft 设置页改为任意格数（`0` = 不限制）。降低上限不会关闭
  已有窗格，也不会取消已经通过检查、会话还在创建的那一次分栏。空工作区没有焦点窗格时
  `Ctrl+Shift+E` 无操作；第一格由 `+` 和 Ctrl+Enter 打开，不占预算。第一格还在创建时再次
  「新会话」会被忽略；创建返回时只在原工作区仍然空着时落地，不把可见工作区切回去。窗格数不等于
  会话数。进行中的交叉见 ADR-0010。
- **窗格头部工具栏**：每个窗格顶部显示自己的标题、只读**当前模式**、**子代理查看**、视图切换与
  关闭；模式与子代理读该窗格自己的会话，而不是焦点窗格。标签条只保留标签与紧贴最后标签的
  `+`。滚动区外有一个共享的右侧栏开关，调用 `ctx.sidebarRight.toggleExpanded()`；服务不存在时
  不显示按钮。窗格里的文件和图片链接打开焦点窗格会话的原生右侧栏
  （[`upstream-contracts.md`](upstream-contracts.md#shadowing-the-conversation-cell)、
  [`#sidebar-right-toggle`](upstream-contracts.md#sidebar-right-toggle)）。
- **侧栏工作区**：五态灯（含空闲蓝与未读完成绿）、行内删除（二次确认，不中断会话）、指针拖动
  排序（Host 持久化顺序），以及“添加工作区”。
- **HK Craft 设置页**：诊断信息内联展示、分屏上限设置（默认 4，`0` = 不限制，持久化到
  `dsh.hkcraft.settings.v1`）；侧栏 footer 不再注入按钮。
  插件加载并 shadow `conversation` 后进入分屏，设置页不提供回到原生视图的开关。
  打开设置时右侧栏按原生规则隐藏；回到会话后分屏与右侧栏一起恢复。
  写入失败时内存中的上限仍然生效，页面显示失败原因；读失败或值非法回落到 4。
- **桌面通知**：五类——等待授权 / 等待回答 / 计划待审阅 / 本轮完成 / 本轮失败。前三种来自
  `sessionStatus.pendingInteraction.kind`，完成来自 `running` 的 true→false，失败来自
  `api-session/error`；失败优先于紧随其后的完成，子代理会话不单独通知。默认始终通知；可在设置页
  勾选“dsh 在前台且该对话可见时不再通知”，此时焦点窗口里已显示的对话（原生主对话或分屏当前
  工作区任一窗格）不弹系统通知，其它工作区仍通知。点击通知聚焦 dsh 并切到该会话（分屏内
  聚焦/新开窗格，原生视图走 `openSession`）。设置页有总开关、五类开关、声音、前台抑制、
  权限状态与测试按钮，设置存 `localStorage["dsh.hkcraft.notifications.v1"]`。
  通知不改变五态灯与 `completionUnread`；不可用/被拒时安静降级。见 ADR-0012 / ADR-0013。
- **兼容与降级**：新增的可选能力（Agent 预设名册、子代理目录、设置分区、桌面通知）在服务缺失时安静降级；
  上游契约集中在 [`upstream-contracts.md`](upstream-contracts.md)，升级时按该清单复验。

## 7. 验证

```powershell
pnpm check     # manifest / patch / 入口一致性
pnpm test      # 单元测试
# 安装：dsh → Plugins → Add plugin → 本地目录
#      C:\Agent\Agent14-dsh-hk-craft\packages\dsh-hk-craft
# 重启 dsh，确认行装载无错误
# 卸载：dsh → Plugins → Installed plugins → dsh-hk-craft
```
