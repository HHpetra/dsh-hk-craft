# dsh-hk-craft — 领域语言

最小词汇表。写文档、代码与 spec 时以本表为准；插件能力确定后再补业务术语。

## Language

**dsh / DeepSeek Harness**:
运行本插件的宿主 agent harness；本项目只通过其公开插件机制扩展，不 fork 上游。
_Avoid_: 把 dsh 称作“框架”或“SDK”（除非确实指 SDK 包）。

**profile**:
`$DSH_HOME/profiles/<name>` 下的一个可运行组合；本插件默认装入 `desktop`。
_Avoid_: 把 profile 称作“实例”或“环境”。

**bundle**:
带 `dsh.bundle.patch` 声明的 npm 包，向 profile 贡献一层 Cordis 配置。本项目的 `packages/dsh-hk-craft` 就是一个 bundle。
_Avoid_: 把 bundle 称作“插件包”而混淆 host/client 两面。

**row（插件行）**:
`cordis.patch.yml` 里按 `id` 寻址的一条插件配置。本 bundle 目前只插入 `dsh-hk-craft` 一行。
_Avoid_: 把 row 称作“模块”。

**host plugin**:
运行在 dsh 宿主进程内的插件面：服务、工具、路由、会话粘合。
_Avoid_: 后端（容易与独立服务混淆）。

**client plugin**:
运行在 dsh Web 壳浏览器内的插件面，经 `dsh.client` 声明并由 `lib/client.js` 提供。
_Avoid_: 前端应用、第二套 UI。

**workspace**:
dsh 会话绑定的工作目录；本插件若涉及文件能力，以 dsh workspace 为准，不自建目录根。

**能力（capability）**:
本插件对 dsh 用户提供的具体功能。首个能力：**多会话分屏 + 侧栏精简**（见 `.scratch/pane-workspace/spec.md`）。

**会话（session）**:
一段持久的对话历史，有唯一 id，存在磁盘上；它的生命周期不取决于界面上看不看得见它。
_Avoid_: 把"会话"说成"窗口"或"进程"。

**对话（chat）**:
一个会话的默认查看方式（与"轨迹"相对）。它不是容器，不持有会话。
_Avoid_: 用"对话"泛指一个会话整体（那是"会话"）。

**视图（view）**:
一个会话在窗格里的查看方式，取值"对话"或"轨迹"。视图不是标签：不可关闭、不计入数量、不独立成窗格。
_Avoid_: 把视图称作 tab / 标签 / 页签。

**窗格（pane）**:
主界面里承载**恰好一个**会话的矩形显示区。关掉窗格就是关掉其中的会话；但切换工作区只改变哪些窗格可见，不关闭任何窗格。
_Avoid_: 把窗格称作"窗口"（窗口属于操作系统）、"tab"、"面板"。

**布局树（layout tree）**:
一个工作区里窗格的分割结构（横向/纵向嵌套）。每个工作区各自一棵，互不影响；树里只装本工作区的会话。
_Avoid_: 把布局树称作"分屏模式"（那是用户对整体能力的称呼，不是结构）。

**标签条（tab strip）**:
主区域顶部横向列出"当前工作区已打开的会话"的条，点一项即聚焦它所在的窗格。它是窗格的索引，不是另一层容器。
_Avoid_: 把标签条称作"对话列表"（对话列表已从侧栏移除）。
