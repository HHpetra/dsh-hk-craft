# 跟随机器上已安装的 dsh 列车

目标运行时以 `desktop` profile 实际加载的 dsh 为准（Desktop 应用内置，当前 `0.2.2-rc.1`）并记录在 `deps/VERSIONS.md`；全局 `dsh` CLI 可能是另一列车，不能拿它的版本判断 `desktop`。`engines.dsh` 声明兼容范围，需要 `@deepseek-ai/dsh*` 类型或运行期包时 peer / dev 依赖使用同一列车。升级 dsh 时同步更新版本表、`engines.dsh` 与 peer 依赖，并重跑安装、启动、卸载冒烟。

**状态**：accepted
