'use strict'

/**
 * The native right bar, as its own owner.
 *
 * `dsh-pane-host.js` keeps the pane layout; this module owns the right-bar
 * service pair (`ctx.sidebarRight`, `ctx.sidebarRightTabs`) and the three
 * snapshot fields they produce. It is the first holder extracted under
 * ADR-0017, so the kernel no longer reads `rightbar*` while emitting: it merges
 * this module's `snapshotPatch()` into every published snapshot instead.
 *
 * Upstream shape (see `docs/upstream-contracts.md`):
 * - `sidebarRight` needs `toggleExpanded()` and `isExpanded()`;
 * - `sidebarRightTabs` needs `guide()` and `subscribe()`;
 * - `sidebarRight.openTab(kind)` both expands the bar and focuses that page.
 *
 * The service pair has no expanded subscription, so `snapshotPatch()` re-reads
 * `isExpanded()` on every publish, exactly as the kernel used to.
 */

const { messageOf } = require('./shared.js')

/**
 * One guide entry per native tool, in the registry's order. `title` is already
 * localized by the tool's own package.
 *
 * @param {any} tabs the `sidebarRightTabs` face, or null
 * @returns {Array<{kind: string, entryId: string, providerId: string, title: string, icon: Function|null}>}
 */
function readToolEntries(tabs) {
  if (tabs == null || typeof tabs.guide !== 'function') return []
  let entries
  try {
    entries = tabs.guide()
  } catch {
    return []
  }
  if (!Array.isArray(entries)) return []
  const tools = []
  for (const entry of entries) {
    if (entry == null || typeof entry.kind !== 'string' || entry.kind === '') continue
    let title = entry.kind
    try {
      const named = typeof entry.title === 'function' ? entry.title() : entry.kind
      if (typeof named === 'string' && named !== '') title = named
    } catch {
      title = entry.kind
    }
    tools.push({
      kind: entry.kind,
      entryId: typeof entry.id === 'string' && entry.id !== '' ? entry.id : entry.kind,
      providerId: typeof entry.providerId === 'string' ? entry.providerId : '',
      title,
      icon: typeof entry.icon === 'function' ? entry.icon : null,
    })
  }
  return tools
}

/** How long the per-Session open waits for the bar to reach that Session. */
const OPEN_RETRY_MS = 50
/** Bounded waits: a shell that never adopts the Session falls back, it does not hang. */
const OPEN_RETRY_ATTEMPTS = 60

/**
 * @param {{
 *   publish?: (patch?: object) => void,
 *   reveal?: () => unknown,
 *   retryDelayMs?: number,
 *   retryAttempts?: number,
 * }} [deps]
 *   `publish` is the kernel's `emit`. This module holds no snapshot of its own:
 *   it reports the fields it owns and the kernel freezes them with everything
 *   else, so one publish still reaches every consumer at once. `reveal` points
 *   the shell at the focused pane; the per-Session open retries call it while
 *   the native bar has not adopted that Session yet. `retryDelayMs` and
 *   `retryAttempts` are test seams for the same wait.
 */
