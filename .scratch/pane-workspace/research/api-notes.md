# 实现须知（给 implementer）

**唯一真源**：`.scratch/pane-workspace/spec.md`（决策）+ 各票 `.scratch/pane-workspace/issues/NN-*.md`（范围）。本文件只补"怎么在这个仓库里干活"。

## 1. 硬约束（会直接让方案失败，先读）

| 约束 | 后果 |
| :--- | :--- |
| `lib/client.js` 由 **esbuild** 生成 | 跑 `node packages\dsh-hk-craft\scripts\build-client.mjs`；不要手改产物（已 gitignore） |
| 平台模块必须声明在 `dsh.client.inject` | 构建期会校验裸 `require`；未声明的直接失败 |
| **Node 里没有 react** | 纯逻辑模块禁止 `require('react')`；组件写 JSX，但**不要给组件写需要渲染的单测** |
| 网络与子进程可用 | 但仍**不要新增依赖**；除 esbuild 外本项目零运行时依赖 |

## 2. 命令

```powershell
pnpm build            # 构建 lib/client.js；沙箱挡住 esbuild 服务时会自动回退到 CLI
pnpm test
pnpm check            # 需要先 build
```

`lib/client.js` **不入库**。如果 `build` 报 `spawn EPERM`，那是沙箱限制，脚本已自动回退——不要手工拼 esbuild 命令。

## 3. 客户端模块约定

- `src/client/**` 里的文件由 esbuild 打包（`format: cjs`），可以写 **JSX**（`.js` 已配置 jsx loader）；
  也可以继续用 `React.createElement`（票 02–04 的既有代码就是这样，不必返工）。
- `import React from 'react'` / `require('react')` 都只在构建后被壳解析；**单测不要导入组件模块**
  （Node 里没有 react）。纯逻辑放在不依赖 react 的模块里。
- 新出现的平台模块要同步进 `packages/dsh-hk-craft/package.json` 的 `dsh.client.inject`。
- 不要把 dsh 的 API 假设散落在组件里：**每个能力集中到一个适配层模块**（例如 `dsh-sessions.js`、
  `dsh-slots.js`），组件只吃纯数据。假设错了只改一处。

## 4. 测试约定

- 与实现同目录 `*.test.js`；`node:test` + `node:assert/strict`。
- 纯逻辑（布局树、排序过滤、状态推导、持久化编解码）**必须**有单测。
- React 组件不渲染、不测渲染结果；可测它调用的纯函数与适配层。
- 用假 ctx 验证注册行为（参考 `src/client/index.test.js` 的 `fakeCtx`）。
- 无法在这里验证的（真实 UI、安装后效果）写进票的 `## Comments` 的"待人工验证"。

## 5. dsh 内部代码在哪

已解包的 dsh 源码（只读参考，**不要提交、不要改**）：

- `.scratch/_tmp/client/<包名>/lib/client.js`：客户端包（React 组件、槽注册）
- `.scratch/_tmp/host/<包名>/lib/index.js`：宿主包（服务、RPC、会话）
- 需要新包时：`node .scratch\_tools\asar.mjs extract "dsh/node_modules/@deepseek-ai/<包名>/" .scratch\_tmp\client\<包名>`

## 6. 已核实的关键 API（不要重新猜）

**槽注册**（list 槽的入口）：

```js
ctx.slots.inject('sidebar.footer.action', () =>
  ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-hk-craft.x', locale: NS }, Component))
```

**single 槽的替换**：以更低 `priority` 注册同一 `name` 即可覆盖（"lowest renders"）。侧栏工作区区块就是 `single` 槽 `sidebar.workspaces`。

**主区域**：`main` 是键控根槽，渲染键 = `activePanelId ?? "conversation"`。插件注册自己的 key 后调
`ctx.layout.selectPanel('<key>')` 即接管中央列；`selectPanel(null)` 回到原生对话；面板注销后
`retainMainPanels` 会把 `activePanelId` 复位。

**渲染指定会话的对话**：注册的条目声明 `children: { '<子槽名>': { kind: 'single', scope: 'session' } }`
才会从 kit 拿到 `SessionProvider`：

```js
const ref = ctx.sessions.retain(sessionId, { source: 'hkcraftPane' })
h(SessionProvider, { session: ref }, renderSlot('<子槽名>', {}))
// 子槽组件里：renderFactorySlot('conversation.content', { variant: 'main', phase: {}, hero: {} })
```

`renderFactorySlot` 不校验归属；`renderSlot` 只能渲染自己声明的子槽，`ctx.slots.renderSlot` 只接受 root 键。
"当前会话"是**推导**出来的（扫唯一 `mainView` 来源），焦点窗格必须独占它。

**视图切换**：`ctx.uiConversation.binding(sessionId).activate(viewId)`（`viewId` = `chat` | `trajectory`）。

**命令**：

```js
ctx.commandUi.register({
  name: 'resume', label: () => t('...'), description: () => t('...'),
  ui: { kind: 'popupSelect', searchMode: 'fuzzy-label',
        searchLabels: () => ({ placeholder, empty, noResults }),
        options: async (session) => [{ id, label, detail, group }],
        onSelect: async (option, session) => {} },
})
```

`kind: 'action'` 用于无选择器的命令（`/clear`）。命令名与宿主命令重名会抛错。

**会话摘要**：宿主 `sessionController.list()` 的摘要含 `sessionId/updatedAt/running/formatStatus/blank/agentAvailable`；
标题不在 header 里，要单独读 title 投影，缺失时回退首条提问。

## 7. 提交

一个票一个提交，消息用 `feat(<票号>): <一句话>`。**不要**动 `.scratch/` 之外的文档，**不要**动别的票负责的文件。
