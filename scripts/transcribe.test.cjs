// Test du budget de timeout GPU (gpuTimeoutMs) — logique pure, hors-Electron.
// Usage : node scripts/transcribe.test.cjs <chemin-du-bundle-esbuild>
const t = require(process.argv[2])
const SR = 16000

let fail = 0
function check(name, got, want) {
  const ok = got === want
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`))
  if (!ok) fail++
}

// Plancher 30 s pour les clips courts.
check('0 s -> plancher 30 s', t.gpuTimeoutMs(0), 30000)
check('10 s -> plancher 30 s (20 s < 30 s)', t.gpuTimeoutMs(SR * 10), 30000)
check('15 s -> plancher 30 s (30 s)', t.gpuTimeoutMs(SR * 15), 30000)
// Zone proportionnelle (2000 ms / s = 2× temps réel).
check('16 s -> 32 s', t.gpuTimeoutMs(SR * 16), 32000)
check('60 s -> 120 s', t.gpuTimeoutMs(SR * 60), 120000)
check('90 s -> 180 s', t.gpuTimeoutMs(SR * 90), 180000)
// Plafond 3 min pour les très longues dictées.
check('120 s -> plafond 180 s (240 s > 180 s)', t.gpuTimeoutMs(SR * 120), 180000)
check('300 s (cap audio) -> plafond 180 s', t.gpuTimeoutMs(SR * 300), 180000)

console.log(fail === 0 ? '\nALL_PASS' : `\n${fail} FAILED`)
process.exit(fail ? 1 : 0)
