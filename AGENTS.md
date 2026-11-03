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
- **愿景**：让重度 dsh 用户在一个窗口里并排处理多个会话，同时保留原生侧栏与右侧栏。
- **当前阶段**：**开发阶段**。已交付首个能力（多会话分屏 + 侧栏精简），后续按 feature 迭代。

---

## 2. 当前阶段的核心目标

1. 在“**装入现有 dsh**”这一交付形态下继续加能力：安装只增加 profile 的 bundle 依赖与插件行。
2. 保持可重复的验证链：`pnpm check` → `pnpm test` → 本地安装 → 重启 dsh → 卸载，且不残留 profile 改动。
3. 新能力先收敛到 `ai-docs/spec/` 与票据，再升 ADR 或 `docs/`。

---

## 3. 目录与文档规范

| 目录路径 | 用途说明 | 保留策略 |
| :--- | :--- | :--- |
| `GLOSSARY.md` | **领域语言**：本项目特有概念的唯一定义 | **长期保留**；只放词义，不放实现细节与决策 |
| `docs/` | 面向用户与 Agent 的**架构与关键原理**介绍 | **长期保留**；只写架构与原理，不写实现细节与过程性 spec |
| `docs/adr/` | **架构决策记录（ADR）**：一决策一文件 | **长期保留**；只记关键决定 |
| `docs/agents/` | Agent 消费的配置：领域文档规则 / issue tracker / 分诊标签 | **长期保留** |
| `ai-docs/spec/` | 当前开发用的 **spec 与开发记录** | **短期**；需**经常清理**，不做长期归档 |
| `ai-docs/invest/` | 可行性研究与技术调研文档 | 调研阶段产物；结论沉淀进 ADR / `docs/` 后可不再当日常真源 |
| `.scratch/` | 本地 issue 跟踪器（`<feature>/issues/NNN-slug.md`） | **短期**；完成即清理；**要入库** |
| `packages/dsh-hk-craft/` | **唯一可安装 bundle**：manifest、patch、host 入口、client UI 与构建脚本 | 长期 |
| `scripts/` | 结构校验、冒烟、开发工具；保持薄 | 长期 |
| `tests/` | 跨包冒烟与集成测试；`tests/fixtures/` 放样例数据 | 长期 |
| `deps/` | 钉死的第三方版本说明与（必要时的）拉取脚本 | 长期；二进制默认不入库 |

**没有 `apps/`、`services/`**：本项目不设独立应用入口；只有确实需要对外 MCP 工具面时才新增 `services/mcp/`，且仍由 bundle patch 静态挂载。

### 3.1 ADR（长期）

- 路径：`docs/adr/`；**一决策一文件**：`0001-slug.md`、`0002-slug.md`。
- 编号扫现存最大值 +1；允许缺号，**不重新编号**。
- **三条门槛同时满足才写**：难以回退 / 没有上下文会让后人困惑 / 真有过取舍。缺一条就跳过。
- 正文 = 标题 + 1–3 句（背景、决定、为什么）；`后果`、`被否决的方案` 只在真有价值时展开。
- 取代：新增一条并写 `**状态**：superseded by ADR-NNNN`；旧文件正文不改，也不另建 `deprecated.md`。
- **不记录**：实现细节、局部重构、显然只有一个选项的事。

### 3.2 Spec 与开发记录（短期，`ai-docs/spec/`）

- 路径：`ai-docs/spec/`，只服务当前开发；功能合入或阶段结束后清理或压缩。
- 建议命名：`00-scope.md`（边界与范围）、`01-roadmap.md`（里程碑与验收）、`0N-<topic>.md`（任务切片 / 接口草案 / 联调笔记）。
- issue 不放这里：实现型票据在 `.scratch/<feature-slug>/issues/NNN-<slug>.md`，规则见 [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)。
- Agent 不应把过期 spec 当作现行规范；以 `GLOSSARY.md`、ADR、`docs/` 与代码为准。

### 3.3 `docs/`（架构导读）

