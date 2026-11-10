/**
 * dsh-hk-craft host plugin entry.
 *
 * The bundle patch inserts one Cordis row with this package name. Host-side
 * services, tools, and routes belong here; browser UI ships from the same
 * package through the `dsh.client` manifest once that surface exists.
 */

import { createPwshProbe, installPwshDefault } from './pwsh-install.js'

export const name = 'dsh-hk-craft'

/** No host services are required yet, so the row loads without dependencies. */
export const inject = []

/**
 * One probe per process: the registry is read only while the terminal shell is
 * still unknown, and a miss is remembered so a restart does not search again.
 */
const probePwsh = createPwshProbe()

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
        if (controller?.config == null) return () => {}
        // The registry probe costs two `reg.exe` spawns. An already configured
        // shell is the answer it would look for, so skip the work entirely: the
        // host load path must not pay for a result nobody will use.
        if (controller.config.shell != null) {
          ctx.logger?.debug?.('[dsh-hk-craft] terminal shell already configured; skipping PowerShell probe')
          return () => {}
        }
        const changed = installPwshDefault(controller, probePwsh)
        ctx.logger?.debug?.(
          changed
            ? '[dsh-hk-craft] preferring PowerShell 7 for new terminals'
            : '[dsh-hk-craft] PowerShell 7 not found; leaving the terminal shell alone',
        )
      } catch (error) {
        ctx.logger?.warn?.('[dsh-hk-craft] could not prefer PowerShell 7', error)
      }
      return () => {}
    })
  }
  ctx.logger?.debug?.('[dsh-hk-craft] host plugin loaded')
}
