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
 * which is read through `ctx.get('remote')` at call time (ticket 07), so the
 * plugin keeps working even when a service is absent.
 *
 * The pane feature is split into a pure adapter/controller (`dsh-pane-host.js`)
 * and thin React views (`pane-view.js`); the HK Craft settings page
 * (`settings-view.js`) is the transitional home of the diagnostics and the
 * split-view switch (ticket 05).
 */

const { dictionaries } = require('./locale.js')
const { WorkspaceSection } = require('./sidebar-workspaces.js')
const { createSectionActions } = require('./dsh-workspaces.js')
const { PANEL_KEY, PANE_SLOT, MAIN_SLOT, createPaneController } = require('./dsh-pane-host.js')
const { createViewSwitch } = require('./dsh-view-switch.js')
const { createPaneBody, createPaneHost } = require('./pane-view.js')
const { createSettingsSection } = require('./settings-view.js')
const { modeRosterRows } = require('./pane-mode.js')
const { createModeSeat } = require('./pane-mode-seat.js')
const { registerCommands } = require('./commands.js')

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

/** Services the two slash commands need before they can register. */
const COMMAND_SERVICES = ['commandUi', 'sessions', 'workspaces', 'uiWorkspace']

/**
 * The optional agent-preset roster adapter behind the read-only mode badge
 * (ticket 07, spec §6).
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
 * The strip's pinned native-action seats (ticket 06, `pane-toolbar.js`).
 * Ticket 07 fills the read-only mode seat here; ticket 08 fills `subagents` the
 * same way, so neither module has to reach into the strip or the action group.
 *
 * @param {any} ctx Cordis context of the client plugin row
 * @returns {Record<string, Function>} component types by seat name
 */
function createStripSeats(ctx) {
  return {
    mode: createModeSeat({ loadRoster: createModeRosterLoader(ctx) }),
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

  /**
   * The strip's pinned native-action seats (ticket 06 `pane-toolbar.js`, filled
   * by tickets 07/08). Each later ticket fills its own key without touching the
   * strip or the group; `createStripSeats` builds them so an empty map keeps the
   * group invisible and leaves the tabs all the room.
   */
  const stripSeats = createStripSeats(ctx)
  const PaneHost = createPaneHost(controller, { seats: stripSeats })
  const PaneBody = createPaneBody(controller)

  // The HK Craft settings page (ticket 05): diagnostics plus the transitional
  // split-view switch. `settings.section` is a root list slot declared by
  // ui-settings-general; `slots.inject` only runs this callback once that slot
  // exists, so a shell without a settings panel simply never shows the page.
  const SettingsSection = createSettingsSection(controller)
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
   * The pane face the slash commands see: enough to keep `/resume` and `/clear`
   * inside the split workspace instead of calling the native session navigation,
   * which resets the active panel. `openInNewPane` is the `/resume` Ctrl+Enter
   * action (ticket 06); `paneIndexFor` feeds the D10 "已在窗格 N" badge. The
   * pane strip itself talks to the controller directly.
   */
  const paneCommands = {
    active: () => controller.getSnapshot().active,
    focused: () => controller.focusedPane(),
    replaceFocused: (sessionId) => controller.replaceFocusedSession(sessionId),
    openInNewPane: (sessionId) => controller.openInNewPane(sessionId),
    newConversation: (workspaceId) => controller.newInFocused(workspaceId),
    paneIndexFor: (sessionId) => controller.paneIndexOf(sessionId),
  }

  ctx.effect(() => {
    // The `main` keyed root slot is declared by ui-layout. Register our key
    // first, then the child slot entry the main entry declares. The generator
    // form matches how ui-conversation registers `main` plus its child slots.
    const disposeMain = ctx.slots.inject(MAIN_SLOT, function* () {
      yield ctx.slots.register(
        {
          name: MAIN_SLOT,
          key: PANEL_KEY,
          locale: NS,
          children: {
            [PANE_SLOT]: { kind: 'single', scope: 'session' },
          },
        },
        PaneHost,
      )
      yield ctx.slots.register({ name: PANE_SLOT, locale: NS }, PaneBody)
      controller.markRegistered()
    })

    return () => {
      disposeMain()
      controller.dispose()
    }
  }, 'dsh-hk-craft: pane mount')

  // The workspace section replaces a slot declared by ui-workspace and drives its
  // public service, so both services must exist before the entry is registered.
  // In pane mode the click switches the visible workspace tree instead of
  // letting a native reveal dismiss the pane workspace (ticket 08). The same face
  // answers "was this workspace ever opened in split" and lets the row light
  // follow the controller snapshot (ticket 02).
  const workspacePanes = {
    active: () => controller.getSnapshot().active,
    switchWorkspace: (workspaceId) => controller.switchWorkspace(workspaceId),
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
  createStripSeats,
  SETTINGS_SLOT,
  SETTINGS_SECTION_ID,
  SETTINGS_SECTION_ORDER,
}
