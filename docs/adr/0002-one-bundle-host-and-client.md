# 一个 bundle 包承载 host 与 client 两面

`packages/dsh-hk-craft` 同时承载 host 入口与 client UI：`dsh.bundle.patch` 指向唯一 patch，host 由包的 `main` 提供，浏览器侧经 `dsh.client` 构建 `lib/client.js` 并从 `exports` 暴露 `./client`。拆成多个包会让安装、版本与 patch 行变复杂，也容易出现半套升级。客户端入口 id 必须与 patch 行 `name` 完全一致，React 等平台模块走 external、不得打进 bundle。

**状态**：accepted
