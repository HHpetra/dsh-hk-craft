# 10: 打磨

**What to build:** 把多窗格从「能用」做到「顺手」：把一个标签拖到另一个标签上就交换两格的内容（布局形状不变）；一个窗格都没有时给出空态引导；快捷键覆盖常用动作且界面提示与实际一致；状态点变化时不抖动。

**Blocked by:** 06, 07, 08, 09

**Status:** resolved

- [x] 拖动标签到另一标签上交换两格的会话内容，树形状与比例保持不变；拖到空白处不产生任何副作用
- [x] 空态：无窗格时显示引导，可直接新建会话，或从最近会话里挑一个打开
- [x] 快捷键覆盖聚焦第 N 格、分割、关闭、新会话，且界面提示文案与实际键位一致
- [x] 状态点在运行／等待／空闲之间切换时平滑过渡（背景色 120ms），且不引起布局跳动
- [x] 焦点描边、标签高亮、悬停关闭在浅色与深色主题下都清晰可辨

## Comments

### 实现与验证（2026-10-30）

**拖拽交换**：纯转换 `layout-tree.js:swap(a,b)` 只交换两个 `paneId` 上的记录（`sessionId` + 每格 `view`），叶子、树形、ratio、`activePaneId` 一律不动；同一格/未知格返回原对象。控制器 `swapPanes` 拒绝跨工作区（一棵树只装一个工作区，D3）。标签条用 pointer events（无 HTML5 DnD）：6px 阈值、指针捕获 + `elementFromPoint` 命中目标、目标标签虚线描边 + 强调底色、源标签半透明；拖到空白处只有一次被吞掉的 click，不 swap、不改焦点、不写布局（单测断言 `getSnapshot()` 对象不变、无 retain）。关键次序修复：`reconcileAll` 改为**先取新引用、再放旧引用**，否则 A/B 两格的会话在交换瞬间引用数归零，dsh 会拆掉客户端 generation、丢滚动位置与草稿；单测记录 retain/release 事件并断言两个会话都不会先 release。

**空态**：`controller.recentConversations(workspaceId)` → `dsh-sessions.js:listWorkspaceConversations`，与 `/resume` 共用 `conversationsOf` + `fillFirstPrompts`（首条提问回退）→ 视图再用 `buildResumeRows` 做过滤/排序/截断，取最近 5 条；点击某条走 `controller.activate(sessionId)` 打开第一格。没有另写一套列表构造。

**快捷键表**（唯一真源：`pane-shortcuts.js`；监听与 tooltip/hint 都从同一张表生成，故提示不可能与实际键位不一致）：

| 动作 | 键位 | 对照 dsh catalog 的结论 |
| :--- | :--- | :--- |
| 聚焦第 N 格 | `Ctrl+1`–`Ctrl+4` | dsh 全局表无任何数字键绑定 |
| 向右分割 | `Ctrl+Shift+E` | 未占用（dsh 字母键只占 N/K/O/B/G/F/A/T/Comma） |
| 向下分割 | `Ctrl+Shift+D` | 未占用 |
| 关闭窗格 | `Ctrl+Shift+X` | 未占用 |
| 新会话 | `Ctrl+Shift+N` | 与 dsh `session.new` 的 `Mod+N`（Web 为 `Mod+Alt+N`）不同组合；此外窗格面板显示时 `Mod+N` 本身被接管为「聚焦窗格换新会话」（D8，见 `commands.js`） |

核对来源：`dsh-client-ui-workspace`（session.new/search/workspace.add/rename/fork/archive）、`dsh-client-ui-layout`（左栏 Mod+B）、`dsh-client-ui-sidebar-right`（右栏 Mod+Alt+B / Web Mod+Shift+B、`pane.split`=Mod+\、`pane.fullscreen`=Mod+Alt+Enter、page close/refresh=Mod+W/R）、`dsh-client-ui-settings-general`（Mod+,）、`dsh-client-ui-sidebar-browser`（Mod+T）、`dsh-client-ui-conversation` 的 fixed inputs（Enter / Shift+Enter / Mod+Enter / `/` / `@` / `Esc Esc`）。**假设**：提示按 Windows/Linux 写 `Ctrl`（macOS 同组合的 Meta 也接受）；`Ctrl+Shift+N` 在 Chrome/Edge 是「无痕窗口」且网页通常拦不住，但本项目唯一支持的安装路径是 desktop 应用，页面收得到该键；若实测被壳/系统占用，改 `pane-shortcuts.js` 一处即可，提示自动跟随。快捷键在 dsh 模态层打开时整体让位（与壳的 shortcut service 一致）。

**状态点与主题**：状态点固定 7px、始终渲染，只换颜色，并加 `background-color 120ms ease` 过渡（运行／等待／空闲三态；dsh 无失败信号，没有"出错"态，见 spec §7）；焦点不再改 `fontWeight`（原先 400→600 会改变标签宽度、推动整条 strip），标签关闭按钮继续用 `visibility` 保留占位。点用「背景色内圈 + `currentColor` 外圈」双层 `box-shadow`，不参与布局。焦点描边改用壳真实存在的 `--dsw-focus-ring-color` → `--dsw-alias-state-business-primary`；标签高亮用 `--dsw-alias-state-business-primary` / `--dsw-alias-interactive-bg-hover`；分隔条 `currentColor` 30%（悬停 55%）、窗格头分隔线 22%。已用 `ctx.theme` 的消费方式核对：`ThemePresenter` 把 `color-scheme`、调色板 token 与 `data-ds-dark-theme` 写在 document/body 上，所以这些 token 与 `color-mix(currentColor…)` 在明暗两套主题下都会重算，不需要额外订阅 theme。

**顺带修掉的旧票问题**：① `--dsw-alias-border-accent` 在 dsh 里根本不存在（焦点描边一直只落到系统 `Highlight`），换成已核实的 token 链；② 焦点标签的 `fontWeight` 造成宽度跳动；③ `reconcileAll` 先 release 后 retain 的次序（见上）；④ 标签右侧分隔线与窗格头分隔线对比度偏低（12%/18% → 18%/22%）。

**测试**：303 passed（新增 17：swap 3、控制器 swap/引用次序 4、快捷键 6、状态顺序稳定 1、`listWorkspaceConversations` 2、`recentConversations` 1）。`pnpm build` 通过（17 modules），`node scripts/check-bundle.mjs` 29/29。

**待人工验证**（本机无 dsh 运行时，未做真实 UI 冒烟）：① 两个真实会话之间拖拽，交换后两格的流式输出/滚动位置/草稿是否都在（引用次序修复的现场验证）；② 拖到标签条空白处确实无任何变化；③ `Ctrl+Shift+N/E/D/X` 在 desktop 壳里是否被系统或壳抢占（尤其 N）；④ 空态最近会话的标题/首条提问回退是否与 `/resume` 完全一致；⑤ 明暗主题下焦点描边、标签高亮、分隔条、悬停关闭的实际对比度。
