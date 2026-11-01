import test from 'node:test'
import assert from 'node:assert/strict'

import {
  findInstalledPwsh,
  installPwshDefault,
  parsePackageKey,
  parsePackageRoot,
} from './pwsh-install.js'

const KEY =
  'HKEY_CURRENT_USER\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages\\Microsoft.PowerShell_7.6.9.0_x64__8wekyb3d8bbwe'
const ROOT = 'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.9.0_x64__8wekyb3d8bbwe'
const EXE = `${ROOT}\\pwsh.exe`

test('registry text yields the package key and its root folder', () => {
  assert.equal(parsePackageKey(`\r\n${KEY}\r\nEnd of search\r\n`), KEY)
  assert.equal(
    parsePackageRoot(`    PackageRootFolder    REG_SZ    ${ROOT}\r\n`),
    ROOT,
  )
  assert.equal(parsePackageRoot('no value here'), null)
})

test('the Store package root is used when its pwsh.exe is a real file', () => {
  const seen = []
  const found = findInstalledPwsh({
    platform: 'win32',
    queryPackages: () => KEY,
    queryRoot: (key) => {
      seen.push(key)
      return `PackageRootFolder    REG_SZ    ${ROOT}`
    },
    executable: (exe) => exe === EXE,
  })
  assert.equal(found, EXE)
  assert.deepEqual(seen, [KEY])
})

test('a missing package does not invent a shell', () => {
  assert.equal(
    findInstalledPwsh({
      platform: 'win32',
      queryPackages: () => 'End of search: 0 match(es) found.',
      queryRoot: () => {
        throw new Error('should not query a root')
      },
      executable: () => true,
    }),
    null,
  )
  assert.equal(findInstalledPwsh({ platform: 'linux', queryPackages: () => KEY }), null)
})

test('the terminal controller uses that executable unless a shell is already configured', () => {
  const controller = { config: { shell: undefined, maxTerminals: 8 } }
  assert.equal(installPwshDefault(controller, EXE), true)
  assert.deepEqual(controller.config.shell, { path: EXE, name: 'pwsh', args: ['-NoLogo'] })
  assert.equal(controller.config.maxTerminals, 8)

  const chosen = { config: { shell: { path: 'C:\\Windows\\System32\\cmd.exe', name: 'cmd', args: [] } } }
  assert.equal(installPwshDefault(chosen, EXE), false)
  assert.equal(chosen.config.shell.path, 'C:\\Windows\\System32\\cmd.exe')
})
