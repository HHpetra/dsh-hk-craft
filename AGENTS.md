# dsh-hk-craft — Agent 指南与项目规范

## 1. 项目简介

- **项目名称**：dsh-hk-craft
- **定位**：DeepSeek Harness（dsh）的**原生插件**。以一个可安装组合包（bundle）装入用户已有的 dsh profile，在 dsh 现有 Web UI / 会话里使用。
- **交付形态**：`packages/dsh-hk-craft` 是唯一可安装包，通过 dsh 的 **Plugins → Add plugin → 本地目录** 装入 `desktop` profile。
- **明确不做**：
  - 不做启动器、Electron / Tauri 外壳或任何第二套启动界面。
  - 不建产品专属 `DSH_HOME`、独立 profile、独立端口。
  - 不 fork / 不改 `@deepseek-ai/dsh*` 源码。
  - 不复制一套聊天 UI；客户端能力只作为 dsh Web 壳的插件行接入。
- **愿景**：待确认。插件要解决的问题由用户在后续设计对话中描述；在此之前不把任何具体功能写死。
- **当前阶段**：**初始化 / 设计阶段**。仓库已有可安装、可卸载的骨架；业务能力与客户端 UI 尚未实现。

---

## 2. 当前阶段的核心目标

1. 确定插件要解决的问题、目标用户与首个可验收的垂直切片。
2. 保持“**装入现有 dsh**”这一交付形态：安装只增加 profile 的 bundle 依赖与插件行。
3. 建立可重复的验证链：`pnpm check` → `pnpm test` → 本地安装 → 重启 dsh → 卸载，且不残留 profile 改动。

---

## 3. 目录与文档规范

| 目录路径 | 用途说明 | 保留策略 |
| :--- | :--- | :--- |
| `packages/dsh-hk-craft/` | **唯一可安装 bundle**：manifest、patch、host 入口、后续 client UI 与构建脚本 | 长期 |
| `doc/` | 面向用户与 Agent 的**架构与关键原理**介绍 | **长期保留**；只写架构与原理，不写实现细节与过程性 spec |
| `ai-docs/ADR/` | **架构决策记录（ADR）**：长期真源，只记关键决定 | **长期保留**；前期可合并为单文件，条目变多后按主题拆分 |
| `.scratch/` | 按 feature 组织的 **spec、issue 与开发记录**（本地 markdown issue 跟踪器） | **短期**；需**经常清理**，不做长期归档 |
| `GLOSSARY.md` | 根目录：**领域语言**（术语与要避免的同义词） | 长期保留；术语收敛时更新 |
| `docs/agents/` | 供工程类 skill 读取的消费规则：issue 跟踪器、triage 标签、域文档 | 长期保留 |
| `ai-docs/invest/` | 可行性研究与技术调研文档 | 调研阶段产物；结论沉淀进 ADR / `doc/` 后可不再当日常真源 |
| `scripts/` | 结构校验、冒烟、开发工具；保持薄 | 长期 |
| `tests/` | 跨包冒烟与集成测试；`tests/fixtures/` 放样例数据 | 长期 |
| `deps/` | 钉死的第三方版本说明与（必要时的）拉取脚本 | 长期；二进制默认不入库 |

**没有 `apps/`、`services/`**：本项目不设独立应用入口；只有确实需要对外 MCP 工具面时才新增 `services/mcp/`，且仍由 bundle patch 静态挂载。

### 3.1 ADR（长期）

- 路径：`ai-docs/ADR/`，前期写入 `decisions.md`。
- 单条包含：背景、决策、后果/约束。
- **何时写**：只在对后续开发路线有重大影响时记录；实现细节、局部重构不记。
- **与旧记录冲突时只增不改**：追加新条目并写明取代关系；旧条目不重写。

### 3.2 Spec、Issue 与开发记录（短期，`.scratch/`）

- 路径：`.scratch/<feature-slug>/`，只服务当前开发，功能合入或阶段结束后清理。
- spec 为 `.scratch/<feature-slug>/spec.md`。
- 实现型 issue 一文件一票：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 编号；**不写**单个合并的 tickets 文件。
- triage 状态写在该 issue 文件靠上的 `Status:` 行，取值见 [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md)。
- 评论与对话历史追加到文件末尾的 `## Comments` 小节下。
- Agent 不应把过期 spec 当作现行规范；以 ADR、`doc/`、`GLOSSARY.md` 与代码为准。

### 3.3 `doc/`（架构导读）

- 介绍分层、安装路径、插件边界与关键数据流。
- 只记录架构和关键原理；具体实现以阅读代码为准。

### 3.4 调研文档（`ai-docs/invest/`）

- 建议包含：背景、核心诉求、方案对比、可行性、推荐结论、下一步。
- 已拍板结论同步写入 ADR；面向读者的架构叙述写入 `doc/`。

---

## 4. 技术栈

| 项 | 选型 | 说明 |
| :--- | :--- | :--- |
| 运行时 | Node.js `^22.19.0 \|\| >=24.0.0` | 与当前 dsh 列车一致；根 `package.json` `engines.node` |
| 包管理 | pnpm `12.5.1` | **只允许 pnpm**；`preinstall` 拒绝 npm/yarn |
| 语言 | Host：JavaScript / ESM；Client：TypeScript / TSX（后续） | host 入口直接以 ESM 运行 |
| Harness | `@deepseek-ai/dsh` `0.2.0-rc.2` | 当前机器上安装的 CLI 版本；见 `deps/VERSIONS.md` |
| 插件形态 | dsh bundle（`dsh.bundle`）+ 可选 `dsh.client` | 安装进现有 profile，不建产品 profile |
| 客户端构建 | esbuild | 产出 dsh Web 壳可加载的 `lib/client.js` |
| 测试 | `node --test --test-isolation=none` | 与实现同目录 `*.test.js`；Windows 沙箱内避免子进程隔离导致的 `spawn EPERM` |

