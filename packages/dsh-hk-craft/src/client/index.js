'use strict'

/**
 * dsh-hk-craft — client (browser) half.
 *
 * Loaded by the dsh Web shell through `dsh.client` in package.json; built into
 * `lib/client.js` by `scripts/build-client.mjs`. The id passed to the shell
 * loader must equal the bundle patch row name (`dsh-hk-craft`).
 *
 * Everything here goes through public plugin services only: `slots`, `locale`,
 * `uiWorkspace` and `workspaces` for the sidebar workspace section, and
 * `commandUi`, `sessions`, `workspaces` and `uiWorkspace` for the slash
 * commands. Both capabilities attach through `ctx.inject`, so the footer action
 * keeps working even when a service is absent.
 */

const { dictionaries } = require('./locale.js')
const { DiagnosticsAction } = require('./diagnostics.js')
const { WorkspaceSection } = require('./sidebar-workspaces.js')
const { createSectionActions } = require('./dsh-workspaces.js')
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
const inject = ['slots', 'locale']

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

  // The workspace section replaces a slot declared by ui-workspace and drives its
  // public service, so both services must exist before the entry is registered.
  ctx.inject(['uiWorkspace', 'workspaces'], (scoped) => {
    const actions = createSectionActions(scoped)
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
        t,
      })
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-hk-craft: slash commands')
  })
}

module.exports = { NS, inject, COMMAND_SERVICES, apply, WORKSPACE_SLOT_PRIORITY }
