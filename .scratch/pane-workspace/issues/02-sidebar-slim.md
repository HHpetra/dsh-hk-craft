# 02: 侧栏工作区区块精简

**What to build:** 侧栏里每个工作区只显示一个状态灯和名称，不再列出任何会话、不提供展开与折叠；底部保留唯一的「添加工作区」。点击工作区照常切换。侧栏其余部件（品牌区、折叠开关、Plugins／自动化图标行、More 菜单、Settings、底部动作）保持原样，行为不变。

**Blocked by:** 01

**Status:** resolved

- [x] 工作区行只含状态灯与名称；无会话行、无会话行悬停操作、无分组模式切换、无折叠、无归档筛选、无区块内搜索
- [x] 状态灯三态正确且优先级为红 > 黄 > 绿：红=有会话在等你（审批／追问）或出错，黄=有会话运行中，绿=无活动会话
- [x] 「添加工作区」仍可创建并选中新工作区；点击已有工作区仍能切换
- [ ] 侧栏其余部件与原生行为完全一致（含窄屏折叠）（待人工：安装后目视）
- [ ] 卸载并重启后侧栏恢复原生形态，无残留样式或空槽（待人工）

## Comments

**交付**（`packages/dsh-hk-craft/src/client/`）：
`workspace-status.js`（纯函数：灯的三态与优先级、会话信号归一化、工作区投影、默认标题）、
`workspace-status.test.js`、`dsh-workspaces.js`（唯一 dsh 适配层，含逐条 `文件:行` 依据）、
`dsh-workspaces.test.js`、`sidebar-workspaces.js`（组件）、`index.js`（以 `priority: -100` 覆盖 `sidebar.workspaces`，
经 `ctx.inject(['uiWorkspace','workspaces'])` 等两个服务就绪）、`locale.js`（7 个新 key）。

**已核实的关键 API**（解包源码，见适配层注释）：`sidebar.workspaces` 是 `single` 槽，由侧栏以
`{wide, expandSidebar}` 渲染；槽核心按 `priority ?? 0` 升序取第一个 → 内置 ui-workspace 注册为 0，负数即覆盖。
切换工作区 = `uiWorkspace.startSession(id, {clearPreviousDraft:false})`；添加 = dsh 自己的
`pickDirectory()`（Electron 下走 `globalThis.__DSH_DIRECTORY_PICKER__.pick()`）→ `workspaces.create({path})` →
`startSession(newId, {clearPreviousDraft:false})`。工作区记录 `{workspaceId,path,title,sessionIds,...}`，
`workspaces.list` 快照 `{items,archivedSessionIds,phase}`，`sessionStatus` 是 `Map<id,{running,pendingInteraction}>`。

**缺口（记录在案）**：
1. **“出错”红灯暂无数据源**：客户端 `sessionStatus` 只有 running/pendingInteraction/completionUnread，
   宿主 `SessionSummary` 没有 error 字段，回合失败只是对话里的节点。红灯当前只覆盖“在等你”；
   `workspace-status.js` 已保留 `errored` 入参，接上数据源只需改适配层一行。
2. **`Mod+O`（添加工作区）/`Mod+K`（区块内搜索）快捷键的消费方是原生的 WorkspaceBrowser**，本票把它整块换掉，
   两个快捷键因此变成空操作（`Mod+K` 本就随 D7 移除；`Mod+O` 是副作用）。添加工作区按钮本身正常。
3. 构建前置 `src/build/bundle-client.mjs` 在 01 的提交里缺失（`build-client.mjs` 引用它但未入库），
   本票补上并加了 `bundle-client.test.mjs`，否则 DoD 的 build 步骤不可能通过。

**已跑**：`node --test` 55 项通过；`check-bundle` 29 项通过；bundle 28.5 kB / 6 模块；
另有一次性冒烟：在 Node 里用假 `window.__ModuleLoader__` + 假 react 求值构建产物并渲染一行红灯，通过（临时脚本未入库）。

**待人工验证**：安装到 desktop → 重启：工作区只剩灯+名、点行切换、添加工作区（原生选目录、新工作区被选中）、
窄屏折叠时只剩一个 ＋ 图标、卸载重启后侧栏恢复原生形态。
