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
 * section, and `commandUi`, `sessions`, `workspaces` and `uiWorkspace` for the
 * slash commands. The optional capabilities attach through `ctx.inject`, so the
 * footer action keeps working even when a service is absent.
 *
 * The pane feature is split into a pure adapter/controller (`dsh-pane-host.js`)
 * and thin React views (`pane-view.js`).
 */

const { dictionaries } = require('./locale.js')
const { DiagnosticsAction } = require('./diagnostics.js')
const { WorkspaceSection } = require('./sidebar-workspaces.js')
const { createSectionActions } = require('./dsh-workspaces.js')
const { PANEL_KEY, PANE_SLOT, MAIN_SLOT, createPaneController } = require('./dsh-pane-host.js')
const { createViewSwitch } = require('./dsh-view-switch.js')
const { createPaneBody, createPaneHost, createPaneToggle } = require('./pane-view.js')
const { registerCommands } = require('./commands.js')

const NS = 'dsh-hk-craft'

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
 * @param {any} ctx Cordis context of the client plugin row.
 */
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dsh-hk-craft: dictionaries')

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'dsh-hk-craft.diagnostics',
        locale: NS,
      },
      DiagnosticsAction,
    ),
  )

  // The View adapter is optional: without `uiConversation` (or the
  // developer-tools gate) the panes stay chat-only instead of failing to mount.
  const controller = createPaneController(ctx, { viewSwitch: createViewSwitch(ctx) })
  const PaneHost = createPaneHost(controller)
  const PaneBody = createPaneBody(controller)
  const PaneToggle = createPaneToggle(controller)

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

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'dsh-hk-craft.panes',
        locale: NS,
      },
      PaneToggle,
    ),
  )

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
  // letting a native reveal dismiss the pane workspace (ticket 08).
  const workspacePanes = {
    active: () => controller.getSnapshot().active,
    switchWorkspace: (workspaceId) => controller.switchWorkspace(workspaceId),
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
            reorderWorkspace: actions.reorderWorkspace,
          }),
        },
        WorkspaceSection,
      ),
    )
  })

  const t = ctx.locale.bind(NS)
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

module.exports = { NS, inject, COMMAND_SERVICES, apply, WORKSPACE_SLOT_PRIORITY }
