# deps

钉死的第三方版本与（必要时的）拉取脚本。

- 版本真源见 [VERSIONS.md](VERSIONS.md)。
- 本项目**不 vendor** `@deepseek-ai/dsh`：插件装入用户已安装的 dsh，类型与运行期包按同一列车从安装处解析。
- 大二进制 / 计算引擎用脚本拉取，**默认不入库**。
- 不要在子目录 `npm install`；统一在仓库根 `pnpm install`。
