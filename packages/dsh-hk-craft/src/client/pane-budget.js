'use strict'

/**
 * The workspace pane budget and the persisted `maxPanes` setting.
 *
 * dsh's right sidebar caps a docking surface at a fixed number of panes and
 * disables its split control once that budget is spent
 * (`@deepseek-ai/dsh-client-ui-dockkit/engine/constraints.ts`). This plugin
 * follows the same rule, but the cap is a user setting: 4 panes by default, 0
 * means unlimited. The budget only gates *creating* a pane; it never closes an
 * existing one, so lowering the setting (or restoring a wider saved layout)
 * cannot destroy work.
 *
 * The setting is origin-wide, like the per-workspace layout keys in
 * `layout-store.js`, and lives under one versioned key:
 *
 *   `dsh.hkcraft.settings.v1` → `{ "version": 1, "maxPanes": 4 }`
 *
 * Reading never throws: a missing store, a corrupt payload or an invalid value
 * falls back to the default. Writing is best-effort, exactly like layout
 * persistence.
 *
 * This module has no React, no DOM and no dsh imports.
 */

const { leaves, replaceSession, split: splitLayout } = require('./layout-tree.js')
const { messageOf } = require('./shared.js')
const { UNSCOPED_WORKSPACE } = require('./pane-layouts.js')

/** Pane cap used when the setting is absent or invalid. */
const DEFAULT_MAX_PANES = 4

/** Prefix and version of the origin-wide settings payload. */
const PANE_SETTINGS_KEY = 'dsh.hkcraft.settings.v1'
const PANE_SETTINGS_VERSION = 1

/**
 * Read a non-negative safe integer from a number or a digit string.
 *
 * Unusable input is `null` (no fallback). `normalizeMaxPanes` turns that into
 * the default cap; the settings field keeps the `null` so it can show a
 * validation error instead of saving. Numbers stay numbers. Strings are
 * trimmed and must be all digits.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function parseNonNegativeInteger(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!/^\d+$/u.test(text)) return null
  const parsed = Number(text)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/**
 * Coerce a setting value to a usable pane cap.
 *
 * Accepts a non-negative safe integer or a string of digits (the number input
 * hands back strings). Everything else — negatives, decimals, NaN, booleans,
 * an empty string — falls back, so a corrupted store can never make panes
 * unopenable.
 *
 * @param {unknown} value raw setting value
 * @param {number} [fallback] cap used when `value` is unusable
 * @returns {number} a non-negative integer; 0 means unlimited
 */
function normalizeMaxPanes(value, fallback = DEFAULT_MAX_PANES) {
  const base = Number.isSafeInteger(fallback) && fallback >= 0 ? fallback : DEFAULT_MAX_PANES
  return parseNonNegativeInteger(value) ?? base
}

/**
 * The pane cap stored in one storage seam.
 *
 * @param {{getItem?: (key: string) => unknown}|undefined|null} storage
 * @returns {number} the stored cap, or `DEFAULT_MAX_PANES`
 */
function readMaxPanes(storage) {
  let raw = null
  try {
    if (typeof storage?.getItem === 'function') raw = storage.getItem(PANE_SETTINGS_KEY)
  } catch (_error) {
    return DEFAULT_MAX_PANES
  }
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_MAX_PANES
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (_error) {
    return DEFAULT_MAX_PANES
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.version !== PANE_SETTINGS_VERSION) {
    return DEFAULT_MAX_PANES
  }
  return normalizeMaxPanes(parsed.maxPanes)
}

/**
 * Persist one pane cap. Failures (quota, disabled storage, no store) are
 * reported as `false` and never thrown.
 *
 * @param {{setItem?: (key: string, value: string) => unknown}|undefined|null} storage
 * @param {unknown} value raw cap; it is normalised before writing
 * @returns {{ok: boolean, maxPanes: number, message?: string}} the value that was
 *   written. `ok: false` never throws; `message` is empty when there is no store.
 */
function writeMaxPanes(storage, value) {
  const maxPanes = normalizeMaxPanes(value)
  if (typeof storage?.setItem !== 'function') return { ok: false, maxPanes, message: '' }
  try {
    storage.setItem(
      PANE_SETTINGS_KEY,
      JSON.stringify({ version: PANE_SETTINGS_VERSION, maxPanes }),
    )
    return { ok: true, maxPanes }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, maxPanes, message }
  }
}

/**
 * The number of panes one layout currently holds.
 *
 * @param {{root?: object|null}|null|undefined} layout
 * @returns {number}
 */
function paneCount(layout) {
  return leaves(layout?.root ?? null).length
}

