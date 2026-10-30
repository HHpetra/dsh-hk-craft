# Pinned third-party versions

| 依赖 | 版本 | 获取方式 | 说明 |
| :--- | :--- | :--- | :--- |
| `@deepseek-ai/dsh` | `0.2.0-rc.2` | 用户已安装的全局 CLI | 插件目标运行时；不 vendor 到本仓库 |
| Node.js | `^22.19.0 \|\| >=24.0.0` | 系统 / nvm | 见根 `engines`；本机验证版本 24.18.1 |
| pnpm | `12.5.1` | `packageManager` | 拒绝 npm/yarn |
| dsh profile | `desktop` | 用户 `$DSH_HOME/profiles/desktop` | 默认安装目标；不新建产品 profile |
| esbuild | `0.28.2` | 包 devDependency | 产出 `lib/client.js`；仅构建期使用，运行期零依赖 |

当前 `engines.dsh` 为 `>=0.2.0-rc.2 <0.3.0`。SemVer 不会自动接纳更高补丁位的预发布版（例如 `0.2.1-rc.1`）；dsh 升到新的预发布列车时，必须按下面的步骤显式更新范围。

## 升级 dsh 列车

1. 更新本表与根 `README.md` 的版本。
2. 同步 bundle 的 `engines.dsh` 与 `@deepseek-ai/dsh*` peer/dev 依赖（同一列车）。
3. 仓库根 `pnpm install`。
4. `pnpm check && pnpm test`。
5. 安装到 `desktop`，重启 dsh 冒烟，再卸载；记录结果到 `tests/` 或 spec。

不要混用不同列车的 `@deepseek-ai/dsh-*` 包：ESM 命名导出与运行期解析会失败。
