/**
 * Build `lib/client.js` — the dsh Web shell entry for this plugin.
 *
 * Usage: `node scripts/build-client.mjs` (also `pnpm build` from the repo root).
 *
 * The shell evaluates one CommonJS factory per plugin:
 *   window.__ModuleLoader__.load({ id, factory: (require) => entryExports })
 * so esbuild bundles `src/client/` as CJS and the loader call is wrapped around
 * it with a banner/footer. Platform modules (declared in `dsh.client.inject`)
 * stay external and are satisfied by the factory's `require`.
 *
 * Two ways to reach esbuild:
 *  - in-process service (normal), and
 *  - the esbuild CLI with `stdio: "inherit"` when the service cannot start
 *    (confined sandboxes block piped child stdio, which is how the service
 *    talks to its binary). Set `HK_CRAFT_ESBUILD_CLI=1` to force the CLI.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(packageDir, 'src', 'client', 'index.js')
const outFile = join(packageDir, 'lib', 'client.js')

const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const id = manifest.name
const declared = manifest.dsh?.client?.inject ?? []

const banner = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(id)},
  factory: function (require) {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;`

const footer = `    return module.exports;
  }
});`

/** @type {Record<string, unknown>} */
const options = {
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  write: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  jsx: 'transform',
  // Later tickets may write JSX in `.js` files under src/client/.
  loader: { '.js': 'jsx' },
  external: declared,
  logLevel: 'silent',
  banner: { js: banner },
  footer: { js: footer },
  metafile: true,
}

/** `spawn EPERM` from the esbuild service means "binary could not be spawned", not "build is broken". */
function isSpawnDenial(error) {
  const code = /** @type {{ code?: string }} */ (error)?.code
  return code === 'EPERM' || /spawn (EPERM|EACCES)/i.test(String(error?.message ?? error))
}

/** Mirror the option object as CLI flags for the fallback path. */
function toCliArgs() {
  const args = [
    entry,
    '--outfile=' + outFile,
    '--bundle',
    '--format=cjs',
    '--platform=browser',
    '--target=es2020',
    '--jsx=transform',
    '--loader:.js=jsx',
    '--banner:js=' + banner,
    '--footer:js=' + footer,
  ]
  for (const specifier of declared) args.push('--external:' + specifier)
  return args
}

async function buildInProcess() {
  const { build } = await import('esbuild')
  return await build(options)
}

function buildViaCli() {
  const require = createRequire(import.meta.url)
  const cli = require.resolve('esbuild/bin/esbuild')
  const result = spawnSync(process.execPath, [cli, ...toCliArgs()], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    console.error(`esbuild CLI exited with status ${result.status}`)
    process.exit(result.status ?? 1)
  }
  return null
}

let result = null
if (process.env.HK_CRAFT_ESBUILD_CLI === '1') {
  buildViaCli()
} else {
  try {
    result = await buildInProcess()
  } catch (error) {
    if (!isSpawnDenial(error)) throw error
    console.log('esbuild service unavailable in this sandbox — falling back to the esbuild CLI')
    buildViaCli()
  }
}

const code = readFileSync(outFile, 'utf8')

/** Every bare require must be declared in `dsh.client.inject`, else the shell cannot resolve it. */
const bare = new Set()
for (const match of code.matchAll(/require\(\s*(['"])([^.'"][^'"]*)\1\s*\)/g)) bare.add(match[2])
const undeclared = [...bare].filter((specifier) => !declared.includes(specifier))
if (undeclared.length > 0) {
  console.error(`client bundle requires undeclared platform modules: ${undeclared.join(', ')}`)
  console.error('add them to "dsh.client.inject" in packages/dsh-hk-craft/package.json')
  process.exit(1)
}

const modules = result ? Object.keys(Object.values(result.metafile.outputs)[0].inputs).length : null
const kb = (Buffer.byteLength(code, 'utf8') / 1024).toFixed(1)
console.log(
  `built ${outFile} — ${modules === null ? 'cli' : modules + ' module(s)'}, ${kb} kB, id=${id}`,
)
