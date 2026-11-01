'use strict'

/**
 * Windows / Electron desktop notifications for dsh sessions.
 *
 * dsh itself has no plugin-facing notification service: the Electron main
 * process only raises a `Notification` for the mandatory-update reminder, and
 * the client's `Toast` is an in-app overlay. A plugin runs in the dsh renderer,
 * where the standard `Notification` API maps to a Windows toast, so this module
 * owns the whole feature without touching the host or the Electron main process.
 *
 * The type taxonomy follows signals dsh already publishes:
 *
 * - `approval`, `question`, `plan-review` come from
 *   `uiSession.sessionStatus.pendingInteraction.kind` (the union dsh's approval,
 *   user-question and plan plugins register).
 * - `completed` is a `running` transition from true to false.
 * - `failed` is `remote.$on("api-session/error")`; a failure wins over the
 *   completion that follows it.
 *
 * The pure half (`diffSessionStatus`, `notificationContent`, settings parsing)
 * is exported for the Node tests; the runtime half only depends on a small
 * service bag and an injected `Notification` constructor.
 */

const { displayWorkspaceName } = require('./workspace-status.js')
const { openCatalog, readCatalogs } = require('./catalog.js')
const { messageOf } = require('./shared.js')

/** Versioned local key; notifications are a client preference, not profile data. */
const STORAGE_KEY = 'dsh.hkcraft.notifications.v1'

const TYPE_APPROVAL = 'approval'
const TYPE_QUESTION = 'question'
const TYPE_PLAN_REVIEW = 'plan-review'
const TYPE_COMPLETED = 'completed'
const TYPE_FAILED = 'failed'

/** User-facing notification types, in the order the settings page lists them. */
const NOTIFICATION_TYPES = Object.freeze([
  TYPE_APPROVAL,
  TYPE_QUESTION,
  TYPE_PLAN_REVIEW,
  TYPE_COMPLETED,
  TYPE_FAILED,
])

/** Types that ask for a human decision; they stay on screen and re-alert. */
const WAITING_TYPES = new Set([TYPE_APPROVAL, TYPE_QUESTION, TYPE_PLAN_REVIEW])

/** How long after a failure a completion is treated as the same turn ending. */
const FAILURE_QUIET_MS = 30_000

/** Longest error excerpt put into a toast body. */
const ERROR_EXCERPT_MAX = 180

/** Defaults: all five types on, sound on, feature enabled, always notify. */
const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  sound: true,
  suppressWhenVisible: false,
  types: Object.freeze({
    [TYPE_APPROVAL]: true,
    [TYPE_QUESTION]: true,
    [TYPE_PLAN_REVIEW]: true,
    [TYPE_COMPLETED]: true,
    [TYPE_FAILED]: true,
  }),
})

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Merge stored/partial settings over the defaults, dropping unknown type keys.
 *
 * @param {unknown} value
 * @returns {{enabled: boolean, sound: boolean, suppressWhenVisible: boolean, types: Record<string, boolean>}}
 */
function normalizeSettings(value) {
  const source = isRecord(value) ? value : {}
  const storedTypes = isRecord(source.types) ? source.types : {}
  const types = {}
  for (const type of NOTIFICATION_TYPES) {
    types[type] = storedTypes[type] === undefined ? DEFAULT_SETTINGS.types[type] : storedTypes[type] === true
  }
  return {
    enabled: source.enabled === undefined ? DEFAULT_SETTINGS.enabled : source.enabled === true,
    sound: source.sound === undefined ? DEFAULT_SETTINGS.sound : source.sound === true,
    suppressWhenVisible:
      source.suppressWhenVisible === undefined
        ? DEFAULT_SETTINGS.suppressWhenVisible
        : source.suppressWhenVisible === true,
    types,
  }
}

/**
 * Read settings from a Storage-like object. Missing storage, missing JSON and
 * malformed JSON all fall back to the defaults.
 *
 * @param {{getItem?: (key: string) => string|null}|null|undefined} storage
 * @returns {{enabled: boolean, sound: boolean, suppressWhenVisible: boolean, types: Record<string, boolean>}}
 */
