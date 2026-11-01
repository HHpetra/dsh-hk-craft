'use strict'

/**
 * The read model over the shell's two list snapshots and its runtime status map.
 *
 * dsh publishes three raw shapes this plugin has to read (`GLOSSARY.md`:
 * 清单快照 / catalog; the durable record is `doc/upstream-contracts.md`):
 *
 * - `sessions.list` → `{ ids, byId, phase }`, one row per session
 *   (`{ id, title, running, blank, updatedAt, retainedBy, projectionValues }`).
 * - `workspaces.list` → `{ items, archivedSessionIds, pinnedSessionIds, phase }`,
 *   one row per workspace (`{ workspaceId, title, path, sessionIds, createdAt }`).
 * - `sessionStatus` → `Map<sessionId, { running, pendingInteraction, completionUnread }>`.
 *
 * Before this module those shapes were parsed in ten files, with five answers to
 * "is this a workspace member", five to "has this conversation started", two
 * `mainView` scans, and six `phase` gates split over two incompatible policies
 * for a missing `phase`. Every one of them is a place an upstream rename breaks.
 * This is the one place they are parsed; everything else asks domain questions
 * and never sees `byId`, `sessionIds` or `retainedBy`.
 *
 * Interface discipline:
 *
 * - **Pure view.** Building one has no subscription, no lifecycle and no `ctx`.
 *   `readCatalogs(ctx)` is the only function here that knows a service name.
 * - **Readiness is exposed, never enforced.** Every query answers from whatever
 *   the snapshots hold; a caller that needs a complete catalog asks `complete()`
 *   (or `sessionsReady()` / `workspacesReady()`). This is what keeps
 *   `/resume` listing a half-loaded catalog while the sidebar waits for both.
 * - **Joined, not filtered.** `sessionsOf` skips only sessions the catalog
 *   cannot resolve. Archived and not-yet-started conversations are *flagged*,
 *   because the callers' policies genuinely differ: `/resume` lists archived
 *   rows and lets the list builder filter them, the sidebar must not.
 * - **Never exposed**, because nothing reads them: `ids`, `displayTitle`,
 *   `path`, `pinnedSessionIds`, the raw `origin` string (the row carries the
 *   `subagent` bit instead). Add a query when a caller appears, not before.
 */

/** Client services this module is allowed to resolve. Nothing else. */
const SESSIONS_SERVICE = 'sessions'
const WORKSPACES_SERVICE = 'workspaces'
const UI_SESSION_SERVICE = 'uiSession'

/** Shared empty result, so a miss allocates nothing. */
const NO_ROWS = Object.freeze([])

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether one list snapshot can be trusted as complete.
 *
 * The single readiness rule (`ADR-0016`):
 *
 * - a missing `phase` counts as ready — that is the plain test double, and
 *   three modules already documented it that way;
 * - `"pending"` (first pull not finished) and `"loading"` (a reload keeping the
 *   previous rows) are **not** ready;
 * - anything else that is not `"ready"` is not ready either.
 *
 * A `loading` snapshot still carries the rows of the previous pull. They are
 * readable, but they cannot prove that a conversation still exists, so a caller
 * that would delete state over them must gate on this.
 *
 * @param {unknown} snapshot `sessions.list` or `workspaces.list` snapshot
 * @returns {boolean}
 */
function phaseReady(snapshot) {
  if (!isRecord(snapshot)) return false
  if (snapshot.phase === undefined) return true
  return snapshot.phase === 'ready'
}

/**
 * One entry of the status map, which is a `Map` in the shell and a plain record
 * in tests and future projections.
 *
 * @param {Map<string, unknown>|Record<string, unknown>|null|undefined} statuses
 * @param {string} sessionId
 * @returns {any}
 */
function readStatusEntry(statuses, sessionId) {
  if (statuses === null || statuses === undefined) return undefined
  if (typeof statuses.get === 'function') return statuses.get(sessionId)
  if (!isRecord(statuses)) return undefined
  return statuses[sessionId]
}

/**
 * A timestamp field as a number, or undefined when it is absent or unusable.
 *
 * `workspaces.list` rows carry `createdAt` as an ISO string; the session rows
 * carry `updatedAt` as a number already.
 *
 * @param {unknown} value
 * @returns {number|undefined}
 */
function parseTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || value === '') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function textOf(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * Build the read model. Call `openCatalog` instead of this: it memoises so the
 * same three snapshots always yield the same object identity.
 *
 * @param {{sessions?: unknown, workspaces?: unknown, statuses?: unknown}} input
 * @returns {any} the frozen catalog
 */
function buildCatalog(input) {
  const sessionsSnapshot = isRecord(input.sessions) ? input.sessions : undefined
  const workspacesSnapshot = isRecord(input.workspaces) ? input.workspaces : undefined
  const statuses = input.statuses

  /** Archived session ids, from the workspaces catalog (the only place they live). */
  const archived = new Set(
    Array.isArray(workspacesSnapshot?.archivedSessionIds)
      ? workspacesSnapshot.archivedSessionIds.filter((id) => typeof id === 'string')
      : [],
  )

  /** @type {Map<string, {row: object, sessionIds: ReadonlyArray<string>}>} */
  const workspaceIndex = new Map()
  const workspaceRows = []
  for (const item of Array.isArray(workspacesSnapshot?.items) ? workspacesSnapshot.items : []) {
    if (!isRecord(item)) continue
    const id = item.workspaceId
    if (typeof id !== 'string' || id === '') continue
    if (workspaceIndex.has(id)) continue
    const row = Object.freeze({
      id,
      title: textOf(item.title),
      createdAt: parseTime(item.createdAt),
    })
    workspaceIndex.set(id, {
      row,
      sessionIds: Array.isArray(item.sessionIds) ? item.sessionIds : NO_ROWS,
    })
    workspaceRows.push(row)
  }
  Object.freeze(workspaceRows)

  /** One frozen row per session id, so repeated queries keep the same identity. */
  const rowCache = new Map()

  /**
   * The plain row for one session, or undefined when the catalog does not have
   * it.
   *
   * `started` is dsh's `blank` inverted, tolerantly: every row the shell
   * publishes carries a boolean `blank`, so `blank !== true` means "a message
   * was sent". Treating a missing `blank` as *started* matches the majority of
   * the call sites this replaced; the strict `blank === false` reading made an
   * unstubbed row look never-started.
   *
   * @param {string} sessionId
   * @returns {object|undefined}
   */
  function session(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    const cached = rowCache.get(sessionId)
    if (cached !== undefined) return cached
    const raw = sessionsSnapshot?.byId?.[sessionId]
    if (!isRecord(raw)) return undefined
    const row = Object.freeze({
      id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : sessionId,
      title: textOf(raw.title),
      started: raw.blank !== true,
      archived: archived.has(sessionId),
      updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
      // A subagent session is a child conversation: it notifies through its
      // parent, never on its own (`GLOSSARY.md`: 桌面通知).
      subagent: raw.origin === 'subagent',
    })
    rowCache.set(sessionId, row)
    return row
  }

  /** @type {Map<string, ReadonlyArray<string>>} workspaceId → member ids */
  const memberIdCache = new Map()

  /**
   * One workspace's session ids, as the workspace catalog lists them.
   *
   * This is the membership on its own, before any join: a restored layout wants
   * "does this workspace still list this session", which stays answerable even
   * when the session catalog cannot resolve a row yet. Order is the workspace's
   * own; duplicates and non-string ids are dropped.
   *
   * @param {unknown} workspaceId
   * @returns {ReadonlyArray<string>}
   */
  function memberIds(workspaceId) {
    if (typeof workspaceId !== 'string' || workspaceId === '') return NO_ROWS
    const cached = memberIdCache.get(workspaceId)
    if (cached !== undefined) return cached
    const entry = workspaceIndex.get(workspaceId)
    const ids = []
    if (entry !== undefined) {
      const seen = new Set()
      for (const sessionId of entry.sessionIds) {
        if (typeof sessionId !== 'string' || sessionId === '' || seen.has(sessionId)) continue
        seen.add(sessionId)
        ids.push(sessionId)
      }
    }
    const frozen = Object.freeze(ids)
    memberIdCache.set(workspaceId, frozen)
    return frozen
  }

  /** @type {Map<string, ReadonlyArray<object>>} workspaceId → joined rows */
  const memberCache = new Map()

  /**
   * One workspace's conversations, in the workspace's own member order, joined
   * against the session catalog.
   *
   * Session ids the catalog cannot resolve are skipped — there is no row to
   * return. Archived and not-yet-started rows stay in the list with their flags
   * set, because whether they may be shown is the caller's policy.
   *
   * An unknown workspace, a missing workspaces catalog and an unready one all
   * answer with an empty list: the join itself is not a readiness gate.
   *
   * @param {unknown} workspaceId
   * @returns {ReadonlyArray<object>}
   */
  function sessionsOf(workspaceId) {
    if (typeof workspaceId !== 'string' || workspaceId === '') return NO_ROWS
    const cached = memberCache.get(workspaceId)
    if (cached !== undefined) return cached
    const rows = []
    for (const sessionId of memberIds(workspaceId)) {
      const row = session(sessionId)
      if (row !== undefined) rows.push(row)
    }
    const joined = Object.freeze(rows)
    memberCache.set(workspaceId, joined)
    return joined
  }

  /** @type {Map<string, string>|null} sessionId → workspaceId, built on first use */
  let ownerIndex = null

  /**
   * The workspace that owns a session, or undefined when the catalog does not
   * place it in one.
   *
   * A session belongs to at most one workspace; if the catalog lists it twice,
   * the first workspace in catalog order wins, which is also the order the
   * sidebar renders.
   *
   * @param {unknown} sessionId
   * @returns {{id: string, title: string, createdAt: number|undefined}|undefined}
   */
  function workspaceOf(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    if (ownerIndex === null) {
      ownerIndex = new Map()
      for (const [workspaceId, entry] of workspaceIndex) {
        for (const id of entry.sessionIds) {
          if (typeof id !== 'string' || ownerIndex.has(id)) continue
          ownerIndex.set(id, workspaceId)
        }
      }
    }
    const workspaceId = ownerIndex.get(sessionId)
    if (workspaceId === undefined) return undefined
    return workspaceIndex.get(workspaceId)?.row
  }

  /** @param {unknown} workspaceId */
  function workspace(workspaceId) {
    if (typeof workspaceId !== 'string' || workspaceId === '') return undefined
    return workspaceIndex.get(workspaceId)?.row
  }

  /** Resolved once: the catalog is immutable. */
  let sessionIdList

  /**
   * Every session id the catalog holds, in catalog order.
   *
   * The keys of `byId`, which dsh publishes in the same order as its `ids`
   * array. Only for a caller that legitimately needs "the sessions there are"
   * rather than one conversation (the terminal default picks a session to ask
   * the shell for its shells).
   *
   * @returns {ReadonlyArray<string>}
   */
  function sessionIds() {
    if (sessionIdList !== undefined) return sessionIdList
    const byId = sessionsSnapshot?.byId
    sessionIdList = Object.freeze(
      isRecord(byId) ? Object.keys(byId).filter((id) => id !== '') : NO_ROWS,
    )
    return sessionIdList
  }

  /** The session dsh treats as the conversation, resolved once. */
  let currentId
  let currentResolved = false

  /**
   * The session the shell shows in its main view: the first row retaining
   * `mainView`. dsh derives "current" from exactly this scan, so reading the
   * retention here is the contract, not an implementation detail
   * (`doc/upstream-contracts.md#retention-sources-and-the-single-mainview-derivation`).
   *
   * @returns {string|undefined}
   */
  function current() {
    if (currentResolved) return currentId
    currentResolved = true
    const byId = sessionsSnapshot?.byId
    if (!isRecord(byId)) return undefined
    for (const key of Object.keys(byId)) {
      const raw = byId[key]
      if (!isRecord(raw)) continue
      const retained = raw.retainedBy?.mainView
      if (typeof retained === 'number' && retained > 0) {
        currentId = typeof raw.id === 'string' && raw.id !== '' ? raw.id : key
        break
      }
    }
    return currentId
  }

  /** @type {Map<string, object>} sessionId → frozen signal */
  const signalCache = new Map()

  /**
   * One session's contribution to a workspace light or a strip dot.
   *
   * The four flags are the plain signals `workspace-status.js`'s rules consume;
   * *how* they combine into a light stays there.
   *
   * `running` reads the live status first and the summary row second, so a
   * shell without the status store still reports a running session. `started`
   * comes from the row (`blank` inverted), never from a status entry: only the
   * Host knows whether a message was ever sent.
   *
   * @param {string} sessionId
   * @returns {Readonly<{running: boolean, waiting: boolean, started: boolean, unread: boolean}>}
   */
  function signal(sessionId) {
    const key = typeof sessionId === 'string' ? sessionId : ''
    const cached = signalCache.get(key)
    if (cached !== undefined) return cached
    const row = session(key)
    const status = readStatusEntry(statuses, key)
    const raw = key === '' ? undefined : sessionsSnapshot?.byId?.[key]
    const pending = status?.pendingInteraction
    const value = Object.freeze({
      running: status?.running === true || (isRecord(raw) && raw.running === true),
      waiting: pending !== undefined && pending !== null,
      started: row?.started === true,
      unread: status?.completionUnread === true,
    })
    signalCache.set(key, value)
    return value
  }

  /**
   * The raw projection payloads for one session, or undefined.
   *
   * `session` is the row's own `projectionValues` (the Agent preset id lives
   * there); `subagents` is `projectionsBySession[id].values.subagentCatalog`.
   * Two places, one lookup — but the *meaning* of both payloads stays with
   * `pane-mode.js` and `pane-subagents.js`, which are already pure and tested.
   * Promote one of them to a named query when a second caller needs it.
   *
   * @param {string} sessionId
   * @returns {{session: any, subagents: any}|undefined}
   */
  function projectionsOf(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    const raw = sessionsSnapshot?.byId?.[sessionId]
    const entry = sessionsSnapshot?.projectionsBySession?.[sessionId]
    const sessionPayload = isRecord(raw) ? raw.projectionValues : undefined
    const subagentsPayload = isRecord(entry) ? entry.values?.subagentCatalog : undefined
    if (sessionPayload === undefined && subagentsPayload === undefined) return undefined
    return Object.freeze({ session: sessionPayload, subagents: subagentsPayload })
  }

  return Object.freeze({
    /** Every workspace in catalog order: `{id, title, createdAt}`. */
    workspaces: () => workspaceRows,
    workspace,
    workspaceOf,
    session,
    memberIds,
    sessionsOf,
    sessionIds,
    current,
    signal,
    projectionsOf,
    /** Whether `sessions.list` can be read as a complete catalog. */
    sessionsReady: () => phaseReady(sessionsSnapshot),
    /** Whether `workspaces.list` can be read as a complete catalog. */
    workspacesReady: () => phaseReady(workspacesSnapshot),
    /**
     * Both catalogs ready — the only state in which a missing session may be
     * treated as gone (restore pruning, cold-start settling).
     */
    complete: () => phaseReady(sessionsSnapshot) && phaseReady(workspacesSnapshot),
  })
}

/** The last input triple and its catalog, so views keep a stable identity. */
let memoKeys = null
/** @type {any} */
let memoCatalog = null

/**
 * The catalog for one set of snapshots.
 *
 * This is a *pure view*: no subscription, no lifecycle, no services. The same
 * three snapshot objects always return the same catalog instance, so a view can
 * hold `catalog` in a dependency array without rebuilding or re-rendering on
 * every read — dsh freezes its snapshots, so their identity only changes when
 * the data does.
 *
 * Any or all of the three inputs may be absent; the catalog still answers (with
 * "not ready" and empty results) instead of throwing.
 *
 * @param {{sessions?: any, workspaces?: any, statuses?: any}} [input]
 * @returns {any} the frozen catalog
 */
function openCatalog(input) {
  const value = isRecord(input) ? input : {}
  const sessions = value.sessions
  const workspaces = value.workspaces
  const statuses = value.statuses
  if (
    memoKeys !== null &&
    memoKeys.sessions === sessions &&
    memoKeys.workspaces === workspaces &&
    memoKeys.statuses === statuses
  ) {
    return memoCatalog
  }
  memoCatalog = buildCatalog({ sessions, workspaces, statuses })
  memoKeys = { sessions, workspaces, statuses }
  return memoCatalog
}

/**
 * One client service, resolved the two ways a caller can hand it over.
 *
 * A live Cordis context answers `get(name)`; a bare services bag (the pane
 * controller's older test faces, `{ sessions, workspaces }`) has the service as
 * a property. A throwing `get` yields undefined rather than propagating: a
 * service that is absent or still loading is never fatal here.
 *
 * @param {any} ctx client Cordis context or services bag
 * @param {string} name service name
 * @returns {any}
 */
function serviceOf(ctx, name) {
  if (ctx === null || ctx === undefined) return undefined
  try {
    if (typeof ctx.get === 'function') return ctx.get(name)
  } catch (_error) {
    return undefined
  }
  return ctx[name]
}

/**
 * @param {any} ctx client Cordis context or services bag
 * @param {string} name service name
 * @returns {any}
 */
function readListSnapshot(ctx, name) {
  try {
    return serviceOf(ctx, name)?.list?.getSnapshot?.()
  } catch (_error) {
    return undefined
  }
}

/**
 * The three raw snapshots behind a catalog, read from the live shell.
 *
 * This is the only function in the client that knows a client-service name for
 * reading; `catalog.js`'s query methods never touch `ctx`. Every read is
 * best-effort: a service that is absent, loads later or throws yields
 * `undefined`, and the catalog degrades instead of the plugin failing to mount.
 *
 * @param {any} ctx client Cordis context or services bag
 * @returns {{sessions: any, workspaces: any, statuses: any}}
 */
function readCatalogs(ctx) {
  let statuses
  try {
    statuses = serviceOf(ctx, UI_SESSION_SERVICE)?.sessionStatus?.getSnapshot?.()
  } catch (_error) {
    statuses = undefined
  }
  return {
    sessions: readListSnapshot(ctx, SESSIONS_SERVICE),
    workspaces: readListSnapshot(ctx, WORKSPACES_SERVICE),
    statuses,
  }
}

module.exports = {
  openCatalog,
  readCatalogs,
  phaseReady,
  readStatusEntry,
  SESSIONS_SERVICE,
  WORKSPACES_SERVICE,
  UI_SESSION_SERVICE,
}