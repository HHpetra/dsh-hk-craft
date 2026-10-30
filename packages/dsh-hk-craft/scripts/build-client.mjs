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
 */
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
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

const result = await build({
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
})

const outputs = result.metafile.outputs
const built = Object.values(outputs)[0]
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

const kb = (Buffer.byteLength(code, 'utf8') / 1024).toFixed(1)
console.log(
  `built ${outFile} — ${Object.keys(built.inputs).length} module(s), ${kb} kB, id=${id}`,
)
