# Architecture Decision Records

长期只记录**关键决定**。条目变多后按主题拆分；本文件为前期合并档。

规范见仓库根目录 [AGENTS.md](../../AGENTS.md) 第 3.1 节。索引见 [README.md](README.md)。

---

## ADR-0001 — 插件装入现有 dsh profile，不建独立启动入口

**背景**：dsh 插件模板默认走“产品专属 `DSH_HOME` + 独立 profile + launcher/桌面壳”的形态（模板 ADR-0001、ADR-0003）。本项目需求明确相反：它是 dsh 自身的插件，完全在 dsh 内使用，不封装成另一个启动界面。

**决策**：

- 交付物是一个 **dsh bundle**，通过 dsh 的 **Plugins → Add plugin → 本地目录** 装入用户已有的 `desktop` profile。
- `desktop` profile 由 Electron 应用独占管理，CLI 的 `dsh plugin --profile desktop ...` 被上游明确拒绝；安装/卸载必须走应用内插件面板。
- 不创建 `apps/launcher`、Electron/Tauri 外壳，不建产品专属 `DSH_HOME`、独立 profile 或独立端口。
- 安装只增加 profile 的依赖与 `dsh.profile.bundles` 条目；卸载可逆。
- 插件装载发生在用户下次启动 dsh 时，沿用其现有 Web UI。

**后果**：

- 仓库没有 `apps/` 与 `packages/dsh-profile/`；模板中这两部分被本决策取代。
- 端口、home、会话数据、登录态都归用户现有 dsh 管理，本项目不碰。
- 验证链改为“安装到 `desktop` → 重启 dsh → 卸载”，而不是启动本项目自己的进程。

---

## ADR-0002 — 一个 bundle 包承载 host 与 client 两面

**背景**：dsh 的插件行既可提供宿主服务，也可通过 `dsh.client` 声明浏览器侧入口。拆成多个包会让安装、版本与 patch 行变复杂。

**决策**：

- `packages/dsh-hk-craft` 同时承载 host 入口与后续的 client UI。
- `dsh.bundle.patch` 指向唯一 patch；host 面由该包的 `main` 提供。
- 需要浏览器 UI 时，在同一个 `package.json` 增加 `dsh.client`，构建 `lib/client.js`，并在 `exports` 暴露 `./client`。
- 客户端 bundle 采用 dsh Web 壳的 `window.__ModuleLoader__.load({ id, factory })` 格式；入口 id 与 patch 行 `name` 完全一致。

**后果**：

- 安装/卸载只有一个包、一条 bundle 记录。
- host 与 client 的版本永远同步，不会出现半套升级。
- client 构建必须遵守 dsh 的平台模块 external 约定，不能把 React 等平台模块打进 bundle。

---

## ADR-0003 — 跟随机器上已安装的 dsh 列车

**背景**：dsh 的插件 API 与包边界仍在快速演进；混用不同列车会破坏 ESM 命名导出与运行期解析。

**决策**：

- 当前目标运行时为 `@deepseek-ai/dsh@0.2.0-rc.2`（本机已安装 CLI），记录在 `deps/VERSIONS.md`。
- bundle 用 `engines.dsh` 声明兼容范围；需要 `@deepseek-ai/dsh*` 类型或运行期包时，peer 依赖与 devDependency 使用同一列车版本。
- 升级 dsh 时同步更新版本表、`engines.dsh`、peer 依赖，并重跑安装/启动/卸载冒烟。

**后果**：

- 不 vendor `@deepseek-ai/dsh`，也不在仓库内固定一份独立运行时。
- 插件不能假设比目标版本更新的 API；遇到缺失能力时先记录 ADR 或调研，不 fork 上游。

---

## ADR-0004 — 唯一包管理器是 pnpm workspace

**背景**：混用 npm / pnpm 锁文件会冲突；dsh 对扁平 `node_modules` 与链接 profile 的解析敏感。

**决策**：

- 根目录 private workspace：`packages/*`。
- 只提交根目录 `pnpm-lock.yaml`；`packageManager` 钉死 pnpm；`preinstall` 拒绝 npm/yarn。
- 只在仓库根 `pnpm install`；子包不单独安装。

**后果**：

- 克隆后第一步永远是根目录 `pnpm install`。
- 本地安装到 profile 的是链接包，保留本仓库自己的 `node_modules`。

---

<!-- 插件能力边界待用户描述后，从 ADR-0005 起继续追加；与旧决策冲突时只增不改。 -->
