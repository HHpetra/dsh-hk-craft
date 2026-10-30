# tests

跨包冒烟与集成测试；`fixtures/` 放样例数据。

- 单元测试优先与实现同目录 `*.test.js`（`node --test`）。
- 本目录放跨包 e2e / 安装冒烟脚本与样例。
- fixtures 不要放敏感数据或超大二进制。

## 待建

- 安装冒烟（desktop）：经 dsh **Plugins → Add plugin → 本地目录** 安装 → 校验 profile manifest 出现 bundle → 重启后行装载无错误 → 在 **Installed plugins** 卸载并确认回滚。
- 安装冒烟（CLI，仅限可丢弃 profile）：`dsh plugin --profile craft-smoke add ./packages/dsh-hk-craft` → `dsh --profile craft-smoke --dump-config` 含本层 → 删除该 profile。**不要**对 `desktop` 用 CLI。
- 客户端 UI 冒烟（若后续需要）：在 dsh Web UI 中确认面板出现，卸载后消失。