/**
 * Whether a pane total has reached the cap.
 *
 * `maxPanes` is normalised first, so a missing value reads as the default cap
 * rather than as unlimited. `0` means unlimited. `count` is whatever the
 * caller is gating on: open leaves, or open leaves plus splits already
 * reserved but not yet written into the tree.
 *
 * @param {number} count
 * @param {unknown} maxPanes the configured cap; 0 means unlimited
 * @returns {boolean}
 */
function isPaneBudgetSpent(count, maxPanes) {
  const limit = normalizeMaxPanes(maxPanes)
  if (limit === 0) return false
  return count >= limit
}

/**
 * Whether one layout has spent its pane budget.
 *
 * Floating panes do not exist in this plugin, so the docked leaf count is the
 * whole count. In-flight reservations are not leaves; the controller adds
 * those before calling `isPaneBudgetSpent`.
 *
 * @param {{root?: object|null}|null|undefined} layout layout or snapshot with a root
 * @param {unknown} maxPanes the configured cap; 0 means unlimited
 * @returns {boolean}
 */
function paneBudgetBlocked(layout, maxPanes) {
  return isPaneBudgetSpent(paneCount(layout), maxPanes)
}

/**
 * Pane creation, as one holder with its own face (ADR-0017).
 *
 * The kernel transacts layouts; this holder decides whether a transaction may
 * start. It owns three cells the kernel never touches again — `maxPanes`, the
 * per-workspace `pendingSplits` reservations and the per-workspace
 * `pendingFirstPanes` set — plus the two snapshot fields of the cap.
 *
 * The four entry points look similar but answer different questions:
 * - `split(paneId, dir)` divides an existing pane and creates the conversation;
 * - `newPane()` is `+` on the strip: split beside the focus, or open the first pane;
 * - `openInNewPane(sessionId)` mounts a chosen conversation beside the focus;
 * - `newInFocused(workspaceId)` is `/clear` and `/new`: replace the focused
 *   conversation, or open the first pane of an empty workspace.
 *
 * Reservations exist because `sessions.create` is asynchronous: a split that has
 * passed the cap check but has no session yet must still count against the cap,
 * otherwise a second request slips through in the gap and the workspace ends up
 * one pane over its limit.
 *
 * @param {object} deps
 * @param {{setItem?: Function}|null} deps.storage the settings seam
 * @param {any} deps.book the layout book (per-workspace trees)
 * @param {() => boolean} deps.isDisposed
 * @param {() => boolean} deps.isRegistered whether the shadow slot is mounted
 * @param {() => boolean} deps.isActive whether split mode is on
 * @param {(patch: object) => void} deps.emit kernel state emitter
 * @param {() => void} deps.republish bump the snapshot identity without a field change
 * @param {(sessionId: string) => string|undefined} deps.workspaceOf
 * @param {() => string|null} deps.focusedWorkspaceId
 * @param {(workspaceId: string) => boolean} deps.ensureWorkspace
 * @param {(layout: object, workspaceId?: string|null) => boolean} deps.apply
 * @param {(sessionId: string) => object} deps.freshPane
 * @param {(layout: object, sessionId: string, workspaceId?: string|null) => boolean} deps.openSessionPane
 * @param {(paneId: string) => boolean} deps.focusPane
 * @param {(sessionId: string) => boolean} deps.replaceFocused
 * @param {(workspaceId: string|null) => boolean} deps.switchWorkspace
 * @param {(workspaceId: string) => Promise<string>} deps.createSession
 */
