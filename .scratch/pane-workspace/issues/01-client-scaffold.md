# 01: 客户端插件骨架可加载

**What to build:** 装进 `desktop` profile 并重启 dsh 后，Web 界面里能看到一个有插件身份的验证入口（例如页脚一个「窗格」按钮，点击弹出占位提示），证明 host 行、客户端 bundle、构建产物与 dsh Web 的加载链路全部打通。同时把客户端构建纳入仓库常规流程，让后续每张票都能直接往这个骨架里加 UI。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `pnpm check`、`pnpm build`、`pnpm test` 全绿；`check` 能校验客户端入口 id 与 patch 行 `name` 一致、`exports` 与 `files` 覆盖产物
- [ ] 安装到 `desktop` → 重启 dsh：客户端 bundle 被加载、无控制台报错、验证入口可见且可交互
- [ ] 客户端 bundle 把 react 等平台模块作为 external，不内联
- [ ] 卸载 → 重启：验证入口消失，profile 中无本插件的残留行或依赖
