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
本插件对 dsh 用户提供的具体功能。**当前待确认**；能力确定前不得在代码或文档中写死。
