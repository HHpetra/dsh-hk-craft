# dsh-hk-craft

`dsh-hk-craft` 是一个 **DeepSeek Harness（dsh）原生组合包（bundle）**。

- 装入你已有的 dsh profile（默认 `desktop`），在 dsh 现有 Web UI / 会话中使用；安装入口是 dsh 的 **Plugins** 面板。
- **不提供**启动器、Electron/Tauri 外壳、产品专属 `DSH_HOME`、独立端口或第二套聊天界面。
- **不 fork** `@deepseek-ai/dsh*`；只通过 bundle 的 `cordis.patch.yml` 贡献插件行。

本包交付的能力：

- **多会话分屏**：插件加载后默认进入分屏。每个窗格承载一个会话；`+`、`Ctrl+Shift+E` 和 `/resume` 的 Ctrl+Enter 参考 dsh 右侧栏的分栏逻辑，在焦点窗格旁生成等宽兄弟窗格，而不是重排整排。没有焦点窗格时 `Ctrl+Shift+E` 不产生分栏，第一格由 `+` 或 Ctrl+Enter 打开。每个工作区默认最多 4 格，可在设置页改成任意格数，填 `0` 表示不限制；已经开始创建的分栏不会因为中途把上限调低而被取消。窗格数不等于会话数。每个窗格头部显示自己的标题、只读当前模式、子代理查看、视图切换与关闭，标签条只保留标签和紧贴的 `+`。
- **侧栏精简与工作区管理**：工作区行有五态灯（灰/蓝空闲/绿未读/黄/红）、行内删除（二次确认、不中断运行中的会话）与指针拖动排序（顺序由 Host 持久化）。
- **HK Craft 设置页**：内联诊断、分屏上限设置与临时的分屏切换入口；侧栏 footer 不再注入按钮。上限写不进去时，这一次修改仍留在内存里，页面会提示保存失败。

决策见仓库 `ai-docs/ADR/decisions.md`（ADR-0005 ~ 0010），上游契约见 `doc/upstream-contracts.md`。

## 安装

`desktop` profile 归 Electron 应用独占管理，CLI 的 `dsh plugin --profile desktop ...` 会被拒绝。请在 dsh 的 **Plugins → Add plugin → Install a third-party plugin** 中填入本目录的绝对路径，安装后重启 dsh。

仓库根的命令：

```powershell
pnpm install
pnpm check
pnpm test
```

包管理器的实际行为：用 pnpm 把本目录链接进 profile、确认 `engines.dsh`、把本包追加到 profile 的 `dsh.profile.bundles`。它不会改写 profile 端口、home 或已有插件配置。卸载在 **Plugins → Installed plugins** 中进行。

## 包结构

| 路径 | 作用 |
| :--- | :--- |
| `package.json` | `dsh.bundle.patch` 声明本包贡献的配置层 |
| `cordis.patch.yml` | 插入 `dsh-hk-craft` 行 |
| `src/index.js` | Host 侧插件入口（当前无宿主服务，仅装载与日志） |
| `src/client/` | 浏览器侧 UI：分屏窗格、窗格头部工具栏、侧栏工作区、HK Craft 设置页；由 `dsh.client` 声明，构建为 `lib/client.js` |

## 约定

- 一个可安装包同时承载 host 与 client 两面；客户端入口由 `dsh.client` 声明，构建为 dsh Web 壳的 `__ModuleLoader__` 格式。
- dsh 版本列车由 `engines.dsh` 与 peer 依赖钉住；升级时一起改，不混列车。
- 只在仓库根 `pnpm install`。
