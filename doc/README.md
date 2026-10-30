# 架构说明

面向用户与 Agent 的**架构与关键原理**介绍。只写架构和关键原理；具体实现以阅读代码为准。

## 1. 运行时

本项目没有自己的运行时。插件由**用户已安装的 dsh** 装载，默认 profile 为 `desktop`：

```text
用户现有 dsh (0.2.0-rc.2)
  └─ profile desktop
       ├─ bundle: @deepseek-ai/dsh-base
       ├─ bundle: @deepseek-ai/dsh-web-app
       ├─ bundle: dsh-mcp / 其他已装插件
       └─ bundle: dsh-hk-craft        ← 本项目
            └─ cordis.patch.yml → insert row id/name = dsh-hk-craft
                 └─ host: src/index.js
                 └─ client: lib/client.js（后续，经 dsh.client 声明）
```

dsh 的端口、`DSH_HOME`、会话存储与登录态都不归本项目管理。安装与卸载只改变 profile 的 bundle 依赖和 `dsh.profile.bundles`。

## 2. 配置层顺序

一个 profile 的有效配置按以下顺序合成，后层按 `id` 覆盖前层：

1. `dsh.profile.bundles` 中每个 bundle 的 patch，按列表顺序。
2. profile 自己的 `cordis.patch.yml`。
3. `$DSH_HOME/cordis.patch.yml`。
4. 启动时的 `--patch` overlay。

因此用户可以在自己的 profile patch 中按 `id: dsh-hk-craft` 覆盖本插件的配置，而无需修改本仓库。覆盖会**整段替换** `config`，必须重述全部键。

## 3. 插件边界

| 面 | 位置 | 职责 |
| :--- | :--- | :--- |
| host | `packages/dsh-hk-craft/src/index.js` | 宿主服务、工具、路由、会话粘合；经 Cordis `ctx` 使用 dsh 公开能力 |
| client | `packages/dsh-hk-craft/src/client/`（预留） | 浏览器面板 / 设置页；构建为 `lib/client.js`，经 `dsh.client` 声明 |
| config | `packages/dsh-hk-craft/cordis.patch.yml` | 只插入一条 `dsh-hk-craft` 行；不复制上游配置 |

host 与 client 同属一个包、同一版本，避免半套升级。客户端入口 id 必须与 patch 行 `name` 完全一致。

## 4. 为什么不设 `apps/`

模板默认的 launcher + 产品 profile + 桌面壳会引入第二个启动入口、独立 home 与端口，和“完全在 dsh 中使用”冲突。ADR-0001 已明确取代该形态。需要新的宿主进程能力时，应优先使用 dsh 的插件服务与工具接口，而不是新建应用入口。

## 5. 当前状态与待定

- 当前 host 行只做无副作用装载；没有业务服务、工具或 UI。
- 数据流、配置 schema、客户端面板位置均待插件能力确定后补充。
- 插件能力收口后，本节应增加“关键数据流”与“生命周期”两小节。

## 6. 验证

```powershell
pnpm check     # manifest / patch / 入口一致性
pnpm test      # 单元测试
# 安装：dsh → Plugins → Add plugin → 本地目录
#      C:\Agent\Agent14-dsh-hk-craft\packages\dsh-hk-craft
# 重启 dsh，确认行装载无错误
# 卸载：dsh → Plugins → Installed plugins → dsh-hk-craft
```
