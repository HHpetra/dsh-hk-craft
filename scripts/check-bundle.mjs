/**
 * Structural check for the installable dsh bundle.
 *
 * Verifies the invariants the scaffold depends on, without booting dsh:
 * manifest identity, bundle patch, host entry, exports, dsh engine range, and
 * the "no separate app entry" decision (ADR-0001).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundleDir = join(root, 'packages', 'dsh-hk-craft')
const failures = []
const passed = []

/**
 * @param {boolean} ok
 * @param {string} message
 */
function check(ok, message) {
  if (ok) passed.push(message)
  else failures.push(message)
}

/** @param {string} text */
function read(text) {
  return readFileSync(text, 'utf8')
}

const rootManifest = JSON.parse(read(join(root, 'package.json')))
check(rootManifest.private === true, 'root package is private workspace')
check(
  typeof rootManifest.packageManager === 'string' && rootManifest.packageManager.startsWith('pnpm@'),
  'root package pins pnpm via packageManager',
)
check(
  typeof rootManifest.engines?.node === 'string',
  'root package declares engines.node',
)
check(!existsSync(join(root, 'apps')), 'no apps/ directory (ADR-0001)')
check(!existsSync(join(root, 'packages', 'dsh-profile')), 'no product dsh-profile package (ADR-0001)')

const bundlePath = join(bundleDir, 'package.json')
check(existsSync(bundlePath), 'bundle package.json exists')
if (!existsSync(bundlePath)) {
  report()
  process.exit(1)
}

const bundle = JSON.parse(read(bundlePath))
check(bundle.name === 'dsh-hk-craft', 'bundle name is dsh-hk-craft')
check(bundle.private === true, 'bundle package is private while unpublished')
check(bundle.type === 'module', 'bundle is ESM (type: module)')
check(bundle.dsh?.profile === undefined, 'bundle does not declare dsh.profile')
check(typeof bundle.engines?.dsh === 'string', 'bundle declares engines.dsh')

const patchRelative = bundle.dsh?.bundle?.patch
check(typeof patchRelative === 'string', 'bundle declares dsh.bundle.patch')
if (typeof patchRelative === 'string') {
  const patchPath = resolve(bundleDir, patchRelative)
  check(existsSync(patchPath), `bundle patch exists: ${patchRelative}`)
  if (existsSync(patchPath)) {
    const patch = read(patchPath)
    const idPattern = new RegExp(`id:\\s*['"]?${bundle.name}['"]?\\b`)
    check(idPattern.test(patch), `bundle patch inserts id ${bundle.name}`)
    const namePattern = new RegExp(`name:\\s*['"]?${bundle.name}['"]?\\b`)
    check(namePattern.test(patch), `bundle patch loads name ${bundle.name}`)
    const idCount = (patch.match(new RegExp(`id:\\s*['"]?${bundle.name}['"]?\\b`, 'g')) ?? []).length
    check(idCount === 1, 'bundle patch inserts the row exactly once')
  }
}

check(typeof bundle.main === 'string', 'bundle declares main entry')
if (typeof bundle.main === 'string') {
  check(existsSync(resolve(bundleDir, bundle.main)), `bundle main entry exists: ${bundle.main}`)
}

const rootExport = bundle.exports?.['.']
check(typeof rootExport === 'string', 'bundle exports "."')
if (typeof rootExport === 'string') {
  check(existsSync(resolve(bundleDir, rootExport)), `bundle "." export exists: ${rootExport}`)
}

const client = bundle.dsh?.client
if (client !== undefined) {
  check(typeof client.platform === 'string', 'dsh.client declares platform')
  check(client.platform === 'web', 'dsh.client targets the web platform')
  check(Array.isArray(client.inject), 'dsh.client declares inject list')
  check(typeof bundle.exports?.['./client'] === 'string', 'dsh.client bundle exports "./client"')
  const clientExport = bundle.exports?.['./client']
  if (typeof clientExport === 'string') {
    check(existsSync(resolve(bundleDir, clientExport)), `client bundle exists: ${clientExport}`)
    const entrySource = join(bundleDir, 'src', 'client', 'index.js')
    check(existsSync(entrySource), 'client entry source exists')
    if (existsSync(resolve(bundleDir, clientExport))) {
      const built = read(resolve(bundleDir, clientExport))
      check(built.includes('window.__ModuleLoader__.load('), 'client bundle boots through the shell module loader')
      check(
        built.includes(`id: ${JSON.stringify(bundle.name)}`),
        'client bundle id equals the bundle patch row name',
      )
      // Every bare require in the built bundle must be declared, or the shell cannot resolve it.
      const bare = new Set()
      for (const match of built.matchAll(/require\(\s*(['"])([^.'"][^'"]*)\1\s*\)/g)) bare.add(match[2])
      const undeclared = [...bare].filter((specifier) => !(client.inject ?? []).includes(specifier))
      check(undeclared.length === 0, `client bundle requires only declared platform modules: ${undeclared.join(', ')}`)
    } else {
      check(false, 'client bundle not built — run `pnpm build` before installing')
    }
  }
}

report()

function report() {
  for (const message of passed) console.log(`  ok  ${message}`)
  for (const message of failures) console.error(`FAIL  ${message}`)
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`)
    process.exitCode = 1
    return
  }
  console.log(`\nall ${passed.length} checks passed`)
}
