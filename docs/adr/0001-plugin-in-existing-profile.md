# 插件装入现有 dsh profile，不建独立启动入口

交付物是一个 dsh bundle，通过 dsh 的 **Plugins → Add plugin → 本地目录** 装入用户已有的 `desktop` profile；安装与卸载必须走应用内插件面板，因为 `desktop` 由 Electron 独占管理，CLI 的 `dsh plugin --profile desktop ...` 被上游拒绝。本项目是 dsh 自身的插件，完全在 dsh 内使用，模板默认的 launcher + 独立 home / profile / 端口会造出第二个启动入口。后果是仓库没有 `apps/` 与 `packages/dsh-profile/`，端口、`DSH_HOME`、会话数据与登录态都归用户现有 dsh。

**状态**：accepted
