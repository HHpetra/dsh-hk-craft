# dsh-hk-craft

DeepSeek Harness（dsh）的**原生插件**。以一个可安装组合包（bundle）接入你已有的 dsh profile，在 dsh 现有 Web UI / 会话中直接使用。

**不提供**启动器、桌面外壳、独立 `DSH_HOME`、独立端口或第二套界面。

## 状态

**初始化 / 设计阶段。** 仓库已具备可安装、可卸载的 bundle 骨架；插件的具体能力、客户端 UI 与数据通道尚未确定（见 [`ai-docs/spec/00-scope.md`](ai-docs/spec/00-scope.md)）。在能力确定前，骨架只装载一个无副作用的 host 行，不改变 dsh 行为。

## 依赖

| 依赖 | 版本 | 说明 |
| :--- | :--- | :--- |
| Node.js | `^22.19.0 \|\| >=24.0.0` | 根 `package.json` `engines.node` |
| pnpm | `12.5.1` | 由 `packageManager` 钉死；拒绝 npm/yarn |
| `@deepseek-ai/dsh` | `0.2.0-rc.2` | 当前机器上安装的 CLI；本插件作为其 profile bundle 安装 |
| dsh profile | `desktop` | 默认安装目标；沿用其 home、端口与 Web UI |

版本真源见 [`deps/VERSIONS.md`](deps/VERSIONS.md)。

## 安装与卸载

`desktop` profile 由 Electron 应用独占管理，**不能**用 CLI `dsh plugin --profile desktop ...` 安装；CLI 会返回 `profile "desktop" is managed exclusively by the Electron application`。安装走 dsh 自带的插件面板：

1. 在仓库根执行 `pnpm install && pnpm check && pnpm test`。
2. 打开 dsh → 侧边栏 **Plugins** → **Add plugin**。
3. 选择 **Install a third-party plugin**，填入本目录的绝对路径：
   `C:\Agent\Agent14-dsh-hk-craft\packages\dsh-hk-craft`
4. 安装完成后重启 dsh，使新 bundle 行装载。
5. 卸载：**Plugins → Installed plugins → dsh-hk-craft → 卸载**，再重启。

也可以在**非 desktop** 的试验 profile 上用 CLI 做安装冒烟（会新建该 profile，不影响 desktop）：

```powershell
dsh plugin --profile craft-smoke add ./packages/dsh-hk-craft
```

开发命令：

```powershell
pnpm test                # 包内单元测试
pnpm build               # 构建（当前无 client，等价于空操作）
```

## 目录说明

| 路径 | 用途 |
| :--- | :--- |
| `packages/dsh-hk-craft/` | 唯一可安装 bundle：manifest、`cordis.patch.yml`、host 入口、后续 client UI |
| `doc/` | 架构与关键原理（长期） |
| `ai-docs/ADR/` | 架构决策记录（长期） |
| `ai-docs/spec/` | 当前开发记录（短期） |
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
- [`CONTEXT.md`](CONTEXT.md) — 领域语言

## 许可

MIT. Copyright (c) 2026 HHpetra.
