'use strict'

/**
 * Prefer PowerShell 7, then Windows PowerShell, for dsh's "New terminal".
 *
 * dsh's host treats `ComSpec` as the default shell, and on Windows that is
 * `cmd.exe`. The browser then remembers whichever path it launched in
 * `localStorage["dsh.terminal.shell"]`. This module writes that same key, via
 * `webTerminals.selectShell`, when the remembered shell is still cmd, unset,
 * or the previous Windows PowerShell default. It tries `pwsh` first, then
 * `powershell.exe`. cmd stays only when neither is installed. A later choice
 * in dsh's own shell menu is left alone.
 */

const { openCatalog } = require('./catalog.js')

/** dsh's own remembered shell path. */
const SHELL_PREFERENCE_KEY = 'dsh.terminal.shell'
/**
 * Set after this plugin has applied its one-time default, so a menu choice
 * made afterwards is not overwritten on the next load.
 * `pwsh-exe` means the real PowerShell 7 executable was selected. Older
 * markers (`1`, `pwsh-first`) only proved Windows PowerShell was chosen,
 * which happens when dsh cannot see the Store `pwsh` alias. Choosing that
 * fallback must not write `pwsh-exe`, or a later `pwsh.exe` can never replace it.
 */
const SHELL_DEFAULT_APPLIED_KEY = 'dsh.hkcraft.terminal.shell-default'
const SHELL_DEFAULT_APPLIED_VALUE = 'pwsh-exe'

/**
 * @param {unknown} path
 * @returns {string}
 */
function shellKind(path) {
  const text = typeof path === 'string' ? path : ''
  const base = text.split(/[/\\]/).pop() ?? ''
  return base.toLowerCase().replace(/\.exe$/u, '')
}

/**
 * PowerShell 7 (`pwsh`) when the host discovered it, otherwise Windows
 * PowerShell (`powershell`). cmd is not chosen here.
 *
 * @param {unknown} shells
 * @returns {string | null}
 */
function preferredShellPath(shells) {
  const paths = []
  if (!Array.isArray(shells)) return null
  for (const shell of shells) {
    const path = shell && typeof shell === 'object' ? shell.path : undefined
    if (typeof path === 'string' && path !== '') paths.push(path)
  }
  const pwsh = paths.find((path) => shellKind(path) === 'pwsh')
  if (pwsh !== undefined) return pwsh
  return paths.find((path) => shellKind(path) === 'powershell') ?? null
}

/**
 * Decide whether to replace dsh's remembered shell.
 *
 * @param {{ shells: unknown, currentPath: unknown, applied: boolean }} input
 * @returns {{ path: string | null, markApplied: boolean }}
 */
function planShellDefault({ shells, currentPath, applied }) {
  if (applied === true) return { path: null, markApplied: false }
  const path = preferredShellPath(shells)
  if (path === null) return { path: null, markApplied: false }
  const preferredKind = shellKind(path)
  const kind = typeof currentPath === 'string' && currentPath !== '' ? shellKind(currentPath) : null
  if (kind === 'pwsh') return { path: null, markApplied: true }
  // A shell the user picked (bash, zsh, …) stays. Windows PowerShell does not
  // count: it is the fallback written when pwsh is not visible yet.
  if (kind !== null && kind !== 'cmd' && kind !== 'powershell') {
    return { path: null, markApplied: true }
  }
  if (kind === null) {
    const list = Array.isArray(shells) ? shells : []
    const first = list.find((shell) => typeof shell?.path === 'string' && shell.path !== '')
    const defaultKind = first ? shellKind(first.path) : null
    if (defaultKind === 'pwsh') return { path: null, markApplied: true }
    // zsh or bash as the host default is a real choice. Windows PowerShell is
    // the fallback, so a later pwsh must still be able to replace it.
    if (defaultKind !== 'cmd' && defaultKind !== 'powershell') {
      return { path: null, markApplied: true }
    }
    if (defaultKind === 'powershell' && preferredKind !== 'pwsh') {
      return { path: null, markApplied: false }
    }
  }
  // Windows PowerShell stays only until pwsh shows up. Do not mark that
  // fallback as `pwsh-exe`, or the marker blocks the upgrade forever.
  if (kind === 'powershell' && preferredKind !== 'pwsh') {
    return { path: null, markApplied: false }
  }
  return { path, markApplied: preferredKind === 'pwsh' }
}