- 介绍分层、安装路径、插件边界与关键数据流；上游契约集中在 [`docs/upstream-contracts.md`](docs/upstream-contracts.md)。
- 只记录架构和关键原理；具体实现以阅读代码为准。

### 3.4 调研文档（`ai-docs/invest/`）

- 建议包含：背景、核心诉求、方案对比、可行性、推荐结论、下一步。
- 已拍板结论同步写入 `docs/adr/`；面向读者的架构叙述写入 `docs/`。

---

## 4. 技术栈

| 项 | 选型 | 说明 |
| :--- | :--- | :--- |
| 运行时 | Node.js `^22.19.0 \|\| >=24.0.0` | 与当前 dsh 列车一致；根 `package.json` `engines.node` |
| 包管理 | pnpm `12.5.1` | **只允许 pnpm**；`preinstall` 拒绝 npm/yarn |
| 语言 | Host：JavaScript / ESM；Client：TypeScript / TSX（后续） | host 入口直接以 ESM 运行 |
| Harness | `@deepseek-ai/dsh` `0.2.1-rc.5` | `desktop` 实际加载的 Desktop 内置运行时；全局 CLI 可能是另一列车（本机 `0.2.0-rc.2`），见 `deps/VERSIONS.md` |
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

1. **文档落点**：关键决定 → `docs/adr/`；当前开发 → `ai-docs/spec/`（并记得清理）；issue → `.scratch/`；架构导读 → `docs/`；调研 → `ai-docs/invest/`；领域术语 → `GLOSSARY.md`。
2. **真源优先级**：长期行为以 **`GLOSSARY.md` + ADR + `docs/` + 代码** 为准；过期 spec 不作数。
3. **不做长期 spec 库**：不要把完整产品 spec 堆进仓库长期保存。
4. **动手前先读**：进入某区域前先读 `GLOSSARY.md` 与相关 ADR；与既有 ADR 冲突时显式标注（“与 ADR-NNNN 冲突，但值得重开，因为…”），不静默覆盖。
5. **代码检索**：优先使用当前环境可用的语义检索工具（Semble / Graft，见第 8 节）；不可用时退回 `grep`，并在回复中说明原因。
6. **文档消费规则**：issue 跟踪器、triage 标签与域文档的读取方式见 `docs/agents/`，工程类 skill 以那三份文件为准。

---

## 8. 代码检索（Semble + Graft）

隐喻：**一根定位针，一张地图**。

| 工具 | 职责 |
| :--- | :--- |
| **Semble** | 第一次落地：按行为或符号名搜到正确文件与行号 |
| **Graft** | 地图与连带关系：上下文图、`ask` / `callers` / `skeleton` / `map` |

推荐顺序：

1. 「代码在哪」→ Semble（`search` / `find_related`）。
2. 「怎么连、影响面」→ Graft（可先 `graft map`）。
3. 工具覆盖不到时才退回 grep，并说明原因。

**禁止默认路径**：一上来就全局关键词扫仓。

<!-- graft:start -->
新仓库首次使用请安装 Graft 并执行 `graft build` 生成图（缓存不入库）。
之后任意任务优先 `graft ask "<question>" --source`；大改后 `graft build` 刷新。
<!-- graft:end -->

---

## 9. 远程与协作

| 项 | 值 |
| :--- | :--- |
| 默认分支 | `master` |
| 探索分支 | `invest`（调研草稿，不作为现行真源） |
| 远程 | 待填写（`origin`） |

提交前建议先同步，避免多机冲突。

---

## 10. Agent skills（Matt Pocock 流程）

### Issue tracker

本地 markdown：`.scratch/<feature>/issues/`，一票一文件、三位编号，按 `Blocked by` 拓扑顺序取票；`.scratch/` 要入库。见 [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)。

### Triage labels

`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`，只用于外部进来的 issue。见 [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md)。

### Domain docs

单上下文：根 `GLOSSARY.md` + `docs/adr/`；动手前先读，冲突显式标注。见 [`docs/agents/domain.md`](docs/agents/domain.md)。

---

## 11. 许可

MIT. Copyright (c) 2026 HHpetra.
