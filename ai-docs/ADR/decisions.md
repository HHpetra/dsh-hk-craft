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

## ADR-0005 — 首个能力：多会话分屏 + 侧栏精简（窗格 ⇄ 会话 1:1）

**背景**：重度用户同时开多个项目、多个对话。dsh 把「工作区 + 其下全部对话」平铺在一个侧栏里，对话一多整列就不可用；同时 dsh 一个窗口只有一个主对话视图，需要并排对照时只能来回切换。需求于是收敛为三件事：侧栏只留工作区名与状态灯、用 `/resume` 与 `/clear` 替代侧栏对话列表、主区域支持 VS Code 式任意分割。

**决策**：

1. **接管主区域，而不是覆盖它**：注册 `main` 键控槽（key `hkcraft.panes`）并调 `ctx.layout.selectPanel(...)`。`main` 的渲染键是 `activePanelId ?? "conversation"`，切过去时原生对话面板会**卸载**，因此不会出现双挂 composer 或双份流式输出。
2. **每个窗格 = 一个会话**，窗格是会话的显示槽而不是可空容器；关窗格即「取消当前回合并释放客户端引用」，会话数据保留、可经 `/resume` 重新拉回。切换工作区只换可见的窗格树，**不关闭**任何会话。
3. **布局是手动分割树**，每个工作区一棵，树上只装本工作区的会话（不做跨工作区同屏）；树形、比例、焦点、每格视图按工作区落盘。
4. **标签条是窗格的索引**，不是第二层容器；`对话 / 轨迹` 是窗格内的分段开关，按窗格记忆。这样"哪个会话"和"哪种视图"两个维度不会互相冒充。
5. **侧栏工作区区块整块替换**：以更低 `priority` 覆盖 `sidebar.workspaces` 这个 `single` 槽，只保留「名称 + 三态灯 + 添加工作区」，其余侧栏部件不动。
6. **命令是纯客户端的**：`/clear`、`/resume` 经 `commandUi` 注册，走壳提供的 `popupSelect` 选择器，不发给模型。
7. **渲染指定会话的对话**：窗格声明一个 `scope: "session"` 子槽拿到壳给的 `SessionProvider`，再以 `renderFactorySlot("conversation.content")` 挂载完整对话；焦点窗格独占 `mainView` 引用以维持 dsh 对"当前会话"的单值推导。

**后果 / 约束**：

- 分屏依赖 `conversation.content` 这个**字符串 Factory 名**与单值 `mainView` 推导。上游若改名或改动推导，只需修适配层（`dsh-pane-host.js`），但要锁 `engines.dsh` 并在升级时重跑冒烟。
- 跨工作区不能同屏；跨项目找历史要先切工作区。这是用"布局简单"换"信息可见性"的自觉选择。
- 刷新或重启后恢复树形、比例、焦点与视图，但**不恢复滚动位置与未发送草稿**；由外层界面触发的原生会话揭示会卸载分屏面板。
- 侧栏区块内搜索随精简一并移除（`Mod+K`、`Mod+O` 因此变为空操作）；若"找不到旧对话"成为高频抱怨，再以全局搜索面板补回。
- `lib/client.js` 由 esbuild 生成、不入库；构建脚本在受限沙箱里会回退到 esbuild CLI，两条路径产出必须一致。
