'use strict'

/**
 * dsh-hk-craft — client (browser) half.
 *
 * Loaded by the dsh Web shell through `dsh.client` in package.json; built into
 * `lib/client.js` by `scripts/build-client.mjs`. The id passed to the shell
 * loader must equal the bundle patch row name (`dsh-hk-craft`).
 *
 * Everything here goes through public plugin services only: `slots`, `locale`,
 * `sessions`, `layout`, `uiWorkspace` and `workspaces` for the sidebar workspace
 * section and the settings page, and `commandUi`, `sessions`, `workspaces` and
 * `uiWorkspace` for the slash commands. Optional capabilities attach through
 * `ctx.inject`, except the agent-preset roster behind the read-only mode badge,
 * which is read through `ctx.get('remote')` at call time, so the
 * plugin keeps working even when a service is absent.
 *
 * The pane feature is split into a pure adapter/controller (`dsh-pane-host.js`)
 * and thin React views (`pane-view.js`); the HK Craft settings page
 * (`settings-view.js`) is the transitional home of the diagnostics, the pane
 * limit (`pane-budget.js`) and the split-view switch. Each pane header carries
 * two native controls: the read-only
 * mode badge (`pane-mode.js` projection, `pane-mode-seat.js` view) and the
 * subagent viewer (`pane-subagents.js` projection, `pane-subagents-view.js` view).
 */

const { dictionaries } = require('./locale.js')
const { WorkspaceSection } = require('./sidebar-workspaces.js')
const { createSectionActions } = require('./dsh-workspaces.js')
const {
  CONVERSATION_KEY,
  MAIN_PANEL_PRIORITY,
  PANE_SLOT,
  MAIN_SLOT,
  createPaneController,
} = require('./dsh-pane-host.js')
const { createViewSwitch } = require('./dsh-view-switch.js')
const { createPaneBody, createPaneHost } = require('./pane-view.js')
const { createSubagentSeat } = require('./pane-subagents-view.js')
const { createSettingsSection } = require('./settings-view.js')
const { modeRosterRows } = require('./pane-mode.js')
const { createModeSeat } = require('./pane-mode-seat.js')
const { registerCommands } = require('./commands.js')
const { createNotifier } = require('./notifications.js')
const { installPowerShellDefault } = require('./terminal-shell.js')

const NS = 'dsh-hk-craft'

/** The settings slot declared by ui-settings-general (a root list slot). */
const SETTINGS_SLOT = 'settings.section'
/** This plugin's fixed settings-nav id. */
const SETTINGS_SECTION_ID = 'dsh-hk-craft'
/**
 * After every official top-level section (account -10, general 0, models 10,
 * plugins 15, agent presets 20), so the page sits at the end of the nav.
 */
const SETTINGS_SECTION_ORDER = 100

/**
 * The priority that shadows dsh's own `sidebar.workspaces` occupant.
 *
 * `sidebar.workspaces` is a `single` slot; the slot core orders its entries by
 * `priority ?? 0` ascending and renders the first ("lowest renders"). The shipped
 * occupant (ui-workspace) registers without a priority, i.e. 0, so any negative
 * value replaces it for every entry that is not a same-priority duplicate.
 */
const WORKSPACE_SLOT_PRIORITY = -100

/** Cordis services this plugin needs before `apply` runs. */
const inject = ['slots', 'locale', 'sessions', 'layout']

/** Services the slash commands need before they can register. */
const COMMAND_SERVICES = ['commandUi', 'sessions', 'workspaces', 'uiWorkspace']

/**
 * The optional agent-preset roster adapter behind the read-only mode badge.
 *
 * `remote.agentPresets.list()` is an optional capability, so it is read through
 * `ctx.get('remote')` at call time instead of joining `inject`: an older or
 * trimmed shell simply has no roster and the badge falls back to the localized
 * shipped name or the raw id. A failed read, an absent service and a malformed
 * result all degrade to "no roster rows".
 *
 * The result is cached per preset id for the process. The seat calls the loader
 * on mount and again when the focused pane's preset id changes; the cache keeps
 * ordinary focus switches from re-requesting the same roster, while a failed
 * read is not cached so the next focus change can retry.
 *
 * @param {any} ctx Cordis context of the client plugin row
 * @returns {(presetId: string) => Promise<{id: string, name?: string, description?: string}[]>}
 */
function createModeRosterLoader(ctx) {
  /** @type {Map<string, {id: string, name?: string, description?: string}[]>} */
  const cache = new Map()

  return async function loadModeRoster(presetId) {
    const key = typeof presetId === 'string' ? presetId : ''
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    try {
      const result = await ctx.get('remote')?.agentPresets?.list?.()
      const rows = modeRosterRows(result)
      if (result?.ok === true) cache.set(key, rows)
      return rows
    } catch (_error) {
      return []
    }
  }
}

