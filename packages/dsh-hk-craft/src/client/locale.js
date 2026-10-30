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
  'command.clear.label': '新会话',
  'command.clear.description': '在当前工作区新开一个会话，旧会话留在历史中',
  'command.resume.label': '恢复会话',
  'command.resume.description': '切换到当前工作区的历史会话',
  'command.resume.search.placeholder': '搜索标题或首条提问',
  'command.resume.search.empty': '当前工作区还没有历史会话',
  'command.resume.search.noResults': '没有匹配的会话',
  'session.untitled': '未命名会话',
  'badge.running': '运行中',
  'time.justNow': '刚刚',
  'time.minutesAgo': '{n} 分钟前',
  'time.hoursAgo': '{n} 小时前',
  'time.daysAgo': '{n} 天前',
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
  'command.clear.label': 'New conversation',
  'command.clear.description': 'Start a new conversation in this workspace; the old one stays in history',
  'command.resume.label': 'Resume conversation',
  'command.resume.description': 'Switch to a past conversation in this workspace',
  'command.resume.search.placeholder': 'Search titles and first prompts',
  'command.resume.search.empty': 'No past conversations in this workspace',
  'command.resume.search.noResults': 'No matching conversations',
  'session.untitled': 'Untitled conversation',
  'badge.running': 'running',
  'time.justNow': 'just now',
  'time.minutesAgo': '{n}m ago',
  'time.hoursAgo': '{n}h ago',
  'time.daysAgo': '{n}d ago',
}

const dictionaries = { zh, en }

module.exports = { zh, en, dictionaries }
