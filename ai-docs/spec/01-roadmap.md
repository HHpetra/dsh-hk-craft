# 01 — 里程碑与验收

**状态**：P0 已完成；P1 起等待插件能力描述。

| 阶段 | 目标 | 状态 | 验收 |
| :--- | :--- | :--- | :--- |
| P0 初始化 | 模板改造为“装入现有 dsh”的 bundle 骨架；ADR、scope、校验脚本就位 | **完成** | `pnpm check`、`pnpm test` 通过；`git` 首次提交 |
| P1 能力设计 | 回答 `00-scope.md` 的 TBD-1 ~ TBD-8 中与首切片相关的项 | 进行中 | scope 无阻塞性 TBD；首切片端到端路径写成 spec |
| P2 首个垂直切片 | 在 host 或 client 面实现一条最小可用路径 | 待定 | 安装到 `desktop`、重启 dsh 后可观察到行为；有单测 |
| P3 客户端界面 | 如首切片需要 UI：`dsh.client` + `lib/client.js` + 面板接入 | 待定 | 面板在 dsh Web UI 出现；卸载后干净移除 |
| P4 加固与分发 | 错误处理、测试、升级/卸载、分发方式 | 待定 | 安装→升级→卸载冒烟；文档与 ADR 更新 |

## 全局验收约束

- 安装/卸载只动 `desktop` profile 的 bundle 依赖与 `dsh.profile.bundles`，不改端口、home、`cordis.patch.yml`。
- 插件行装载失败必须显式报错，不静默降级。
- 不新增常驻端口；需要 HTTP 能力时优先复用 dsh 宿主提供的路由/服务。
- 客户端 bundle 不内联 React 等平台模块。

## 待定

- 各阶段日期与版本号：待 P1 收口后填。
- 是否需要 e2e / 快照测试：取决于插件是否产生模型可见输出或 UI 交互。
