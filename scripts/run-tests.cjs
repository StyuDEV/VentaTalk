// Lance TOUTES les suites de tests purs (logique hors-Electron) : bundle esbuild -> node.
// C'est la version scriptée des commandes documentées dans CLAUDE.md (npm test / CI).
// Usage : node scripts/run-tests.cjs
const { buildSync } = require('esbuild')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

const root = join(__dirname, '..')
const out = join(root, 'out')

/** Bundle un module TS en CJS testable sous node (les modules natifs/electron restent externes). */
function bundle(entry, outfile, external = []) {
  buildSync({
    entryPoints: [join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external,
    outfile: join(out, outfile),
    logLevel: 'error'
  })
  return join(out, outfile)
}

const hk = bundle('src/main/hotkey.ts', 'hk.cjs', ['uiohook-napi', 'electron'])
const dsp = bundle('src/renderer/overlay/dsp.ts', 'dsp.cjs')
const repl = bundle('src/main/replacements.ts', 'repl.cjs')
const disf = bundle('src/main/disfluencies.ts', 'disf.cjs')
const tr = bundle('src/main/transcribe.ts', 'tr.cjs', ['electron'])

const suites = [
  ['hotkey', 'scripts/hotkey.test.cjs', [hk]],
  ['dsp + remplacements', 'scripts/dsp.test.cjs', [dsp, repl]],
  ['disfluences', 'scripts/disfluencies.test.cjs', [disf]],
  ['transcribe (timeouts)', 'scripts/transcribe.test.cjs', [tr]]
]

let failed = 0
for (const [name, script, args] of suites) {
  console.log(`\n──── ${name} ────`)
  const r = spawnSync(process.execPath, [join(root, script), ...args], { stdio: 'inherit' })
  if (r.status !== 0) failed++
}

console.log(failed === 0 ? '\n✔ Toutes les suites passent.' : `\n✘ ${failed} suite(s) en échec.`)
process.exit(failed === 0 ? 0 : 1)
