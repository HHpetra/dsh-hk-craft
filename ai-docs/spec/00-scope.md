# 00 — 范围与边界

**状态**：骨架已初始化；**插件能力待用户描述**。
**最后更新**：2026-10-30。

## 1. 已确认

以下约束来自需求原话与初始化时的确认，不再作为待决项：

1. 本项目是**为 dsh 开发的原生插件**，不是 HK 产品线（HK-PrePost / HK-GIS 等）的插件或附属应用。
2. 插件**完全在 dsh 内使用**：装入用户已有的 dsh profile，在现有 Web UI / 会话中生效。
3. **不封装成另外一个启动界面**：不做 launcher、Electron/Tauri 外壳、独立窗口或第二套聊天 UI。
4. **不建产品专属运行时**：不设独立 `DSH_HOME`、独立 profile、独立端口。
5. 默认安装目标是当前 `desktop` profile；沿用其 home、端口、登录态与会话数据。
6. 交付物是一个可安装、可卸载的 dsh bundle：`packages/dsh-hk-craft`。

## 2. 待确认（不得写死）

| 编号 | 待决项 | 需要的答案 |
| :--- | :--- | :--- |
| TBD-1 | **插件能力**：它替用户解决什么问题 | 一句话能力陈述 + 一个具体使用场景 |
| TBD-2 | 目标用户与使用频率 | 谁在什么工作流中用它 |
| TBD-3 | 首个垂直切片 | 最小可验收的一条端到端路径 |
| TBD-4 | host / client 分工 | 哪些能力在宿主、哪些在浏览器 |
| TBD-5 | 数据真源与存储 | 配置/状态存哪里、谁可写、是否跨会话 |
| TBD-6 | 外部依赖 | 是否需要终端、文件系统、网络、外部进程；是否需要 MCP |
| TBD-7 | 分发方式 | 本地链接、Git 安装、npm tarball 或 registry |
| TBD-8 | 是否复用 HK-Craft 的既有设计 | 仅借鉴交互，还是迁移代码/数据格式 |

在 TBD-1 回答前，不在代码中加入业务逻辑、模型工具、路由或客户端面板。

## 3. 当前非目标

- 不做独立应用入口、安装包或桌面壳。
- 不 fork、不 vendor `@deepseek-ai/dsh*`。
- 不复制 dsh 的聊天/会话界面；只通过 `dsh.client` 增加插件面板。
- 不接管用户的 `DSH_HOME`、profile 端口或全局 `cordis.patch.yml`。
- 不把 HK-PrePost / HK-GIS 的 CAE/GIS 领域能力带入本插件，除非后续明确要求。

## 4. 初始化验收

本轮“初始化”完成的判定：

- [x] 目录与文档骨架建立，模板中的 launcher / 产品 profile 形态被 ADR-0001 取代。
- [x] `packages/dsh-hk-craft` 具备 `dsh.bundle`、patch、host 入口与单测。
- [x] `pnpm check` 校验 manifest、patch、入口一致。
- [x] `pnpm test` 通过。
- [x] `git init` + 首次提交。
- [ ] 实机安装 → 重启 dsh → 卸载的冒烟（待首次联调时执行并记录）。

## 5. 下一步

1. 用户描述插件能力（TBD-1），写入本文件。
2. 补齐 TBD-2 ~ TBD-8 中与首个切片相关的项。
3. 在 `ai-docs/spec/` 新开任务切片，明确 host / client 改动面。
4. 能力边界稳定后，在 `ai-docs/ADR/decisions.md` 追加 ADR-0005。
