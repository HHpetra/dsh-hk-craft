# Triage 标签

各 skill 以五个规范化的 triage 角色来表述。本文件把这些角色映射到本仓库实际使用的标签字符串。

| 规范角色（skills 中的叫法） | 本仓库的标签字符串 | 含义 |
| :--- | :--- | :--- |
| `needs-triage` | `needs-triage` | 需要维护者评估这个 issue |
| `needs-info` | `needs-info` | 等待报告者补充信息 |
| `ready-for-agent` | `ready-for-agent` | 已完全写清，可交给 AFK agent |
| `ready-for-human` | `ready-for-human` | 必须由人来实现 |
| `wontfix` | `wontfix` | 不处理 |

当某个 skill 提到某个角色（例如“打上 AFK-ready 的 triage 标签”）时，使用上表对应的标签字符串。

本地 markdown 跟踪器没有真正的标签对象，因此把字符串写进 issue 文件的 `Status:` 行即可。若改用 GitHub / GitLab，需要在那里按上表创建同名标签，并修改右列以对齐既有词表。
