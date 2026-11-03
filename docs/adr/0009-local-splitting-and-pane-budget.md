# 分屏改为 dsh 侧边栏式的局部分栏，并增加可配置的窗格上限

`+`、`Ctrl+Shift+E` 与 `/resume` 的 Ctrl+Enter 只分割焦点窗格，新窗格是它的右兄弟并获得焦点，其余窗格的位置与比例不变；空工作区直接打开第一格，不消耗预算。每个工作区默认最多 4 格，可在 HK Craft 设置页改为任意非负整数（`0` 不限制），上限只阻止新建、不关闭已有窗格，值存在 origin 级 `dsh.hkcraft.settings.v1`。分栏规则在插件内实现（`layout-tree.js` / `pane-budget.js`），不 import dsh 内部的 dockkit。

**状态**：accepted