function readSettings(storage) {
  if (storage === null || storage === undefined || typeof storage.getItem !== 'function') {
    return normalizeSettings(undefined)
  }
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (typeof raw !== 'string' || raw === '') return normalizeSettings(undefined)
    return normalizeSettings(JSON.parse(raw))
  } catch (_error) {
    return normalizeSettings(undefined)
  }
}

/**
 * Persist settings; a missing/full storage is reported as a failure instead of
 * throwing, because notifications must not break the rest of the plugin.
 *
 * @param {{setItem?: (key: string, value: string) => void}|null|undefined} storage
 * @param {{enabled: boolean, sound: boolean, suppressWhenVisible: boolean, types: Record<string, boolean>}} settings
 * @returns {boolean}
 */
function writeSettings(storage, settings) {
  if (storage === null || storage === undefined || typeof storage.setItem !== 'function') return false
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(normalizeSettings(settings)))
    return true
  } catch (_error) {
    return false
  }
}

/**
 * Map a pending interaction to this feature's type.
 *
 * `kind` is set by dsh's own approval and user-question plugins; an unknown
 * future kind is ignored rather than guessed, so the copy never claims the
 * wrong action.
 *
 * @param {{kind?: string}|null|undefined} interaction
 * @returns {'approval'|'question'|'plan-review'|null}
 */
function interactionType(interaction) {
  const kind = interaction?.kind
  return WAITING_TYPES.has(kind) ? kind : null
}

/**
 * @param {unknown} interaction
 * @returns {string|null}
 */
function interactionKey(interaction) {
  return typeof interaction?.key === 'string' && interaction.key !== '' ? interaction.key : null
}

/**
 * Normalize a store snapshot (a `Map` in dsh, a plain record in tests) into a
 * `Map<sessionId, status>`.
 *
 * @param {Map<string, any>|Record<string, any>|null|undefined} snapshot
 * @returns {Map<string, any>}
 */
function statusMap(snapshot) {
  if (snapshot instanceof Map) return new Map(snapshot)
  if (isRecord(snapshot)) return new Map(Object.entries(snapshot))
  return new Map()
}

/**
 * Compare two `sessionStatus` snapshots and return the events worth a toast.
 *
 * A pending interaction is new when its `key` differs from the previous one;
 * a completion is a true → false running transition. A first snapshot must be
 * passed as both arguments (the runtime seeds itself that way), otherwise every
 * already-finished session would look like it just completed.
 *
 * @param {Map<string, any>|Record<string, any>} previous
 * @param {Map<string, any>|Record<string, any>} next
 * @returns {Array<{kind: 'pending', sessionId: string, interaction: any} | {kind: 'completed', sessionId: string}>}
 */
function diffSessionStatus(previous, next) {
  const before = statusMap(previous)
  const after = statusMap(next)
  /** @type {Array<any>} */
  const events = []
  for (const [sessionId, status] of after) {
    const prior = before.get(sessionId)
    const pending = status?.pendingInteraction
    if (pending !== null && pending !== undefined) {
      if (interactionKey(pending) !== interactionKey(prior?.pendingInteraction)) {
        events.push({ kind: 'pending', sessionId, interaction: pending })
      }
    }
    if (prior?.running === true && status?.running === false) {
      events.push({ kind: 'completed', sessionId })
    }
  }
  return events
}

/**
 * Whether one event is wanted by the current settings, session kind and
 * foreground state.
 *
 * The foreground gate is opt-in (`suppressWhenVisible`). When it is on and the
 * dsh window is focused, a session that is currently visible in that window —
 * the focused conversation in the native view, or any pane of the visible
 * workspace in split view — does not raise a toast. A conversation in another
 * workspace, or dsh itself not being focused, still notifies.
 *
 * Subagent sessions are deliberately excluded: their parent turn produces its
 * own completion, and a child finishing mid-parent would otherwise be noise.
 *
 * @param {'approval'|'question'|'plan-review'|'completed'|'failed'} type
 * @param {{enabled: boolean, suppressWhenVisible?: boolean, types: Record<string, boolean>}} settings
 * @param {{subagent?: boolean}|null|undefined} meta
 * @param {{dshFocused?: boolean, visible?: boolean}|null|undefined} [context]
 * @returns {boolean}
 */
