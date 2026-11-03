# Triage Labels

各 skill 以五个规范化的 triage 角色表述。本文件把这些角色映射到本仓库实际使用的标签字符串。

| mattpocock/skills 中的标签 | 本仓库跟踪器中的标签 | 含义 |
| :--- | :--- | :--- | :--- |
| `needs-triage` | `needs-triage` | 需要维护者评估这个 issue |
| `needs-info` | `needs-info` | 等待报告者补充信息 |
| `ready-for-agent` | `ready-for-agent` | 已完全写清，可交给 AFK agent |
| `ready-for-human` | `ready-for-human` | 必须由人来决定或实现 |
| `wontfix` | `wontfix` | 不处理 |

当某个 skill 提到某个角色（例如“打上 AFK-ready 的 triage 标签”）时，使用上表对应的标签字符串。

只用于**外部进来**的 issue；`to-tickets` 拆出来的票本身已 agent-ready，不要再过一遍分诊。跟踪器是 GitHub Issues，标签是真实对象（`gh label list` 可查）。
