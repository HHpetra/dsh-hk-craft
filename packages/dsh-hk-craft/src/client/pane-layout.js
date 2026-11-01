'use strict'

/**
 * The layout operations and the conversation View, as two faces over the
 * kernel's one transaction (ADR-0017).
 *
 * `dsh-pane-host.js` owns the layout book, the retained pane references and the
 * single `apply()` transaction. This module owns the *operations* a pane strip
 * and a pane header ask for — focus, split positions, the drop swap, a divider
 * drag, a `/resume` replacement — and the View switch that drives dsh's own
 * `uiConversation` binding.
 *
 * It holds no state of its own except the developer-tools subscription, which is
 * why it is a face and not a fourth holder: two faces over the same transaction,
 * `layout` for the tree and `view` for the remembered chat/trajectory choice.
 * Splitting them into two faces keeps each consumer surface under the eight
 * members the design budget allows, while the state stays where it is.
 *
 * Every mutation goes through `deps.apply`, so the reconcile that acquires and
 * releases retained references still happens in exactly one place.
 */

const { messageOf } = require('./shared.js')

/**
 * @param {object} deps
 * @param {any} deps.book the layout book (per-workspace trees)
 * @param {any} deps.layoutTree the pure tree transitions (`layout-tree.js`)
 * @param {(next: object, workspaceId?: string|null) => boolean} deps.apply the kernel transaction
 * @param {(patch: object) => void} deps.emit kernel state emitter
 * @param {() => boolean} deps.isDisposed
 * @param {() => boolean} deps.isRegistered whether the shadow slot is mounted
 * @param {(workspaceId: string) => boolean} deps.switchWorkspace
 * @param {(paneId: string) => any} deps.paneReference the retained reference of a mounted pane
 * @param {any} deps.viewSwitch the `uiConversation` adapter, or undefined
 * @param {(sessionId: string) => string|undefined} deps.focusedWorkspaceId the
 *   visible workspace, else the one the focused pane's session belongs to, else
 *   the first workspace the host lists
 * @param {(layout: object, index: number) => string|null} deps.paneIdForStripIndex
 * @param {(layout: object) => Array<{sessionId: string, index: number}>} deps.openConversationItems
 */
