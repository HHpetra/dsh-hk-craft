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
    { encoding: 'utf8', windowsHide: true },
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
 * Make PowerShell 7 the terminal controller's configured shell so shell
 * discovery lists that absolute path. An existing `config.shell` is a user
 * override and is left alone.
 *
 * @param {any} controller
 * @param {string | null} [pwshPath]
 * @returns {boolean} whether the controller config changed
 */
function installPwshDefault(controller, pwshPath = findInstalledPwsh()) {
  if (typeof pwshPath !== 'string' || pwshPath === '') return false
  if (controller?.config == null || controller.config.shell != null) return false
  controller.config.shell = { path: pwshPath, name: 'pwsh', args: ['-NoLogo'] }
  return true
}

export { parsePackageRoot, parsePackageKey, findInstalledPwsh, installPwshDefault }