function createSplitBudget(deps) {
  const {
    storage,
    book,
    isDisposed,
    isRegistered,
    isActive,
    emit,
    republish,
    workspaceOf,
    focusedWorkspaceId,
    ensureWorkspace,
    apply,
    freshPane,
    openSessionPane,
    focusPane,
    replaceFocused,
    switchWorkspace,
    createSession,
  } = deps

  /** The cap shared by every workspace; 0 means unlimited. */
  let maxPanes = readMaxPanes(storage)
  /**
   * A failed write does not roll the memory value back, so the settings page can
   * report the failure while `splitBlock` already uses the new cap.
   *
   * @type {string|null}
   */
  let maxPanesError = null
  /**
   * Splits that have passed the budget check but are still awaiting
   * `sessions.create`, counted with the open panes.
   *
   * @type {Map<string, number>}
   */
  const pendingSplits = new Map()
  /**
   * Empty workspaces whose first pane is still awaiting `sessions.create`. This
   * is not a budget reservation: the first pane does not spend the split cap. It
   * only stops a second new-session request from calling `sessions.create`
   * again. When that first create returns, the pane is written only if the same
   * workspace is still empty.
   *
   * @type {Set<string>}
   */
  const pendingFirstPanes = new Set()

  /** @param {string|null} workspaceId */
  function splitBudgetKey(workspaceId) {
    return workspaceId === null ? UNSCOPED_WORKSPACE : workspaceId
  }

  /** @param {string|null} workspaceId */
  function pendingSplitCount(workspaceId) {
    return pendingSplits.get(splitBudgetKey(workspaceId)) ?? 0
  }

  /**
   * Whether one workspace has spent its pane budget: open panes plus splits
   * already committed to creating a session.
   *
   * @param {string|null} workspaceId
   * @returns {boolean}
   */
  function paneBudgetSpent(workspaceId) {
    const open = paneCount(book.layoutOf(workspaceId))
    return isPaneBudgetSpent(open + pendingSplitCount(workspaceId), maxPanes)
  }

  /**
   * `splitBlock` reads the reservation map, which is not a snapshot field.
   * Subscribers (the strip) only re-read it when the snapshot identity changes.
   */
  function publishPendingSplit() {
    if (typeof republish === 'function') republish()
  }

  /** @param {string|null} workspaceId */
  function reserveSplit(workspaceId) {
    const key = splitBudgetKey(workspaceId)
    pendingSplits.set(key, pendingSplitCount(workspaceId) + 1)
  }

  /**
   * @param {string|null} workspaceId
   * @param {boolean} [publish] false when the caller is about to publish the
   *   layout itself, so the pane is not counted once as open and again as pending
   */
  function releaseSplit(workspaceId, publish = true) {
    const key = splitBudgetKey(workspaceId)
    const next = pendingSplitCount(workspaceId) - 1
    if (next <= 0) pendingSplits.delete(key)
    else pendingSplits.set(key, next)
    if (publish) publishPendingSplit()
  }

  /** Record a refused split. No pane is created and no session is requested. */
  function refuseSplitBudget() {
    emit({ error: `cannot split: the workspace pane limit (${maxPanes}) is reached` })
    return false
  }

  /**
   * The workspace a new conversation for `pane` belongs to: the pane session's
   * own workspace, else the layout's. A pane tree only holds sessions of one
   * workspace (ADR-0005 D3).
   *
   * @param {{sessionId: string}} pane
   * @param {string|null} workspaceId
   * @returns {string|undefined}
   */
  function newSessionWorkspaceOf(pane, workspaceId) {
    return (
      workspaceOf(pane.sessionId) ??
      (workspaceId === null ? undefined : book.layoutOf(workspaceId).workspaceId)
    )
  }

  /**
   * Create the conversation for a new pane and report a failure.
   *
   * @param {{paneId: string, sessionId: string}} pane
   * @param {string|null} workspaceId
   * @param {string} action error verb, e.g. "split" or "add a pane"
   * @returns {Promise<string|undefined>} undefined when no workspace can be
   *   resolved, the Host call fails, or the kernel was disposed in flight
   */
  async function createNewPaneSession(pane, workspaceId, action) {
    const owningWorkspace = newSessionWorkspaceOf(pane, workspaceId)
    if (owningWorkspace === undefined) {
      emit({ error: `cannot ${action}: pane ${pane.paneId} has no workspace` })
      return undefined
    }
    try {
      const sessionId = await createSession(owningWorkspace)
      return isDisposed() ? undefined : sessionId
    } catch (error) {
      emit({ error: messageOf(error) })
      return undefined
    }
  }

  /**
   * Split `paneId` to the right (or down) and open (or create) the conversation
   * in the new pane.
   *
   * A horizontal split keeps the new pane as the reference pane's right
   * neighbour, then evens the row by the current pane count. A vertical split
   * still only halves the reference pane. Splitting is refused once the
   * workspace holds `maxPanes` panes (0 means unlimited); focusing a session
   * that is already mounted is never refused, because it adds no pane.
   *
   * @param {string} paneId
   * @param {'row'|'col'} dir
   * @param {{sessionId?: string}} [options]
   * @returns {Promise<boolean>}
   */
  async function split(paneId, dir, options = {}) {
    if (isDisposed() || !isRegistered()) return false
    const located = book.locatePane(paneId)
    if (located === null) return false
    const origin = located.pane
    const workspaceId = located.workspaceId
    if (dir !== 'row' && dir !== 'col') return false

    let sessionId = options?.sessionId
    if (sessionId !== undefined) {
      if (typeof sessionId !== 'string' || sessionId === '') return false
      const owningWorkspace = workspaceOf(sessionId)
      if (owningWorkspace !== undefined && workspaceId !== null && owningWorkspace !== workspaceId) {
        // A pane tree only holds sessions of one workspace (spec D3): show the
        // session in its own workspace instead of mounting it across trees.
        if (!ensureWorkspace(owningWorkspace)) {
          emit({ error: `cannot show workspace ${owningWorkspace}` })
          return false
        }
        const holder = book.locatePaneIn(sessionId)
        if (holder !== null) focusPane(holder.paneId)
        else switchWorkspace(owningWorkspace)
        return false
      }
      const holder = book.locatePaneIn(sessionId)
      if (holder !== null) {
        if (holder.paneId !== paneId || holder.workspaceId !== workspaceId) {
          focusPane(holder.paneId)
        }
        return false
      }
    }

    // Reserve before `sessions.create`. A later cap change does not cancel this
    // split; only a new request is judged against the new cap. The reservation
    // is dropped before the layout write, with no await in between, so another
    // caller cannot pass the check in the gap and subscribers never count the
    // new pane twice (once open, once still pending).
    //
    // `reservationHeld` is the cleanup duty while the create is in flight.
    // `publishRelease` is set once that reservation is dropped without a
    // snapshot, and cleared only after `apply` publishes. An unchanged tree
    // (`split` returns the same layout) and a throw from `apply` both leave it
    // set, so the strip learns the slot is free again.
    let reservationHeld = false
    let publishRelease = false
    try {
      if (sessionId === undefined) {
        if (paneBudgetSpent(workspaceId)) return refuseSplitBudget()
        reserveSplit(workspaceId)
        reservationHeld = true
        publishPendingSplit()
        sessionId = await createNewPaneSession(origin, workspaceId, 'split')
        if (sessionId === undefined) return false
      } else if (paneBudgetSpent(workspaceId)) {
        return refuseSplitBudget()
      }

      if (reservationHeld) {
        releaseSplit(workspaceId, false)
        reservationHeld = false
        publishRelease = true
      }

      const current = book.layoutOf(workspaceId)
      const next = splitLayout(current, paneId, dir, freshPane(sessionId))
      if (next === current) return false
      const applied = apply(next, workspaceId)
      publishRelease = false
      return applied
    } finally {
      if (reservationHeld) releaseSplit(workspaceId)
      else if (publishRelease) publishPendingSplit()
    }
  }

  /**
   * Pane-aware `/clear`: a new conversation in the focused pane, or the first
   * pane when that workspace is empty.
   *
   * While that first session is still being created, another new-session
   * request for the same empty workspace is ignored and does not call
   * `sessions.create`. After the pane is open, this replaces the focused
   * pane's conversation, and `newPane` splits beside it.
   *
   * When the first create returns, the pane is written only into the workspace
   * that was empty at the start, and only while that workspace still has no
   * panes. A pane opened while waiting is left alone, and the created session
   * stays in history. Switching away during the create does not pull the new
   * session into the visible workspace or switch the view back. A `/clear`
   * that already had a focused pane replaces that same pane in the workspace
   * it started in, even if another workspace is on screen when the session
   * arrives.
   *
   * @param {string} [workspaceId]
   * @returns {Promise<boolean>}
   */
  async function newInFocused(workspaceId) {
    if (isDisposed() || !isRegistered()) return false
    if (!isActive()) return false
    const targetWorkspace = workspaceId ?? focusedWorkspaceId()
    if (typeof targetWorkspace !== 'string' || targetWorkspace === '') return false
    if (!ensureWorkspace(targetWorkspace)) return false
    const openingFirst = book.layoutOf(targetWorkspace).root === null
    if (openingFirst && pendingFirstPanes.has(targetWorkspace)) return false
    if (openingFirst) pendingFirstPanes.add(targetWorkspace)
    try {
      if (targetWorkspace !== book.getActiveWorkspaceId()) {
        if (!switchWorkspace(targetWorkspace)) return false
      }
      // The pane `/clear` is aimed at, after any switch onto this workspace.
      // Captured before the await so a later workspace change cannot retarget it.
      const originPaneId = book.layoutOf(targetWorkspace).activePaneId
      let sessionId
      try {
        sessionId = await createSession(targetWorkspace)
      } catch (error) {
        emit({ error: messageOf(error) })
        return false
      }
      if (isDisposed()) return false
      if (openingFirst) {
        // Judge the workspace that started this create, not whichever tree is
        // visible now. A pane opened while waiting stays put. An empty tree
        // receives this session where it was requested, without switching the
        // visible workspace back.
        const origin = book.layoutOf(targetWorkspace)
        if (origin.root !== null) return false
        return openSessionPane(origin, sessionId, targetWorkspace)
      }
      if (book.getActiveWorkspaceId() !== targetWorkspace) {
        const origin = book.layoutOf(targetWorkspace)
        if (typeof originPaneId !== 'string' || origin.panes[originPaneId] === undefined) return false
        const next = replaceSession(origin, originPaneId, sessionId)
        if (next === origin) return true
        return apply(next, targetWorkspace)
      }
      const current = book.activeLayout()
      if (current.activePaneId !== null) return replaceFocused(sessionId)
      return openSessionPane(current, sessionId, targetWorkspace)
    } finally {
      if (openingFirst) pendingFirstPanes.delete(targetWorkspace)
    }
  }

  /**
   * `+` on the strip: a new conversation in a pane to the right of the focused
   * one, with the row then divided evenly by the current pane count. With no
   * pane open this opens the first pane instead (the empty-state path).
   */
  async function newPane() {
    if (isDisposed() || !isRegistered()) return false
    if (!isActive()) return false
    const paneId = book.activeLayout().activePaneId
    if (paneId === null) return newInFocused()
    return split(paneId, 'row')
  }

  /** Ctrl+Enter in `/resume`: the chosen conversation in a new pane. */
  async function openInNewPane(sessionId) {
    if (isDisposed() || !isRegistered()) return false
    if (typeof sessionId !== 'string' || sessionId === '') return false
    // The strip and the command path only act while split mode is active;
    // outside it there is no visible pane to split beside.
    if (!isActive()) return false
    const targetWorkspace = workspaceOf(sessionId) ?? focusedWorkspaceId()
    if (typeof targetWorkspace === 'string' && targetWorkspace !== '') {
      // Load the target tree before deciding. An unloaded layout reads as empty,
      // which would both miss an already-mounted session and skip the cap.
      if (!ensureWorkspace(targetWorkspace)) return false
    }

    const holder = book.locatePaneIn(sessionId)
    if (holder !== null) {
      const here = book.getActiveWorkspaceId()
      const focused = book.activeLayout().activePaneId
      if (holder.workspaceId !== here || holder.paneId !== focused) {
        focusPane(holder.paneId)
      }
      return false
    }

    if (typeof targetWorkspace === 'string' && targetWorkspace !== '') {
      const target = book.layoutOf(targetWorkspace)
      // The first pane of an empty workspace is not a split and is not capped.
      // A full workspace is refused here, before any switch: the visible
      // workspace stays put and no session is created.
      if (target.root !== null && paneBudgetSpent(targetWorkspace)) return refuseSplitBudget()
      if (targetWorkspace !== book.getActiveWorkspaceId() && !switchWorkspace(targetWorkspace)) {
        return false
      }
    }
    const paneId = book.activeLayout().activePaneId
    if (paneId === null) return openSessionPane(book.activeLayout(), sessionId)
    return split(paneId, 'row', { sessionId })
  }

  /**
   * Change the pane cap shared by every workspace and persist it.
   *
   * Invalid input falls back to the default (4); 0 means unlimited. Changing the
   * value never touches a live layout, so a workspace that already holds more
   * panes than the new cap simply cannot grow until panes are closed.
   *
   * @param {unknown} value non-negative integer, or 0 for unlimited
   * @returns {number} the normalised value now in effect
   */
  function setMaxPanes(value) {
    const next = normalizeMaxPanes(value)
    maxPanes = next
    const written = writeMaxPanes(storage, next)
    maxPanesError = written.ok ? null : (written.message ?? '')
    emit({})
    return maxPanes
  }

  /**
   * Why the workspace's split control is blocked, or undefined when it is
   * available. Mirrors the sidebar's `splitBlock()`: only the pane budget is
   * checked here (this plugin has no width-measuring rule).
   *
   * @param {string|null} [workspaceId] defaults to the visible workspace
   * @returns {'budget'|undefined}
   */
  function splitBlock(workspaceId) {
    if (isDisposed()) return undefined
    const target = workspaceId ?? book.getActiveWorkspaceId()
    return paneBudgetSpent(target) ? 'budget' : undefined
  }

  return {
    /** The two snapshot fields this holder owns. Merged into every publish. */
    snapshotPatch() {
      return { maxPanes, maxPanesError }
    },
    split,
    newPane,
    openInNewPane,
    newInFocused,
    setMaxPanes,
    splitBlock,
  }
}

module.exports = {
  DEFAULT_MAX_PANES,
  PANE_SETTINGS_KEY,
  PANE_SETTINGS_VERSION,
  parseNonNegativeInteger,
  normalizeMaxPanes,
  readMaxPanes,
  writeMaxPanes,
  paneCount,
  isPaneBudgetSpent,
  paneBudgetBlocked,
  createSplitBudget,
}
