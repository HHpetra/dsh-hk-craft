# Pinned third-party versions

| 依赖 | 版本 | 获取方式 | 说明 |
| :--- | :--- | :--- | :--- |
| `@deepseek-ai/dsh`（Desktop 运行时） | `0.2.2-rc.1` | Desktop 应用内置（`resources/app.asar`） | **插件目标运行时**：`desktop` profile 实际加载的列车 |
| 全局 `dsh` CLI | `0.2.0-rc.2`（本机） | `%APPDATA%\npm`（npm 全局安装） | 只用于非 `desktop` 试验 profile；与上一行**不是同一列车**，不要混用 |
| Node.js | `^22.19.0 \|\| >=24.0.0` | 系统 / nvm | 见根 `engines`；仓库开发范围不改。Desktop 内置 Node `24.21.0`。dsh 主包 `engines.node` 为 `>=24.9.0` |
| pnpm | `12.5.1` | `packageManager` | 拒绝 npm/yarn |
| dsh profile | `desktop` | 用户 `$DSH_HOME/profiles/desktop` | 默认安装目标；不新建产品 profile |
| esbuild | `0.28.2` | 包 devDependency | 产出 `lib/client.js`；仅构建期使用，运行期零依赖 |

`desktop` 的 dsh 版本只能看 Desktop 应用自带的运行时：读
`<安装目录>/resources/app.asar` 中 `dsh/node_modules/@deepseek-ai/dsh/package.json`
的 `version`（或启动后看 dsh 的“关于/诊断”）。**`dsh --version` 回答的是全局 CLI
的版本，不是 `desktop` 的版本**；本机两者相差一个列车（CLI `0.2.0-rc.2`、
Desktop `0.2.2-rc.1`），所以不能拿 CLI 的版本判断 `desktop` profile 跑的是什么。

当前 `engines.dsh` 为 `>=0.2.2-rc.1 <0.3.0`，跟随 Desktop 运行时。dsh 安装器用 `semver.satisfies(..., { includePrerelease: true })`，所以旧范围 `>=0.2.1-rc.5 <0.3.0` 实际上也能接受 `0.2.2-rc.1`；标准 SemVer（不带 `includePrerelease`）不会。显式升到这一列车是为了准确表达“只验证过 Desktop 当前运行时”，不是为了通过安装器。dsh 升到更新的预发布列车时，仍按下面的步骤更新范围。若要用 CLI 跑 `craft-smoke` 等试验 profile，先把全局 CLI 升到同一列车（例如 `npm i -g @deepseek-ai/dsh@0.2.2-rc.1`），并且 Node 满足 dsh 主包的 `engines.node >=24.9.0`（Desktop 内置的是 24.21.0），否则它不满足 `engines.dsh`。

## 升级 dsh 列车

1. 更新本表与根 `README.md` 的版本。
2. 同步 bundle 的 `engines.dsh` 与 `@deepseek-ai/dsh*` peer/dev 依赖（同一列车）。
3. 仓库根 `pnpm install`。
4. `pnpm check && pnpm test`。
5. 安装到 `desktop`，重启 dsh 冒烟，再卸载；记录结果到 `tests/` 或 spec。

不要混用不同列车的 `@deepseek-ai/dsh-*` 包：ESM 命名导出与运行期解析会失败。
