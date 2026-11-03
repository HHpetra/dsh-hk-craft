# scripts

包装脚本与结构校验。保持**薄**：只做检查、冒烟或调用已有入口，不承载业务逻辑。

| 脚本 | 作用 |
| :--- | :--- |
| `check-bundle.mjs` | 校验 bundle manifest、`cordis.patch.yml`、host 入口、exports、`engines.dsh`，以及“无 apps/”架构约束 |
| `only-pnpm.mjs` | `preinstall` 守卫：拒绝 npm/yarn，且不依赖网络与 npx 缓存 |
| `sync-cursor-skills.ps1` | 刷新 `.cursor/skills/` 的 22 个 Matt Pocock skill 副本；默认本机优先，缺了才从 GitHub 拉 |

约定：Windows 与 Linux 行为保持一致；需要外部命令时在文档中写清前置条件。
