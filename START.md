# dsh-hk-craft — 新项目启动

> 流程沿用 Matt Pocock 的 engineering skills：**先把产品语言和决策对齐，再写代码**；每个阶段只推进一小步，结论立刻落盘。

## 启动话术（可直接发给 Agent）

```text
这是一个 dsh 插件项目。插件完全在现有 dsh 内使用，不另做启动器或独立界面。
请继续和我一起把设计逐步收口。每次只完成一小部分，不要一次生成大量内容。
把已经确定的内容及时写入仓库文件；未定的用 TBD 标在 spec/ 下。
```

## 已确定的约束

1. 插件是 dsh bundle，装入现有 profile（默认 `desktop`），不建产品 home / profile / 端口。
2. 不提供启动器、Electron/Tauri 外壳或第二套聊天 UI。
3. 一个包承载 host 与 client 两面；客户端经 `dsh.client` 接入 dsh Web 壳。
4. 不 fork `@deepseek-ai/dsh*`。

## 主流程（idea → ship）

| 阶段 | 做什么 | 对应 skill（没有就手动做） | 落盘 |
| :--- | :--- | :--- | :--- |
| 1. 访谈 | 定位、边界、能力切分与取舍 | `grilling` + `domain-modeling` | `GLOSSARY.md`、`docs/adr/` |
| 2. 要可运行答案 | 启动链路 / 插件加载说不清时，先做一次性原型 | `prototype` | `.scratch/` 下的临时脚本 |
| 3. 收成 spec 并拆票 | 多会话的活先写 spec，再拆成带阻塞边的小票 | `to-spec` → `to-tickets` | `spec/`、GitHub Issues |
| 4. 实现 | 一票一实现，先红后绿 | `implement`、`tdd` | `packages/dsh-hk-craft/` |
| 5. 复查 | 标准 + spec 两轴 | `code-review` | 提交前 |
| 6. 提 PR | 最小可视化 + 前后证据 + 是否单向门 | `pr` | PR 正文 |
| 7. 复盘 | 改环境，不改代码 | `retro` | `AGENTS.md`、检查脚本 |

## 上下文卫生

- 阶段 1–3 保持在**同一个上下文窗口**，中途不要 compact / clear：访谈、spec、票据要建立在同一份思考上。
- 每个 `implement` 另起新会话，只带那一张票进入。
- `retro` 在它要复盘的那个会话里跑。

## 分轮设计（阶段 1 的具体做法）

| 轮次 | 目标 | 落盘位置 |
| :--- | :--- | :--- |
| 1 | 插件能力：解决什么问题、目标用户、成功标准 | `README.md`、`GLOSSARY.md` |
| 2 | 用户场景与边界（做什么 / 不做什么） | `spec/00-scope.md` |
| 3 | host / client 分工、首个垂直切片与取舍 | `docs/adr/`（一决策一文件） |
| 4 | 目录结构与模块划分 | `AGENTS.md` 第 3–4 节 + `docs/README.md` |
| 5 | 数据真源、上游契约与通道约定 | `docs/upstream-contracts.md`、`spec/` |
| 6 | 里程碑、验收与测试策略 | `spec/01-roadmap.md` |

原则：

- **已确定的内容立刻写入文件**，不要只留在对话里。
- **未定的不写死**；用「待定 / TBD」占位并列在 `spec/`。
- 与既有决策冲突时新增一条 ADR，旧文件只改状态行（`superseded by ADR-NNNN`），不改写正文。

## 设计阶段结束后

1. 清理 `spec/` 中已过期的草稿，结论升入 `docs/adr/` 或 `docs/`。
2. 核对 `docs/agents/issue-tracker.md`：本仓已切到 GitHub Issues，用 `gh` 管理票据。
3. 确认 `AGENTS.md` 与真实技术栈、安装方式一致。
4. `git init` 并首次提交（含文档骨架）。
5. 从 `AGENTS.md` 的「构建、安装与卸载」开始编码。
