'use strict'

/**
 * dsh-hk-craft — client (browser) half.
 *
 * Loaded by the dsh Web shell through `dsh.client` in package.json; built into
 * `lib/client.js` by `scripts/build-client.mjs`. The id passed to the shell
 * loader must equal the bundle patch row name (`dsh-hk-craft`).
 *
 * Everything here goes through public plugin services only: `slots`, `locale`
 * today; session/workspace/layout services are added by later tickets.
 */

const { dictionaries } = require('./locale.js')
const { DiagnosticsAction } = require('./diagnostics.js')

const NS = 'dsh-hk-craft'

/** Cordis services this plugin needs before `apply` runs. */
const inject = ['slots', 'locale']

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
}

module.exports = { NS, inject, apply }
