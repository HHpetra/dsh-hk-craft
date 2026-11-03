# 唯一包管理器是 pnpm workspace

根目录是 private workspace（`packages/*`），只提交根 `pnpm-lock.yaml`，`packageManager` 钉死 pnpm，`preinstall` 拒绝 npm / yarn，且只在仓库根 `pnpm install`。混用锁文件会冲突，dsh 对扁平 `node_modules` 与链接 profile 的解析也敏感。克隆后第一步永远是根目录 `pnpm install`；本地安装到 profile 的是链接包。

**状态**：accepted
