/**
 * dsh-hk-craft host plugin entry.
 *
 * The bundle patch inserts one Cordis row with this package name. Host-side
 * services, tools, and routes belong here; browser UI ships from the same
 * package through the `dsh.client` manifest once that surface exists.
 */

export const name = 'dsh-hk-craft'

/** No host services are required yet, so the row loads without dependencies. */
export const inject = []

/**
 * Row entry point. Kept side-effect free: the scaffold must install and boot
 * without changing dsh behavior before the plugin's capability is decided.
 *
 * @param {object} ctx Cordis context supplied by the dsh loader.
 */
export function apply(ctx) {
  ctx.logger?.debug?.('[dsh-hk-craft] host plugin loaded')
}
