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
}

const dictionaries = { zh, en }

module.exports = { zh, en, dictionaries }
