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
 * Keep the model from attributing the Agent tool shell's sandbox to the
 * user's sidebar terminal.
 *
 * `terminal-controller` deliberately launches the sidebar terminal outside the
 * Agent sandbox, but a `whoami`/`LanguageMode` probe run through the `pwsh`
 * tool reports the Agent shell's Low integrity and ConstrainedLanguage. Models
 * have quoted that tool observation as if it described the terminal the user
 * opens. This context states the split once, without changing any enforcement.
 */
const USER_TERMINAL_CONTEXT = 'The right-sidebar Terminal is a user-operated system shell. '
  + "It runs with the execution environment's system-user permissions and is outside the Agent sandbox and approval policy. "
  + 'Low integrity, ConstrainedLanguage, and workspace-write denials observed through the `pwsh`/`bash` tool describe only that Agent tool shell, '
  + "not the user's sidebar terminal: do not say the sidebar terminal is sandboxed unless you have directly verified that terminal process."

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
  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (scope) => {
      const systemPrompt = scope.get?.('systemPrompt') ?? ctx.get?.('systemPrompt')
      if (typeof systemPrompt?.context !== 'function') return () => {}
      let order = 0
      try {
        const base = systemPrompt.getContextOrder?.('WORKING_DIRECTORY')
        if (typeof base === 'number' && Number.isFinite(base)) order = base + 1
      } catch (_error) {
        // An older shell may not know that placement name; any finite order is
        // better than dropping the clarification.
      }
      try {
        const dispose = systemPrompt.context({
          name: 'dsh-hk-craft:user-terminal-scope',
          order,
          required: false,
          interpolate: false,
          text: USER_TERMINAL_CONTEXT,
        })
        return () => { if (typeof dispose === 'function') dispose() }
      } catch (error) {
        ctx.logger?.warn?.('[dsh-hk-craft] could not register the user-terminal prompt context', error)
        return () => {}
      }
    })
  }
  ctx.logger?.debug?.('[dsh-hk-craft] host plugin loaded')
}