function shouldNotify(type, settings, meta, context) {
  if (settings?.enabled !== true) return false
  if (settings.types?.[type] !== true) return false
  if (meta?.subagent === true) return false
  if (settings.suppressWhenVisible === true && context?.dshFocused === true && context?.visible === true) {
    return false
  }
  return true
}

/**
 * Collapse an error chain into one short line for a toast body.
 *
 * @param {unknown} error
 * @returns {string}
 */
function errorExcerpt(error) {
  const text = typeof error === 'string' ? error : messageOf(error)
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return ''
  return collapsed.length > ERROR_EXCERPT_MAX
    ? `${collapsed.slice(0, ERROR_EXCERPT_MAX - 1)}…`
    : collapsed
}

/**
 * Localized title/body for one notification.
 *
 * The workspace prefix is prepended in code rather than in the template so an
 * unknown workspace does not leave empty quotes in the body.
 *
 * @param {'approval'|'question'|'plan-review'|'completed'|'failed'} type
 * @param {{sessionTitle?: string, workspaceName?: string}} meta
 * @param {{toolName?: string, error?: string}} [detail]
 * @param {(key: string, params?: Record<string, unknown>) => string} t
 * @returns {{title: string, body: string}}
 */
function notificationContent(type, meta, detail, t) {
  const session = typeof meta?.sessionTitle === 'string' && meta.sessionTitle !== ''
    ? meta.sessionTitle
    : t('session.untitled')
  const workspace = typeof meta?.workspaceName === 'string' && meta.workspaceName !== ''
    ? meta.workspaceName
    : ''
  const tool = typeof detail?.toolName === 'string' && detail.toolName !== '' ? detail.toolName : ''
  const error = errorExcerpt(detail?.error)

  let bodyKey
  if (type === TYPE_APPROVAL) {
    bodyKey = tool === '' ? 'notify.approval.body.noTool' : 'notify.approval.body'
  } else if (type === TYPE_QUESTION) {
    bodyKey = 'notify.question.body'
  } else if (type === TYPE_PLAN_REVIEW) {
    bodyKey = 'notify.planReview.body'
  } else if (type === TYPE_COMPLETED) {
    bodyKey = 'notify.completed.body'
  } else {
    bodyKey = error === '' ? 'notify.failed.body.noError' : 'notify.failed.body'
  }

  const detailText = t(bodyKey, { session, tool, error })
  return {
    title: t(`notify.${type === TYPE_PLAN_REVIEW ? 'planReview' : type}.title`),
    body: workspace === '' ? detailText : `${workspace} · ${detailText}`,
  }
}

/**
 * One character per type. It keeps two kinds of toast for the same session
 * from sharing a Windows tag, without putting the type name into the tag.
 */
const TYPE_TAG_CODE = Object.freeze({
  [TYPE_APPROVAL]: 'a',
  [TYPE_QUESTION]: 'q',
  [TYPE_PLAN_REVIEW]: 'p',
  [TYPE_COMPLETED]: 'c',
  [TYPE_FAILED]: 'f',
})

/**
 * Windows toast tags are at most 64 characters. Electron forwards Chromium's
 * notification id `n#{origin}#{tag}` unchanged, and the desktop origin
 * `dsh-app://app` already spends 16 of those characters. A raw
 * `dsh-hkcraft:{type}:session-{uuid}` tag is longer than what remains, so
 * Windows rejects the toast before it is shown.
 *
 * Twenty alphanumeric characters stay inside that budget: `hkc`, the type
 * code, and 16 hex digits of FNV-1a over the session id. The same type and
 * session keep the same tag, so a newer toast still replaces the previous one.
 */
const TAG_PREFIX = 'hkc'

/**
 * @param {string} text
 * @returns {string} 16 lowercase hex digits
 */
function fnv1a64Hex(text) {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  const value = String(text)
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    hash ^= BigInt(code & 0xff)
    hash = (hash * prime) & mask
    hash ^= BigInt((code >> 8) & 0xff)
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}

/**
 * The toast tag: one live notification per type and session.
 *
 * @param {string} type
 * @param {string} sessionId
 * @returns {string}
 */
