# 03: `/clear` 与 `/resume` 两条客户端命令

**What to build:** 在输入框敲 `/clear` 立即开一个新会话（旧会话留在历史里）；敲 `/resume` 弹出当前工作区的历史会话选择器，↑↓ 选择、Enter 切换、Esc 取消，选中后当前会话换成它。两条命令都在本地执行，不把任何内容发给模型。

**Blocked by:** 01

**Status:** ready-for-human

- [ ] 两条命令出现在 `/` 触发菜单中，名称与描述在中文与英文下都有文案
- [ ] `/clear` 新建会话并把当前视图切过去；旧会话仍可从 `/resume` 找回
- [ ] `/resume` 只列当前工作区；按最近活动倒序；过滤空会话（无任何消息的会话）
- [ ] 有标题时显示标题，无标题时回退显示首条提问（截断），两者都无则显示占位名
- [ ] 支持模糊匹配标题与首条提问；无结果显示明确空态
- [ ] 运行中的会话在列表中带运行中标识，但不改变排序
- [ ] Enter 切换当前会话；Esc 关闭选择器且不改变任何状态
- [ ] 整个过程中没有任何请求发给模型（可在会话记录中核对）

> 注：`Ctrl+Enter`「在聚焦窗格旁新开一格」依赖窗格，随 06 提供，不在本票验收范围内。

## Comments

- 落点：`commands.js`（两条 `commandUi.register` 贡献）、`resume-list.js`（纯列表构造：过滤/排序/标题回退/截断/模糊匹配）、
  `dsh-sessions.js`（唯一的 dsh 适配层，注释里逐条标了核实位置）。`index.js` 用 `ctx.inject(COMMAND_SERVICES)` 挂载命令，
  缺少服务时只退化掉命令，不影响 01 的页脚入口与 02 的侧栏区块。
- 已核实：popupSelect 的 `fuzzy-label` 只匹配 `option.label`（`dsh-client-ui-commands/lib/client.js:1026-1036`）。
  为满足"标题与首条提问都能模糊匹配"，列表把首条提问摘要并进 label（`标题 · 提问`），`detail` 放相对活动时间，
  `badge` 放"运行中"。没有用 `substring` 模式，因为 spec D9 指定 `fuzzy-label`。
- 已核实：`/clear` = `uiWorkspace.startSession(workspaceId)`（复用该工作区已有空白会话，否则新建）；
  `/resume` 选中 = `uiWorkspace.openSession(sessionId)`（`dsh-client-ui-workspace/lib/client.js:1471-1528, 1652-1675`）。
  两者都会 `selectPanel(null)`；**04/06 接窗格后必须换成窗格内的切换动作**，否则会退出窗格面板。
- 首条提问没有线上投影，只能打开会话事件窗口读取（`sessions.using` + `loadOlder`），所以仅对缺标题的非空会话做，
  最多 6 个、每个最多回翻 4 页；失败/超限降级为占位名，不影响其余行。
- 已跑（并入 `feat/pane-workspace` 后）：esbuild 产出 `lib/client.js` 33.9 kB；`node --test --test-isolation=none` 104 项通过；
  `check-bundle` 29 项通过。
- **待人工验证**（装到 desktop → 重启 dsh）：
  1. 输入 `/`：能看到「新会话」「恢复会话」两条（中英文各看一次）。
  2. `/clear` Enter：出现新会话，旧会话仍在 `/resume` 列表里。
  3. `/resume`：只列当前工作区、最近活动在前；运行中的会话带"运行中"角标且不置顶；标题词与首条提问里的词都能筛出；
     乱码显示"没有匹配的会话"；Esc 后当前会话不变。
  4. 两条命令执行后在会话记录里核对：没有新增模型请求。
