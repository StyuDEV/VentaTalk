// Test du VAD énergie (dsp.trimSilence) et des remplacements (replacements.applyReplacements).
const dsp = require(process.argv[2])
const repl = require(process.argv[3])

let fail = 0
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name)
  if (!cond) fail++
}

// ── trimSilence ──
check('silence pur -> vide', dsp.trimSilence(new Float32Array(16000)).length === 0)

const low = new Float32Array(16000)
low.fill(0.001) // sous le seuil 0.012
check('bruit faible -> vide', dsp.trimSilence(low).length === 0)

const speech = new Float32Array(16000)
for (let i = 8000; i < 10000; i++) speech[i] = 0.2 * Math.sin(i)
const trimmed = dsp.trimSilence(speech)
check('parole -> non vide', trimmed.length > 0)
check('parole -> trimé (plus court)', trimmed.length < speech.length)
let peak = 0
for (const s of trimmed) peak = Math.max(peak, Math.abs(s))
check('parole -> burst conservé', peak > 0.1)

// micro à FAIBLE GAIN : amplitude 0.008, sous l'ancien seuil absolu 0.012 -> DOIT être gardé
// (régression de l'échec silencieux : le seuil adaptatif ne jette plus la dictée).
const lowGain = new Float32Array(16000)
for (let i = 6000; i < 10000; i++) lowGain[i] = 0.008 * Math.sin(i)
check('faible gain -> gardé (plus de drop silencieux)', dsp.trimSilence(lowGain).length > 0)

// ── peakFrameRms / rms ──
check('peakFrameRms silence ~ 0', dsp.peakFrameRms(new Float32Array(16000)) < 0.001)
check('peakFrameRms parole > 0.05', dsp.peakFrameRms(speech) > 0.05)

// ── applyReplacements ──
check(
  'remplacement multiple',
  repl.applyReplacements('voici quoine et ventatalk', 'quoine=>Qwen\nventatalk=>VentaTalk') ===
    'voici Qwen et VentaTalk'
)
check('insensible à la casse', repl.applyReplacements('Quoine', 'quoine=>Qwen') === 'Qwen')
check('mot entier seulement', repl.applyReplacements('quoineX', 'quoine=>Qwen') === 'quoineX')
check('sans règles -> inchangé', repl.applyReplacements('abc def', '') === 'abc def')

console.log(fail === 0 ? '\nALL_PASS' : `\n${fail} FAILED`)
process.exit(fail ? 1 : 0)
