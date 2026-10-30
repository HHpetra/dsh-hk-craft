/**
 * Build `lib/client.js` — the dsh Web shell entry for this plugin.
 *
 * Usage: `node scripts/build-client.mjs` (also `pnpm build` from the repo root).
 * Pure-JS: no bundler dependency and no child process, see `src/build/bundle-client.mjs`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { collectModules, renderBundle } from '../src/build/bundle-client.mjs'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const clientDir = join(packageDir, 'src', 'client')
const outFile = join(packageDir, 'lib', 'client.js')
const entryId = 'index.js'

const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const id = manifest.name
const declared = manifest.dsh?.client?.inject ?? []

const readModule = (moduleId) => {
  const file = join(clientDir, moduleId)
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

const modules = collectModules(entryId, readModule)

/** Every bare specifier must be declared in `dsh.client.inject`, else the shell cannot resolve it. */
const bare = new Set()
for (const module of modules) {
  for (const match of module.source.matchAll(/require\(\s*(['"])([^.'"][^'"]*)\1\s*\)/g)) bare.add(match[2])
}
const undeclared = [...bare].filter((specifier) => !declared.includes(specifier))
if (undeclared.length > 0) {
  console.error(`client bundle requires undeclared platform modules: ${undeclared.join(', ')}`)
  console.error(`add them to "dsh.client.inject" in packages/dsh-hk-craft/package.json`)
  process.exit(1)
}

const code = renderBundle({ id, entryId, modules })

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, code)

const kb = (Buffer.byteLength(code, 'utf8') / 1024).toFixed(1)
console.log(`built ${outFile} — ${modules.length} module(s), ${kb} kB, id=${id}`)
