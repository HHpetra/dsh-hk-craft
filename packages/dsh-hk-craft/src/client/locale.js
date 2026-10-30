'use strict'

/**
 * Copy for the client half. Registered through `ctx.locale.register` at load
 * time; slot-rendered copy follows a live locale switch, copy captured at
 * registration time does not.
 *
 * Keys are flat and dotted so the same table can be read both by `t('a.b')`
 * and by the fallback translator used when a slot hands us no `t`.
 */

/** @type {Record<string, string>} */
const zh = {
  'action.label': '窗格',
  'action.title': 'dsh-hk-craft —— 窗格视图',
  'panel.title': 'dsh-hk-craft',
  'panel.loaded': '客户端已加载',
  'panel.entry': '入口',
  'panel.hint': '分屏与历史会话选择器会出现在这里。',
  'panel.close': '关闭',
  'workspace.section': '工作区',
  'workspace.add': '添加工作区',
  'workspace.addFailed': '无法添加工作区',
  'workspace.defaultName': '默认工作区',
  'workspace.light.red': '有会话在等你',
  'workspace.light.yellow': '有会话运行中',
  'workspace.light.green': '无活动会话',
}

/** @type {Record<string, string>} */
const en = {
  'action.label': 'Panes',
  'action.title': 'dsh-hk-craft — pane view',
  'panel.title': 'dsh-hk-craft',
  'panel.loaded': 'Client loaded',
  'panel.entry': 'Entry',
  'panel.hint': 'Split panes and the history picker will live here.',
  'panel.close': 'Close',
  'workspace.section': 'Workspaces',
  'workspace.add': 'Add workspace',
  'workspace.addFailed': 'Could not add workspace',
  'workspace.defaultName': 'Default Workspace',
  'workspace.light.red': 'A session is waiting for you',
  'workspace.light.yellow': 'A session is running',
  'workspace.light.green': 'No active session',
}

const dictionaries = { zh, en }

module.exports = { zh, en, dictionaries }
