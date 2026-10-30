# dsh-hk-craft — 新项目启动

> 本仓库已按 dsh 插件模板完成**初始化**，并按需求改为“装入现有 dsh”的交付形态。
> 目标：**先设计、后编码**；每轮对话只推进一小步，结论及时落盘。

## 启动话术（可直接发给 Agent）

```text
这是一个 dsh 插件项目。插件完全在现有 dsh 内使用，不另做启动器或独立界面。
请继续和我一起把这个插件的设计逐步收口。每次只完成一小部分，不要一次生成大量内容。
把已经确定的内容及时写入仓库文件；未定的用 TBD 标在 .scratch/ 下。
```

## 当前已确定的约束

1. 插件是 dsh bundle，装入现有 profile（默认 `desktop`），不建产品 home / profile / 端口。
2. 不提供启动器、Electron/Tauri 外壳或第二套聊天 UI。
3. 一个包承载 host 与（后续的）client 两面；客户端经 `dsh.client` 接入 dsh Web 壳。
4. 不 fork `@deepseek-ai/dsh*`。

## 分轮设计流程

| 轮次 | 目标 | 落盘位置 |
| :--- | :--- | :--- |
| 1 | **插件能力**：解决什么问题、目标用户、成功标准 | `.scratch/inception/spec.md` / `README.md` |
| 2 | 用户场景与边界（做什么 / 不做什么） | `.scratch/inception/spec.md` |
| 3 | host / client 分工与首个垂直切片 | `.scratch/<feature-slug>/spec.md` + `doc/` |
| 4 | 数据真源、存储与通道约定 | `ai-docs/ADR/decisions.md` + spec |
| 5 | 安装、升级、卸载与验收 | `.scratch/inception/roadmap.md` |
| 6 | 里程碑与测试策略 | `.scratch/inception/roadmap.md` |

原则：

- **已确定的内容立刻写入文件**，不要只留在对话里。
- **未定的不写死**；用「待定 / TBD」占位并列在 `.scratch/` 的 spec 里。
- 与既有决策冲突时走 ADR **只增不改**（新条目声明取代关系）。

## 设计阶段结束后

1. 清理 `.scratch/` 中已过期的草稿，结论升入 ADR、`doc/` 或 `GLOSSARY.md`。
2. 确认 `AGENTS.md` 与真实技术栈、安装方式一致。
3. 首次提交已包含文档骨架；后续按阶段提交。
4. 从 `AGENTS.md` 的「构建、安装与卸载」开始编码。