/**
 * The subagent seat's on-open projection refresh.
 *
 * `refreshProjections(parentSessionId)` is a public `sessions` method (see
 * `doc/upstream-contracts.md#subagent-catalog-direct-children`), but reading it
 * through `ctx.get` keeps the seat a pure consumer: a shell that ever ships
 * without the service leaves the refresh a no-op instead of failing to mount.
 *
 * @param {any} ctx Cordis context of the client plugin row.
 * @returns {(sessionId: string) => unknown}
 */
function catalogRefresher(ctx) {
  return (sessionId) => {
    if (typeof ctx?.get !== 'function') return undefined
    return ctx.get('sessions')?.refreshProjections?.(sessionId)
  }
}

/**
 * The two native controls every pane header can show: the read-only mode badge
 * and the subagent viewer. Both are optional components; a null result from
 * either leaves no box in the header.
 *
 * @param {any} ctx Cordis context of the client plugin row
 * @returns {{mode: Function, subagents: Function}} component types by seat name
 */
function createHeaderSeats(ctx) {
  return {
    mode: createModeSeat({ loadRoster: createModeRosterLoader(ctx) }),
    subagents: createSubagentSeat({ refreshCatalog: catalogRefresher(ctx) }),
  }
}

/**
 * @param {any} ctx Cordis context of the client plugin row.
 */
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dsh-hk-craft: dictionaries')
  const t = ctx.locale.bind(NS)

  // The View adapter is optional: without `uiConversation` (or the
  // developer-tools gate) the panes stay chat-only instead of failing to mount.
  const controller = createPaneController(ctx, { viewSwitch: createViewSwitch(ctx) })

  // Desktop notifications are a client capability: dsh exposes no notification
  // service, so the renderer's own Notification API maps to a Windows toast.
  // The notifier seeds itself from the current status store, so installing or
  // reloading never replays old approvals/completions as a toast storm.
  const notifier = createNotifier({
    ctx,
    controller,
    t,
    NotificationImpl: typeof globalThis.Notification === 'function' ? globalThis.Notification : undefined,
    documentRef: globalThis.document,
    windowRef: globalThis.window,
  })
  ctx.effect(() => () => notifier.dispose(), 'dsh-hk-craft: notification teardown')

  // `uiSession` owns the per-session running/pending/unread projection; wait for
  // it so a shell without the package keeps the rest of the plugin working.
  ctx.inject(['uiSession'], (scope) => {
    scope.effect(() => notifier.start(), 'dsh-hk-craft: desktop notifications')
  })

  // Optional. A shell without a right bar must still mount the panes, so this
  // is not part of the top-level inject list.
  ctx.inject(['sidebarRight'], (scope) => {
    controller.panel.attach(scope.get('sidebarRight'))
    return () => controller.panel.attach(null)
  })

  // The native tool icons (files, browser, terminal, …). Optional, and kept
  // off the top-level inject list for the same reason as sidebarRight.
  ctx.inject(['sidebarRightTabs'], (scope) => {
    controller.panel.attachTabs(scope.get('sidebarRightTabs'))
    return () => controller.panel.attachTabs(null)
  })

  // dsh remembers the last right-bar shell. Until the user picks one, that
  // memory is cmd on Windows. Prefer PowerShell 7, then Windows PowerShell,
  // once, then leave the menu alone.
  ctx.inject(['webTerminals', 'sessions'], (scope) => {
    const storage = globalThis.localStorage
    if (storage == null || typeof storage.getItem !== 'function') return () => {}
    return installPowerShellDefault({
      webTerminals: scope.get('webTerminals'),
      sessions: scope.get('sessions'),
      storage,
    })
  })

  // Native open/start moves `uiSession` current without unmounting the shadow.
  // Follow that current onto the focused pane. Separate from the notifier so
  // a status-only shell still routes, and a missing service mounts nothing here.
  ctx.inject(['uiSession'], (scope) => {
    scope.effect(
      () => controller.attachSessionSelection(scope.get('uiSession')?.adapter?.current),
      'dsh-hk-craft: session current routing',
    )
  })

  const headerSeats = createHeaderSeats(ctx)
  const PaneHost = createPaneHost(controller, { headerSeats })
  const PaneBody = createPaneBody(controller)

  // The HK Craft settings page: diagnostics and the pane limit.
  // `settings.section` is a root list slot declared by ui-settings-general;
  // `slots.inject` only runs this callback once that slot exists, so a shell
  // without a settings panel simply never shows the page.
  const SettingsSection = createSettingsSection(controller, { notifications: notifier })
  ctx.slots.inject(SETTINGS_SLOT, () =>
    ctx.slots.register(
      {
        name: SETTINGS_SLOT,
        id: SETTINGS_SECTION_ID,
        order: SETTINGS_SECTION_ORDER,
        label: () => t('settings.nav'),
        locale: NS,
      },
      SettingsSection,
    ),
  )

  /**
   * The pane face the slash commands see: enough to keep `/resume`, `/clear`
   * and `/new` inside the split workspace instead of calling the native session
   * navigation, which would move the shell's current session. `openInNewPane` is the `/resume`
   * Ctrl+Enter action and the `/fork` "open the copy beside the focus" action.
   * `canTrace` / `setView` are the `/trace` pass-through to the controller.
   * `paneIndexFor` feeds the "已在窗格 N" badge. The pane strip itself talks to
   * the controller directly.
   */
  const paneCommands = {
    active: () => controller.getSnapshot().active,
    focused: () => controller.focusedPane(),
    replaceFocused: (sessionId) => controller.replaceFocusedSession(sessionId),
    openInNewPane: (sessionId) => controller.openInNewPane(sessionId),
    newConversation: (workspaceId) => controller.newInFocused(workspaceId),
    paneIndexFor: (sessionId) => controller.paneIndexOf(sessionId),
    canTrace: () => controller.isTrajectoryAvailable(),
    setView: (paneId, view) => controller.setView(paneId, view),
  }

  ctx.effect(() => {
    // The `main` keyed root slot is declared by ui-layout. Shadow the
    // `conversation` cell (priority -1) and then the child slot that entry
    // declares. Never select a panel: `activePanelId` must stay null so the
    // native right bar keeps its gate open.
    const disposeMain = ctx.slots.inject(MAIN_SLOT, function* () {
      yield ctx.slots.register(
        {
          name: MAIN_SLOT,
          key: CONVERSATION_KEY,
          priority: MAIN_PANEL_PRIORITY,
          locale: NS,
          children: {
            [PANE_SLOT]: { kind: 'single', scope: 'session' },
          },
        },
        PaneHost,
      )
      yield ctx.slots.register({ name: PANE_SLOT, locale: NS }, PaneBody)
      controller.markRegistered()
      // Split mode starts as soon as the shadow is registered. There is no
      // control that returns to the native conversation cell.
      controller.activate()
    })

    return () => {
      disposeMain()
      controller.dispose()
    }
  }, 'dsh-hk-craft: pane mount')

  // The workspace section replaces a slot declared by ui-workspace and drives its
  // public service, so both services must exist before the entry is registered.
  // In split mode the click switches the visible workspace tree instead of
  // letting a native reveal move the current session. Outside that mode the
  // same click reveals the workspace's existing conversation. The same face
  // answers "was this workspace ever opened in split" and lets the row light
  // follow the controller snapshot, and it lets a deleted workspace
  // drop its local layout after the public delete.
  const workspacePanes = {
    active: () => controller.getSnapshot().active,
    switchWorkspace: (workspaceId) => controller.switchWorkspace(workspaceId),
    forgetWorkspace: (workspaceId, options) => controller.forgetWorkspace(workspaceId, options),
    isWorkspaceEnabled: (workspaceId) => controller.isWorkspaceEnabled(workspaceId),
    getSnapshot: () => controller.getSnapshot(),
    subscribe: (listener) => controller.subscribe(listener),
  }
  ctx.inject(['uiWorkspace', 'workspaces'], (scoped) => {
    const actions = createSectionActions(scoped, { panes: workspacePanes })
    scoped.slots.inject('sidebar.workspaces', () =>
      scoped.slots.register(
        {
          name: 'sidebar.workspaces',
          id: 'dsh-hk-craft.workspaces',
          priority: WORKSPACE_SLOT_PRIORITY,
          locale: NS,
          inject: () => ({
            openWorkspace: actions.openWorkspace,
            addWorkspace: actions.addWorkspace,
            deleteWorkspace: actions.deleteWorkspace,
            panes: workspacePanes,
            reorderWorkspace: actions.reorderWorkspace,
          }),
        },
        WorkspaceSection,
      ),
    )
  })

  ctx.inject(COMMAND_SERVICES, (scope) => {
    scope.effect(() => {
      const disposers = registerCommands({
        commandUi: scope.get('commandUi'),
        sessions: scope.get('sessions'),
        workspaces: scope.get('workspaces'),
        uiWorkspace: scope.get('uiWorkspace'),
        panes: paneCommands,
        t,
      })
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-hk-craft: slash commands')
  })
}

module.exports = {
  NS,
  inject,
  COMMAND_SERVICES,
  apply,
  WORKSPACE_SLOT_PRIORITY,
  createModeRosterLoader,
  createHeaderSeats,
  SETTINGS_SLOT,
  SETTINGS_SECTION_ID,
  SETTINGS_SECTION_ORDER,
  catalogRefresher,
}
