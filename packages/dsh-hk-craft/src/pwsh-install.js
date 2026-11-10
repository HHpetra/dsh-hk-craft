import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'

/**
 * dsh discovers `pwsh` by calling `stat` on each PATH entry. The Microsoft
 * Store build publishes a 0-byte app-execution alias at
 * `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`. `stat` on that alias fails
 * with EACCES, so dsh drops PowerShell 7 and the terminal falls through to
 * Windows PowerShell 5.1. The real executable lives under the package's
 * `PackageRootFolder` and can be spawned directly.
 */

const PACKAGE_KEY_ROOT =
  'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages'

/**
 * How long one registry query may take before it counts as "not found".
 *
 * Both queries spawn `reg.exe`, which a slow disk or an antivirus real-time
 * scan can stall. The probe runs on the host's load path, so an unbounded wait
 * would hold the whole app. A timeout is a miss: the controller keeps whatever
 * shell it already has.
 */
const PROBE_TIMEOUT_MS = 1500

/**
 * @param {string} text `reg query` output
 * @returns {string | null}
 */
function parsePackageRoot(text) {
  const match = String(text).match(/PackageRootFolder\s+REG_SZ\s+(.+)/)
  if (match === null) return null
  const root = match[1].trim()
  return root === '' ? null : root
}

/**
 * @param {string} text `reg query /k` output
 * @returns {string | null} full registry key
 */
function parsePackageKey(text) {
  const match = String(text).match(/HKEY_CURRENT_USER\\[^\r\n]*\\Microsoft\.PowerShell_[^\r\n]+/)
  return match === null ? null : match[0].trim()
}

/**
 * @param {{ platform?: string, queryPackages?: () => string, queryRoot?: (key: string) => string, executable?: (root: string) => boolean }} [deps]
 * @returns {string | null}
 */
function findInstalledPwsh(deps = {}) {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') return null
  const queryPackages = deps.queryPackages ?? defaultQueryPackages
  const queryRoot = deps.queryRoot ?? defaultQueryRoot
  const executable = deps.executable ?? defaultExecutable
  let packages
  try {
    packages = queryPackages()
  } catch {
    return null
  }
  const key = parsePackageKey(packages)
  if (key === null) return null
  let detail
  try {
    detail = queryRoot(key)
  } catch {
    return null
  }
  const root = parsePackageRoot(detail)
  if (root === null) return null
  const exe = `${root.replace(/[\\/]+$/u, '')}\\pwsh.exe`
  return executable(exe) ? exe : null
}

function defaultQueryPackages() {
  return execFileSync(
    'reg',
    ['query', PACKAGE_KEY_ROOT, '/f', 'Microsoft.PowerShell_', '/k'],
    { encoding: 'utf8', windowsHide: true, timeout: PROBE_TIMEOUT_MS },
  )
}

/**
 * @param {string} key
 * @returns {string}
 */
function defaultQueryRoot(key) {
  return execFileSync('reg', ['query', key, '/v', 'PackageRootFolder'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: PROBE_TIMEOUT_MS,
  })
}

/**
 * A real image, not the 0-byte WindowsApps alias.
 *
 * @param {string} exe
 * @returns {boolean}
 */
function defaultExecutable(exe) {
  try {
    const info = statSync(exe)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

/**
 * A resolver that runs one probe per process, success and miss alike.
 *
 * The probe spawns `reg.exe` twice, so it must not run on every plugin load or
 * reload: a miss is cached too, otherwise a machine without PowerShell 7 pays
 * for the search on every start. The cache lives in the closure, so tests
 * create their own instance instead of sharing process state.
 *
 * @param {() => string | null} [resolve]
 * @returns {() => string | null}
 */
function createPwshProbe(resolve = findInstalledPwsh) {
  let resolved = false
  let value = null
  return function probePwsh() {
    if (resolved) return value
    resolved = true
    try {
      value = resolve()
    } catch (_error) {
      value = null
    }
    return value
  }
}

/**
 * Make PowerShell 7 the terminal controller's configured shell so shell
 * discovery lists that absolute path. An existing `config.shell` is a user
 * override and is left alone.
 *
 * The resolution is deliberately *lazy*: a configured shell answers before any
 * resolver runs, so the registry probe only happens when the answer is still
 * unknown. `resolve` accepts either the memoised probe or a plain path, which
 * keeps the old call shape working.
 *
 * @param {any} controller
 * @param {string | null | (() => string | null)} [resolve] path, probe, or resolver
 * @returns {boolean} whether the controller config changed
 */
function installPwshDefault(controller, resolve = findInstalledPwsh) {
  if (controller?.config == null) return false
  if (controller.config.shell != null) return false
  let pwshPath
  try {
    pwshPath = typeof resolve === 'function' ? resolve() : resolve
  } catch (_error) {
    return false
  }
  if (typeof pwshPath !== 'string' || pwshPath === '') return false
  controller.config.shell = { path: pwshPath, name: 'pwsh', args: ['-NoLogo'] }
  return true
}

export { parsePackageRoot, parsePackageKey, findInstalledPwsh, createPwshProbe, installPwshDefault }
