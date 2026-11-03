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

/**
 * @param {{ publish?: (patch?: object) => void }} [deps]
 *   `publish` is the kernel's `emit`. This module holds no snapshot of its own:
 *   it reports the fields it owns and the kernel freezes them with everything
 *   else, so one publish still reaches every consumer at once.
 */
function createRightbar({ publish } = {}) {
  /** `ctx.sidebarRight` when the shell has one. Optional; the strip hides without it. */
  let service = null
  /** `ctx.sidebarRightTabs`, the registry whose guide entries are the native tool icons. */
  let tabs = null
  let unsubscribeTabs = () => {}
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
     * Open one native right-bar tool. `openTab` expands the bar and focuses that
     * page, which is what its guide icon does.
     */
    openTool(kind) {
      if (service === null || typeof kind !== 'string' || kind === '') return false
      if (typeof service.openTab !== 'function') return false
      try {
        const result = service.openTab(kind)
        if (result != null && typeof result.then === 'function') {
          result.catch((error) => announceError(error))
        }
      } catch (error) {
        announceError(error)
        return false
      }
      announce({})
      return true
    },

    /** Plugin unload: drop the registry subscription and both service handles. */
    dispose() {
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