function createRightbar({
  publish,
  reveal,
  retryDelayMs = OPEN_RETRY_MS,
  retryAttempts = OPEN_RETRY_ATTEMPTS,
} = {}) {
  /** `ctx.sidebarRight` when the shell has one. Optional; the strip hides without it. */
  let service = null
  /** `ctx.sidebarRightTabs`, the registry whose guide entries are the native tool icons. */
  let tabs = null
  let unsubscribeTabs = () => {}
  /** Kernel-provided navigation, used to bring the bar onto the focused Session. */
  let revealFace = typeof reveal === 'function' ? reveal : null
  /** Pending wait for the bar to adopt the Session a tool was opened for. */
  let openRetry = null
  /**
   * Frozen and reference-stable: `snapshotPatch()` hands out the same array
   * while the registry has not changed, which is what keeps the kernel's
   * identity-based change detection from re-rendering on every publish.
   *
   * @type {ReadonlyArray<{kind: string, entryId: string, providerId: string, title: string, icon: Function|null}>}
   */
  let tools = Object.freeze([])

  function readExpanded() {
    try {
      return service?.isExpanded?.() === true
    } catch {
      return false
    }
  }

  function refreshTools() {
    tools = Object.freeze(readToolEntries(tabs))
  }

  function announce(patch) {
    if (typeof publish === 'function') publish(patch ?? {})
  }

  function announceError(error) {
    if (typeof publish === 'function') publish({ error: messageOf(error) })
  }

  function clearOpenRetry() {
    if (openRetry === null) return
    try {
      clearTimeout(openRetry)
    } catch (_error) {
      // A disposed panel may already have torn the timer registry down.
    }
    openRetry = null
  }

  /**
   * Whether the native bar has actually adopted `sessionId`.
   *
   * `mounted` alone is not enough: the bar names the on-screen Session as soon
   * as the shell current moves, one render before the Session's layout store is
   * minted. `screen()` is the only observable that requires that store, and
   * `openTabIn` silently no-ops without it. A shell that exposes neither keeps
   * the old immediate attempt.
   *
   * @param {string} sessionId
   * @returns {boolean}
   */
  function surfaceOn(sessionId) {
    try {
      if (typeof service?.screen === 'function') {
        const screen = service.screen()
        return screen !== undefined && screen.sessionId === sessionId
      }
      const mounted = service?.mounted
      if (mounted != null && typeof mounted.getSnapshot === 'function') {
        return mounted.getSnapshot() === sessionId
      }
    } catch (_error) {
      return false
    }
    return true
  }

  function expand() {
    if (readExpanded() || typeof service?.toggleExpanded !== 'function') return
    try {
      service.toggleExpanded()
    } catch (error) {
      announceError(error)
    }
  }

  /** Open one page in an adopted Session; false when the shell refused it. */
  function placeInSession(sessionId, kind) {
    try {
      const result = service.openTabIn(sessionId, kind)
      if (result != null && typeof result.then === 'function') {
        result.catch((error) => announceError(error))
      }
    } catch (error) {
      announceError(error)
      return false
    }
    expand()
    announce({})
    return true
  }

  /** Last resort: open on whatever Session the bar does show, so the click still works. */
  function placeOnMounted(kind) {
    if (typeof service?.openTab !== 'function') return false
    try {
      const result = service.openTab(kind)
      if (result != null && typeof result.then === 'function') {
        result.catch((error) => announceError(error))
      }
    } catch (error) {
      announceError(error)
      return false
    }
    expand()
    announce({})
    return true
  }

  return {
    /**
     * The three snapshot fields this module owns. The kernel merges this into
     * every publish, after the caller's patch, so a caller can never claim a
     * right-bar state the service does not report.
     */
    snapshotPatch() {
      return {
        rightbarAvailable: service !== null,
        rightbarExpanded: readExpanded(),
        rightbarTools: tools,
      }
    },

    /** Remember `ctx.sidebarRight`. A missing service hides the strip button. */
    attach(next) {
      service = next ?? null
      announce({})
    },

    /**
     * Remember `ctx.sidebarRightTabs`. A registry that cannot be read leaves
     * the expand icon as the only right-bar control.
     */
    attachTabs(next) {
      unsubscribeTabs()
      unsubscribeTabs = () => {}
      tabs = next ?? null
      if (tabs != null && typeof tabs.subscribe === 'function') {
        try {
          const unsubscribe = tabs.subscribe(() => {
            refreshTools()
            announce({})
          })
          if (typeof unsubscribe === 'function') unsubscribeTabs = unsubscribe
        } catch (error) {
          announceError(error)
        }
      }
      refreshTools()
      announce({})
    },

    /** Flip the native right bar. False when the service is missing or the call throws. */
    toggle() {
      if (service === null) return false
      try {
        service.toggleExpanded()
      } catch (error) {
        announceError(error)
        return false
      }
      announce({})
      return true
    },

    /**
     * Open one native right-bar tool for the focused pane's Session.
     *
     * The bar's mounted Session can still name the workspace the user just left
     * while the pane tree already shows the new one (the shell current moves
     * asynchronously). Calling bare `openTab(kind)` would then create the page
     * in that stale Session: the terminal would start in the previous
     * workspace's directory. When the caller supplies the focused Session, use
     * the per-Session open (`openTabIn`) so the page is placed on the workspace
     * actually on screen.
     *
     * `openTabIn` is a silent no-op until the bar has adopted that Session: the
     * shell names the new current immediately, but the Session's layout store
     * is minted one render later. So the open waits for adoption, asking the
     * kernel to reveal the focused pane again on every wait; only then does it
     * expand the bar, which is why a click never flashes the previous
     * workspace's page. A shell that never adopts the Session (no navigation
     * face) falls back to the mounted open instead of doing nothing.
     *
     * @param {string} kind - native tab kind (files, terminal, …)
     * @param {string} [sessionId] - focused pane's Session, when known
     * @returns {boolean} whether a service call was attempted
     */
    openTool(kind, sessionId) {
      if (service === null || typeof kind !== 'string' || kind === '') return false
      const target = typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
      const perSession = target !== undefined && typeof service.openTabIn === 'function'
      if (!perSession && typeof service.openTab !== 'function') return false
      if (!perSession) return placeOnMounted(kind)
      clearOpenRetry()
      let attempts = 0
      const attempt = () => {
        openRetry = null
        if (service === null) return
        if (surfaceOn(target)) {
          placeInSession(target, kind)
          return
        }
        if (attempts >= retryAttempts) {
          placeOnMounted(kind)
          return
        }
        attempts += 1
        if (typeof revealFace === 'function') {
          try {
            revealFace()
          } catch (error) {
            announceError(error)
          }
        }
        openRetry = setTimeout(attempt, retryDelayMs)
        if (typeof openRetry?.unref === 'function') openRetry.unref()
      }
      attempt()
      return true
    },

    /**
     * Remember the kernel's reveal call, or clear it with a null. The wait in
     * `openTool` uses it to retry moving the shell current; a panel without it
     * still opens on an adopted Session.
     *
     * @param {(() => unknown)|null} next
     * @returns {() => void} detaches this exact callback
     */
    attachReveal(next) {
      revealFace = typeof next === 'function' ? next : null
      return () => {
        if (revealFace === next) revealFace = null
      }
    },

    /** Plugin unload: drop the registry subscription, both service handles and pending work. */
    dispose() {
      clearOpenRetry()
      revealFace = null
      unsubscribeTabs()
      unsubscribeTabs = () => {}
      tabs = null
      tools = Object.freeze([])
      service = null
    },
  }
}

module.exports = {
  createRightbar,
  readToolEntries,
}