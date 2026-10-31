# dsh-hk-craft

DeepSeek Harness（dsh）的**原生插件**。以一个可安装组合包（bundle）接入你已有的 dsh profile，在 dsh 现有 Web UI / 会话中直接使用。

**不提供**启动器、桌面外壳、独立 `DSH_HOME`、独立端口或第二套界面。

## 状态

**首个能力已交付**：多会话分屏 + 侧栏精简，并补齐侧栏工作区管理（五态灯、删除确认、拖动排序）、HK Craft 设置页与窗格头部工具栏。关键决策见 [ADR-0005 ~ 0010](ai-docs/ADR/decisions.md)，上游契约清单见 [`doc/upstream-contracts.md`](doc/upstream-contracts.md)。

- **多会话分屏**：每个窗格承载一个会话；`+`、`Ctrl+Shift+E` 和 `/resume` 的 Ctrl+Enter 参考 dsh 右侧栏的分栏逻辑，在焦点窗格旁生成等宽兄弟窗格，而不是重排整排。没有焦点窗格时 `Ctrl+Shift+E` 不产生分栏。每个工作区默认最多 4 格，可在 HK Craft 设置页改成任意格数，填 `0` 表示不限制；已经开始创建的分栏不会因为中途把上限调低而被取消。窗格数不等于会话数。每个窗格头部显示自己的标题、当前模式、子代理查看、视图切换与关闭，标签条只保留标签和紧贴的 `+`。
- **侧栏精简与工作区管理**：工作区行有五态灯（灰/蓝空闲/绿未读/黄/红）、行内删除（二次确认、不中断运行中的会话）与指针拖动排序（顺序由 Host 持久化）。

插件仍以 bundle 形式装入现有 dsh profile，不改变 dsh 的端口、home 与登录态；安装后需重启 dsh 生效。

## 依赖

| 依赖 | 版本 | 说明 |
| :--- | :--- | :--- |
| Node.js | `^22.19.0 \|\| >=24.0.0` | 根 `package.json` `engines.node` |
| pnpm | `12.5.1` | 由 `packageManager` 钉死；拒绝 npm/yarn |
| `@deepseek-ai/dsh`（Desktop 运行时） | `0.2.1-rc.5` | `desktop` profile 实际加载的运行时；本插件作为其 profile bundle 安装 |
| 全局 `dsh` CLI | `0.2.0-rc.2`（本机） | 只用于非 `desktop` 试验 profile；与上一行不是同一列车 |
| dsh profile | `desktop` | 默认安装目标；沿用其 home、端口与 Web UI |

版本真源见 [`deps/VERSIONS.md`](deps/VERSIONS.md)。

## 安装与卸载

`desktop` profile 由 Electron 应用独占管理，**不能**用 CLI `dsh plugin --profile desktop ...` 安装；CLI 会返回 `profile "desktop" is managed exclusively by the Electron application`。安装走 dsh 自带的插件面板：

1. 在仓库根执行 `pnpm install && pnpm build && pnpm check && pnpm test`。
2. 打开 dsh → 侧边栏 **Plugins** → **Add plugin**。
3. 选择 **Install a third-party plugin**，填入本目录的绝对路径：
   `C:\Agent\Agent14-dsh-hk-craft\packages\dsh-hk-craft`
4. 安装完成后重启 dsh，使新 bundle 行装载。
5. 卸载：**Plugins → Installed plugins → dsh-hk-craft → 卸载**，再重启。

也可以在**非 desktop** 的试验 profile 上用 CLI 做安装冒烟（会新建该 profile，不影响 desktop）：

```powershell
dsh plugin --profile craft-smoke add ./packages/dsh-hk-craft
```

注意 `dsh` 指向的是全局 npm CLI，不一定和 Desktop 内置运行时同一列车（本机 CLI 为 `0.2.0-rc.2`，Desktop 为 `0.2.1-rc.5`）。CLI 版本不满足 `engines.dsh` 时先按同一列车升级，这条冒烟才成立；`desktop` 的安装与冒烟不受影响。

开发命令：

```powershell
pnpm test                # 包内单元测试
pnpm build               # 构建客户端 bundle lib/client.js
pnpm check               # 校验 manifest / patch / 入口与已构建 bundle 一致
```

## 目录说明

| 路径 | 用途 |
| :--- | :--- |
| `packages/dsh-hk-craft/` | 唯一可安装 bundle：manifest、`cordis.patch.yml`、host 入口、客户端 UI 与构建脚本 |
| `doc/` | 架构与关键原理（长期） |
| `ai-docs/ADR/` | 架构决策记录（长期） |
| `.scratch/` | 当前开发记录：按 feature 组织的 spec 与 issue（短期） |
| `GLOSSARY.md` | 领域语言（术语表，长期） |
| `docs/agents/` | 工程类 skill 的消费规则：issue 跟踪器、triage 标签、域文档 |
| `ai-docs/invest/` | 技术调研与可行性 |
| `scripts/` | 结构校验与冒烟 |
| `tests/` | 跨包冒烟与 fixtures |
| `deps/` | 钉死的第三方版本 |

没有 `apps/`：本项目不设独立应用入口，这是刻意的架构约束（ADR-0001）。

## 延伸阅读

- [`doc/README.md`](doc/README.md) — 架构说明
- [`ai-docs/ADR/decisions.md`](ai-docs/ADR/decisions.md) — 架构决策记录
- [`AGENTS.md`](AGENTS.md) — 协作者与编码 Agent 的约定
- [`START.md`](START.md) — 新项目启动与分轮设计流程
- [`GLOSSARY.md`](GLOSSARY.md) — 领域语言

## 许可

MIT. Copyright (c) 2026 HHpetra.