/**
 * The session the shell should ask for its shells: the current conversation,
 * or else any session it lists. `webTerminals.launchShells` needs one session id
 * and the answer does not depend on which.
 *
 * @param {any} list `sessions.list`
 * @returns {string | undefined}
 */
function sessionIdOf(list) {
  let snapshot
  try {
    snapshot = list?.getSnapshot?.()
  } catch {
    return undefined
  }
  const catalog = openCatalog({ sessions: snapshot })
  const current = catalog.current()
  if (current !== undefined) return current
  const first = catalog.sessionIds()[0]
  return first === undefined ? undefined : catalog.session(first)?.id
}

/**
 * Point dsh's remembered shell at PowerShell once a session can list shells.
 *
 * @param {{ webTerminals: any, sessions: any, storage: { getItem: (key: string) => string | null, setItem: (key: string, value: string) => void } }} options
 * @returns {() => void}
 */
function installPowerShellDefault({ webTerminals, sessions, storage }) {
  if (storage == null || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    return () => {}
  }
  if (typeof webTerminals?.launchShells !== 'function' || typeof webTerminals?.selectShell !== 'function') {
    return () => {}
  }
  let stopped = false
  let inflight = false
  /**
   * Windows PowerShell was chosen this process because pwsh was not in the
   * list. One attempt is enough until the next launch: the marker is not
   * written, so that launch can still upgrade, and the session list does not
   * re-query shells on every tick.
   */
  let powershellFallbackChosen = false
  const list = sessions?.list

  const attempt = () => {
    if (stopped || inflight || powershellFallbackChosen) return
    let applied = false
    let currentPath = null
    try {
      applied = storage.getItem(SHELL_DEFAULT_APPLIED_KEY) === SHELL_DEFAULT_APPLIED_VALUE
      currentPath = storage.getItem(SHELL_PREFERENCE_KEY)
    } catch {
      return
    }
    if (applied) return
    const sessionId = sessionIdOf(list)
    if (typeof sessionId !== 'string' || sessionId === '') return
    inflight = true
    Promise.resolve()
      .then(() => webTerminals.launchShells(sessionId))
      .then((result) => {
        if (stopped) return null
        const plan = planShellDefault({
          shells: result?.shells,
          currentPath,
          applied: false,
        })
        if (plan.path === null) return plan
        return Promise.resolve()
          .then(() => webTerminals.selectShell(plan.path))
          .then(() => plan)
      })
      .then((plan) => {
        if (stopped || plan == null) return
        if (plan.markApplied) {
          storage.setItem(SHELL_DEFAULT_APPLIED_KEY, SHELL_DEFAULT_APPLIED_VALUE)
          return
        }
        if (typeof plan.path === 'string' && shellKind(plan.path) === 'powershell') {
          powershellFallbackChosen = true
        }
      })
      .catch(() => {})
      .finally(() => {
        inflight = false
      })
  }

  attempt()
  const unsubscribe = typeof list?.subscribe === 'function' ? list.subscribe(attempt) : () => {}
  return () => {
    stopped = true
    if (typeof unsubscribe === 'function') unsubscribe()
  }
}

module.exports = {
  SHELL_PREFERENCE_KEY,
  SHELL_DEFAULT_APPLIED_KEY,
  SHELL_DEFAULT_APPLIED_VALUE,
  shellKind,
  planShellDefault,
  installPowerShellDefault,
}