---

## 5. 构建、安装与卸载

```bash
pnpm install          # 仅仓库根
pnpm build            # 用 esbuild 产出 packages/dsh-hk-craft/lib/client.js（不入库）
pnpm check            # 校验 manifest / patch / 入口 / 已构建的客户端 bundle 一致性
pnpm test             # 包内单元测试
```

`check` 会校验 `lib/client.js`（loader 调用、id 与 patch 行一致、平台模块声明齐全），所以**先 `build` 再 `check`**。

**安装 `desktop`（唯一支持的路径）**：

1. 打开 dsh → 侧边栏 **Plugins** → **Add plugin**。
2. 选择 **Install a third-party plugin**，填入绝对路径 `C:\Agent\Agent14-dsh-hk-craft\packages\dsh-hk-craft`。
3. 安装完成后重启 dsh。
4. 卸载：**Plugins → Installed plugins → dsh-hk-craft → 卸载**，再重启。

`desktop` profile 由 Electron 应用独占管理。CLI 的 `dsh plugin --profile desktop ...` 会返回 `profile "desktop" is managed exclusively by the Electron application`，不要把它写进脚本或文档。CLI 只可用于**非 desktop** 的试验 profile（如 `craft-smoke`），且应明确标注为可丢弃环境。

| 项 | 值 |
| :--- | :--- |
| 默认 profile | `desktop`（`$DSH_HOME/profiles/desktop`，Windows 默认 `%USERPROFILE%\.dsh\profiles\desktop`） |
| 安装入口 | dsh **Plugins** 面板（不是 CLI） |
| 产品专属 home | **无**；不要设置或提交 `DSH_HOME` 覆盖 |
| 产品专属端口 | **无**；沿用用户 dsh 的监听端口 |
| 生效时机 | 安装/更新后重启 dsh；当前 Web 进程不热加载新 bundle |
| 环境变量 | 目前无；后续如引入，统一用 `HK_CRAFT_*` 前缀并写入本节 |

---

## 6. dsh 插件约定

1. **装入现有 profile**：安装只把本包链接进 profile、写 `dsh.profile.bundles`，不创建新 profile；`desktop` 由插件管理器执行，不走 CLI。
2. **一个包两副面孔**：host 服务 / 工具 / 路由与浏览器 UI 同属 `packages/dsh-hk-craft`；客户端入口由 `dsh.client` 声明，构建为 `lib/client.js`。
3. **patch 层语义**：bundle 的 `cordis.patch.yml` 在 profile 自己的 patch 之前应用；后层按 `id` 覆盖时整段替换 `config`，必须重述全部键。不要插入同 id 的第二行。
4. **不改上游**：需要宿主能力时用 `ctx` 提供的公开服务与扩展点；不 fork `@deepseek-ai/dsh*`。
5. **版本列车单一**：`engines.dsh` 与 `@deepseek-ai/dsh*` peer 依赖保持同一列车；升级 dsh 时同步更新 `deps/VERSIONS.md` 并重跑冒烟。
6. **客户端构建格式**：由 esbuild 打成 CJS 工厂，交给 `window.__ModuleLoader__.load({ id, factory })`；`react`、`react/jsx-runtime`、`@deepseek-ai/cordis` 等平台模块走 external，其余内联。构建入口名必须与 patch 行 `name` 完全一致。
7. **可逆安装**：卸载后 profile 中不应残留本插件的 bundle 行或依赖；开发期不手工编辑用户的全局 `cordis.patch.yml`，除非文档明确说明。
8. **单一包管理器**：只在仓库根 `pnpm install`；子包不单独 `npm install`。
9. **大文件与密钥**：二进制、`.env`、密钥不入库；需要时用 `deps/` 脚本拉取并钉版本。

---

## 7. Agent 协作指引

1. **文档落点**：关键决定 → `ai-docs/ADR/`；当前开发 → `.scratch/`（并记得清理）；架构导读 → `doc/`；调研 → `ai-docs/invest/`；领域术语 → `GLOSSARY.md`。
2. **真源优先级**：长期行为以 **ADR + `doc/` + `GLOSSARY.md` + 代码** 为准；过期 spec 不作数。
3. **不做长期 spec 库**：不要把完整产品 spec 堆进仓库长期保存。
4. **能力未定不写死**：插件功能仍待用户描述；新增设计先在 `.scratch/<feature-slug>/spec.md` 收敛，再升 ADR 或 `doc/`。
5. **代码检索**：优先使用当前环境可用的语义检索工具（Semble / Graft）；不可用时退回 `grep`，并在回复中说明原因。不要一上来全局关键词扫仓。
6. **文档消费规则**：issue 跟踪器、triage 标签与域文档的读取方式见 `docs/agents/`，工程类 skill 以那三份文件为准。

---

## 8. 远程与协作

| 项 | 值 |
| :--- | :--- |
| 默认分支 | `master` |
| 探索分支 | `invest`（调研草稿，不作为现行真源） |
| 远程 | 待填写（`origin`） |

提交前建议先同步，避免多机冲突。

---

## 9. Agent skills

### Issue tracker

本仓库用本地 markdown 跟踪器：spec 与 issue 都在 `.scratch/<feature-slug>/` 下。见 [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)。

### Triage labels

五个规范 triage 角色，标签字符串与角色名相同。见 [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md)。

### Domain docs

single-context：根目录 `GLOSSARY.md` + `ai-docs/ADR/`。见 [`docs/agents/domain.md`](docs/agents/domain.md)。

---

## 10. 许可

MIT. Copyright (c) 2026 HHpetra.