function notificationTag(type, sessionId) {
  return `${TAG_PREFIX}${TYPE_TAG_CODE[type] ?? 'x'}${fnv1a64Hex(sessionId)}`
}

/**
 * @returns {{getItem?: Function, setItem?: Function}|undefined}
 */
function defaultStorage() {
  try {
    return typeof globalThis.localStorage === 'object' && globalThis.localStorage !== null
      ? globalThis.localStorage
      : undefined
  } catch (_error) {
    return undefined
  }
}

/**
 * Build the notifier.
 *
 * Options are injectable for the unit tests; the production wiring in
 * `index.js` passes the plugin context, the pane controller, the bound
 * translator and the browser globals.
 *
 * @param {{
 *   ctx: any,
 *   controller?: any,
 *   t: (key: string, params?: Record<string, unknown>) => string,
 *   storage?: any,
 *   NotificationImpl?: any,
 *   documentRef?: any,
 *   windowRef?: any,
 * }} options
 */
function createNotifier(options) {
  const ctx = options.ctx
  const controller = options.controller
  const t = options.t
  const storage = options.storage ?? defaultStorage()
  const NotificationImpl = options.NotificationImpl
  const documentRef = options.documentRef
  const windowRef = options.windowRef

  let settings = readSettings(storage)
  let previous = new Map()
  let started = false
  let disposed = false
  let stopStatus = null
  let stopError = null
  /** @type {Map<string, number>} */
  const recentFailures = new Map()
  /** @type {Set<any>} */
  const liveNotifications = new Set()
  /** @type {Map<string, any>} */
  const sessionNotifications = new Map()
  /** @type {Set<() => void>} */
  const listeners = new Set()
  let cachedSnapshot = null
  let snapshotDirty = true

  /** A service read that never makes an absent/injected-late service fatal. */
  function service(name) {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
    } catch (_error) {
      return undefined
    }
  }

  function permissionState() {
    if (!NotificationImpl) return 'unsupported'
    const value = NotificationImpl.permission
    if (value === 'granted' || value === 'denied' || value === 'default') return value
    // Some test doubles and older shells omit `permission`; assume granted
    // because the dsh Electron session grants non-media permissions.
    return 'granted'
  }

  /** Whether the dsh window itself has OS focus and is not hidden/minimized. */
  function dshIsFocused() {
    try {
      if (documentRef?.visibilityState === 'hidden') return false
      return typeof documentRef?.hasFocus === 'function' && documentRef.hasFocus() === true
    } catch (_error) {
      return false
    }
  }

  /**
   * Whether this conversation is on screen in the focused dsh window.
   *
   * In split view every pane of the visible workspace is visible at once, so
   * `paneIndexOf` answers for the active layout; the native view has exactly
   * one visible conversation, which is the retained `mainView` the catalog
   * reports as current.
   */
  function sessionIsVisible(sessionId) {
    try {
      if (
        controller?.getSnapshot?.()?.active === true &&
        typeof controller?.layout?.paneIndexOf === 'function'
      ) {
        const index = controller.layout.paneIndexOf(sessionId)
        return index !== null && index !== undefined
      }
    } catch (_error) {
      // Fall through to the native visibility answer.
    }
    try {
      return openCatalog(readCatalogs(ctx)).current() === sessionId
    } catch (_error) {
      return false
    }
  }

  function snapshot() {
    if (!snapshotDirty && cachedSnapshot !== null) return cachedSnapshot
    cachedSnapshot = Object.freeze({
      settings: Object.freeze({
        enabled: settings.enabled,
        sound: settings.sound,
        suppressWhenVisible: settings.suppressWhenVisible,
        types: Object.freeze({ ...settings.types }),
      }),
      supported: Boolean(NotificationImpl),
      permission: permissionState(),
    })
    snapshotDirty = false
    return cachedSnapshot
  }

  function publish() {
    snapshotDirty = true
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (_error) {
        // A settings listener must not break notification delivery.
      }
    }
  }

  /** Session title, workspace name and kind from the read model. */
  function sessionMeta(sessionId) {
    const catalog = openCatalog(readCatalogs(ctx))
    const row = catalog.session(sessionId)
    const workspace = catalog.workspaceOf(sessionId)
    return {
      sessionTitle: row === undefined || row.title === '' ? t('session.untitled') : row.title,
      workspaceName:
        workspace === undefined ? '' : displayWorkspaceName(workspace.title, t('workspace.defaultName')),
      subagent: row?.subagent === true,
    }
  }

  /** Bring dsh forward and reveal the conversation that produced the toast. */
  function reveal(sessionId) {
    try {
      windowRef?.focus?.()
    } catch (_error) {
      // Focus is best-effort; the click still dismisses the toast.
    }
    try {
      const paneActive = controller?.getSnapshot?.()?.active === true
      if (paneActive && typeof controller?.budget?.openInNewPane === 'function') {
        // Already-open sessions are focused; a new pane is capped like any
        // other split. A refusal leaves the shell where it is.
        Promise.resolve(controller.budget.openInNewPane(sessionId)).catch(() => {})
        return
      }
    } catch (_error) {
      // Fall through to the native reveal.
    }
    try {
      const uiWorkspace = service('uiWorkspace')
      if (typeof uiWorkspace?.openSession === 'function') uiWorkspace.openSession(sessionId)
    } catch (_error) {
      // The notification click must never throw into the page.
    }
  }

  function track(notification, sessionId) {
    liveNotifications.add(notification)
    if (typeof sessionId === 'string' && sessionId !== '') {
      const previous = sessionNotifications.get(sessionId)
      if (previous !== undefined && previous !== notification) {
        // A new state for the same session (approval answered, question asked,
        // then completed) must not leave the older, now-stale toast behind.
        try {
          previous.close?.()
        } catch (_error) {}
      }
      sessionNotifications.set(sessionId, notification)
    }
    const release = () => {
      liveNotifications.delete(notification)
      if (sessionNotifications.get(sessionId) === notification) sessionNotifications.delete(sessionId)
      notification.onclick = null
      notification.onerror = null
      notification.onclose = null
    }
    notification.onerror = release
    notification.onclose = release
    return release
  }

  function show(title, body, extra, sessionId) {
    if (!NotificationImpl) return { ok: false, reason: 'unsupported' }
    if (permissionState() !== 'granted') return { ok: false, reason: 'permission' }
    try {
      const notification = new NotificationImpl(title, { body, ...extra })
      track(notification, sessionId)
      return { ok: true, notification }
    } catch (error) {
      return { ok: false, reason: 'error', message: messageOf(error) }
    }
  }

  function send(type, sessionId, detail = {}) {
    const meta = sessionMeta(sessionId)
    const context = { dshFocused: dshIsFocused(), visible: sessionIsVisible(sessionId) }
    if (!shouldNotify(type, settings, meta, context)) return { ok: false, reason: 'disabled' }
    const content = notificationContent(type, meta, detail, t)
    const extra = {
      tag: notificationTag(type, sessionId),
      silent: !settings.sound,
      requireInteraction: WAITING_TYPES.has(type),
      renotify: WAITING_TYPES.has(type),
      timestamp: Date.now(),
      data: { type, sessionId },
    }
    const result = show(content.title, content.body, extra, sessionId)
    if (result.ok) result.notification.onclick = () => reveal(sessionId)
    return result
  }

  function onPending(event) {
    const type = interactionType(event.interaction)
    if (type === null) return
    send(type, event.sessionId, { toolName: event.interaction?.toolName })
  }

  function onCompleted(event) {
    const failedAt = recentFailures.get(event.sessionId)
    if (failedAt !== undefined && Date.now() - failedAt < FAILURE_QUIET_MS) {
      recentFailures.delete(event.sessionId)
      return
    }
    send(TYPE_COMPLETED, event.sessionId)
  }

  function onStatus(snapshotValue) {
    if (disposed) return
    const next = statusMap(snapshotValue)
    const events = diffSessionStatus(previous, next)
    previous = next
    const pendingSessions = new Set()
    for (const event of events) if (event.kind === 'pending') pendingSessions.add(event.sessionId)
    for (const event of events) {
      try {
        if (event.kind === 'pending') onPending(event)
        else if (!pendingSessions.has(event.sessionId)) onCompleted(event)
      } catch (error) {
        console.error('[dsh-hk-craft] notification failed', error)
      }
    }
  }

  function onError(sessionId, message) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    recentFailures.set(sessionId, Date.now())
    // Bound the map even for sessions whose completion never arrives.
    if (recentFailures.size > 200) {
      const cutoff = Date.now() - FAILURE_QUIET_MS
      for (const [id, at] of recentFailures) if (at < cutoff) recentFailures.delete(id)
    }
    try {
      send(TYPE_FAILED, sessionId, { error: message })
    } catch (error) {
      console.error('[dsh-hk-craft] failure notification failed', error)
    }
  }

  function start() {
    if (disposed) return () => {}
    if (started) return stop
    const store = service('uiSession')?.sessionStatus
    if (store === undefined || store === null || typeof store.getSnapshot !== 'function' || typeof store.subscribe !== 'function') {
      return () => {}
    }
    previous = statusMap(store.getSnapshot())
    started = true
    try {
      stopStatus = store.subscribe(() => {
        try {
          onStatus(store.getSnapshot())
        } catch (error) {
          console.error('[dsh-hk-craft] notification status failed', error)
        }
      })
    } catch (error) {
      started = false
      console.error('[dsh-hk-craft] could not subscribe to session status', error)
      return () => {}
    }
    const remote = service('remote')
    if (typeof remote?.$on === 'function') {
      try {
        const off = remote.$on('api-session/error', (sessionId, message) => onError(sessionId, message))
        if (typeof off === 'function') stopError = off
      } catch (_error) {
        // An older shell may not forward this event; completion still works.
      }
    }
    return stop
  }

  function stop() {
    if (!started) return
    started = false
    try {
      stopStatus?.()
    } catch (_error) {}
    try {
      stopError?.()
    } catch (_error) {}
    stopStatus = null
    stopError = null
  }

  function setSettings(patch) {
    const next = isRecord(patch) ? patch : {}
    settings = normalizeSettings({
      ...settings,
      ...next,
      types: {
        ...settings.types,
        ...(isRecord(next.types) ? next.types : {}),
      },
    })
    writeSettings(storage, settings)
    publish()
    return snapshot()
  }

  async function requestPermission() {
    if (!NotificationImpl) return 'unsupported'
    if (typeof NotificationImpl.requestPermission !== 'function') return permissionState()
    try {
      await NotificationImpl.requestPermission()
    } catch (_error) {
      // Report whatever the platform now says.
    }
    publish()
    return permissionState()
  }

  async function sendTest() {
    if (!NotificationImpl) return { ok: false, reason: 'unsupported' }
    if (permissionState() === 'default') await requestPermission()
    const permission = permissionState()
    if (permission !== 'granted') return { ok: false, reason: 'permission' }
    const result = show(t('notify.test.title'), t('notify.test.body'), {
      tag: 'hkctest',
      silent: !settings.sound,
    })
    if (result.ok !== true) return result
    result.notification.onclick = () => {
      try {
        windowRef?.focus?.()
      } catch (_error) {}
    }
    return { ok: true }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    stop()
    for (const notification of [...liveNotifications]) {
      try {
        notification.close?.()
      } catch (_error) {}
    }
    liveNotifications.clear()
    sessionNotifications.clear()
    recentFailures.clear()
    listeners.clear()
  }

  return {
    start,
    stop,
    dispose,
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: snapshot,
    setSettings,
    requestPermission,
    sendTest,
    /** Test-only seam; production uses the status store. */
    _send: send,
  }
}

module.exports = {
  STORAGE_KEY,
  TYPE_APPROVAL,
  TYPE_QUESTION,
  TYPE_PLAN_REVIEW,
  TYPE_COMPLETED,
  TYPE_FAILED,
  NOTIFICATION_TYPES,
  WAITING_TYPES,
  DEFAULT_SETTINGS,
  FAILURE_QUIET_MS,
  normalizeSettings,
  readSettings,
  writeSettings,
  interactionType,
  interactionKey,
  diffSessionStatus,
  shouldNotify,
  errorExcerpt,
  notificationContent,
  notificationTag,
  createNotifier,
}