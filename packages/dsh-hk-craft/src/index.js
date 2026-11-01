/**
 * dsh-hk-craft host plugin entry.
 *
 * The bundle patch inserts one Cordis row with this package name. Host-side
 * services, tools, and routes belong here; browser UI ships from the same
 * package through the `dsh.client` manifest once that surface exists.
 */

import { installPwshDefault } from './pwsh-install.js'

export const name = 'dsh-hk-craft'

/** No host services are required yet, so the row loads without dependencies. */
export const inject = []

/**
 * Point dsh's terminal controller at the real PowerShell 7 executable.
 *
 * The controller is optional: a shell without it keeps the rest of the plugin.
 * `inject` waits until that service exists instead of failing the row.
 *
 * @param {object} ctx Cordis context supplied by the dsh loader.
 */
export function apply(ctx) {
  if (typeof ctx.inject === 'function') {
    ctx.inject(['terminalController'], (scope) => {
      try {
        const controller = scope.get?.('terminalController') ?? ctx.get?.('terminalController')
        installPwshDefault(controller)
      } catch (error) {
        ctx.logger?.warn?.('[dsh-hk-craft] could not prefer PowerShell 7', error)
      }
      return () => {}
    })
  }
  ctx.logger?.debug?.('[dsh-hk-craft] host plugin loaded')
}