function createPaneLayout(deps) {
  const {
    book,
    layoutTree,
    apply,
    emit,
    isDisposed,
    isRegistered,
    switchWorkspace,
    paneReference,
    focusedWorkspaceId,
    viewSwitch,
    paneIdForStripIndex,
    openConversationItems,
  } = deps

  /** Focus a pane; false when it is absent or already focused. */
  function focusPane(paneId) {
    if (isDisposed()) return false
    const located = book.locatePane(paneId)
    if (located === null) return false
    if (located.workspaceId !== book.getActiveWorkspaceId()) {
      if (!switchWorkspace(located.workspaceId)) return false
    }
    return apply(layoutTree.focus(book.layoutOf(located.workspaceId), paneId), located.workspaceId)
  }

  /** Replace the focused pane's session, focusing an existing holder instead. */
  function replaceFocusedSession(sessionId) {
    if (isDisposed() || !isRegistered()) return false
    const value = book.activeLayout()
    const paneId = value.activePaneId
    if (paneId === null) return false
    const holder = book.locatePaneIn(sessionId)
    if (holder !== null) {
      return holder.paneId === paneId && holder.workspaceId === book.getActiveWorkspaceId()
        ? true
        : focusPane(holder.paneId)
    }
    const next = layoutTree.replaceSession(value, paneId, sessionId)
    if (next === value) return true
    return apply(next)
  }

  /** Ctrl+1..4: focus the open conversation at that strip position. */
  function focusPaneAt(index) {
    if (isDisposed()) return false
    const paneId = paneIdForStripIndex(book.activeLayout(), index)
    return paneId === null ? false : focusPane(paneId)
  }

  /**
   * The 1-based strip position of a conversation already open in the visible
   * workspace's panes, or null. `/resume` uses it for the "已在窗格 N" badge
   * (spec D10); selecting such a row focuses that pane instead of remounting.
   */
  function paneIndexOf(sessionId) {
    if (isDisposed() || typeof sessionId !== 'string' || sessionId === '') return null
    const item = openConversationItems(book.activeLayout()).find(
      (entry) => entry.sessionId === sessionId,
    )
    return item === undefined ? null : item.index
  }

  /**
   * Exchange two panes' sessions and remembered views while keeping the tree
   * shape, the ratios and the focus (spec §4.2).
   *
   * The two panes must live in the same workspace tree — a drag can never leave
   * one strip (spec D3). The reconcile acquires both new pane retentions before
   * releasing the old ones, so neither conversation's client generation is torn
   * down by the swap.
   */
  function swapPanes(a, b) {
    if (isDisposed()) return false
    if (typeof a !== 'string' || typeof b !== 'string' || a === b) return false
    const first = book.locatePane(a)
    const second = book.locatePane(b)
    if (first === null || second === null) return false
    if (first.workspaceId !== second.workspaceId) return false
    const current = book.layoutOf(first.workspaceId)
    const next = layoutTree.swap(current, a, b)
    if (next === current) return false
    return apply(next, first.workspaceId)
  }

  /** Drag a separator: `path` addresses the split (a/b steps from the root). */
  function resize(path, ratio) {
    if (isDisposed()) return false
    return apply(layoutTree.resize(book.activeLayout(), path, ratio))
  }

  /** Whether the trajectory View is offered (developer-tools gate). */
  function isTrajectoryAvailable() {
    return typeof viewSwitch?.isTrajectoryAvailable === 'function'
      ? viewSwitch.isTrajectoryAvailable() === true
      : false
  }

  /**
   * Follow the developer-tools gate so the View (and a remembered trajectory
   * choice) react when the setting flips. No-op without an adapter.
   */
  function subscribeViewAvailability(listener) {
    return typeof viewSwitch?.subscribeAvailability === 'function'
      ? viewSwitch.subscribeAvailability(listener)
      : () => {}
  }

  /**
   * Drive the real conversation View through the public binding. This is the
   * same call dsh's own View switcher makes, so the session is not rebuilt and
   * the draft / scroll state are dsh's own.
   *
   * @returns {{ok: boolean, error?: string}}
   */
  function activateView(pane, view) {
    if (typeof viewSwitch?.activate !== 'function') {
      return { ok: false, error: 'view switching is unavailable in this shell' }
    }
    try {
      return (
        viewSwitch.activate(pane.sessionId, view) ?? { ok: false, error: 'view switch returned no result' }
      )
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /** Switch one pane's conversation view; the remembered choice lives on that pane. */
  function setView(paneId, view) {
    if (isDisposed()) return false
    const located = book.locatePane(paneId)
    if (located === null) return false
    const pane = located.pane
    if (view !== 'chat' && view !== 'trajectory') return false
    if (pane.view === view) return true
    if (view === 'trajectory' && !isTrajectoryAvailable()) return false
    if (viewSwitch !== undefined) {
      const result = activateView(pane, view)
      if (result?.ok !== true) {
        emit({ error: result?.error ?? 'could not switch the conversation view' })
        return false
      }
    }
    return apply(layoutTree.setView(book.layoutOf(located.workspaceId), paneId, view), located.workspaceId)
  }

  /**
   * Re-assert the view a pane remembered, once its conversation binding is
   * available. Called from the pane body after mount; dsh restores the
   * per-session preference on its own, but the pane's memory must win.
   */
  function restoreViewFor(sessionId) {
    if (isDisposed()) return false
    const holder = book.locatePaneIn(sessionId)
    if (holder === null) return false
    const pane = book.layoutOf(holder.workspaceId).panes[holder.paneId]
    if (pane === undefined) return false
    if (pane.view === 'trajectory' && !isTrajectoryAvailable()) return false
    return activateView(pane, pane.view).ok === true
  }

  // Developer tools gate the trajectory View. Turning them back on re-asserts the
  // trajectory choice each pane remembered; turning them off is left to dsh,
  // whose own refreshViews restores every tracked binding (usually chat).
  const unsubscribeAvailability = subscribeViewAvailability(() => {
    if (isDisposed()) return
    if (!isTrajectoryAvailable()) return
    for (const layoutValue of Object.values(book.layoutsMap())) {
      for (const pane of Object.values(layoutValue.panes)) {
        if (pane.view === 'trajectory') activateView(pane, pane.view)
      }
    }
  })

  return {
    /** The tree operations: only these touch the layout. */
    layout: {
      paneReference,
      focusedPane() {
        const value = book.activeLayout()
        const paneId = value.activePaneId
        return paneId === null ? null : (value.panes[paneId] ?? null)
      },
      focusPane,
      focusPaneAt,
      paneIndexOf,
      swapPanes,
      replaceFocusedSession,
      resize,
      focusedWorkspaceId,
    },
    /** The chat/trajectory switch and the gate behind it. */
    view: {
      setView,
      restoreViewFor,
      isTrajectoryAvailable,
      subscribeViewAvailability,
    },
    /** Plugin unload: drop the developer-tools subscription. */
    dispose() {
      unsubscribeAvailability()
    },
  }
}

module.exports = { createPaneLayout }