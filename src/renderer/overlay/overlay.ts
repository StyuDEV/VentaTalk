// Overlay : capture le micro en 16 kHz mono (AudioWorklet, hors thread UI) et anime la pilule.
// Tourne dans une fenêtre NON focusable -> ne vole jamais le focus de l'app cible.

import { trimSilence, normalizeAndPad, peakFrameRms } from './dsp'

const pill = document.getElementById('pill') as HTMLDivElement
const bars = Array.from(document.querySelectorAll<HTMLElement>('.bar'))

let audioCtx: AudioContext | null = null
let micStream: MediaStream | null = null
let soundCtx: AudioContext | null = null
let recording = false
let chunks: Float32Array[] = []
let level = 0
let gateEnabled = true // VAD léger par énergie (réglage "Anti-silence")

// Pré-roll : on garde EN CONTINU les ~400 dernières ms capturées (même hors enregistrement)
// pour ne jamais couper le début de phrase — l'utilisateur parle souvent dès l'appui, avant
// que record:start n'arrive (latence hotkey -> main -> overlay).
const PREROLL_SAMPLES = Math.round(0.4 * 16000)
let preroll: Float32Array[] = []
let prerollLen = 0

function pushPreroll(buf: Float32Array): void {
  preroll.push(buf)
  prerollLen += buf.length
  while (preroll.length > 1 && prerollLen - preroll[0].length >= PREROLL_SAMPLES) {
    prerollLen -= preroll[0].length
    preroll.shift()
  }
}

function setState(s: 'idle' | 'recording' | 'processing' | 'error'): void {
  // classList (et pas className) pour ne PAS écraser la classe d'animation `.show`.
  // UI minimaliste : l'état est porté par la couleur/le halo (plus de texte).
  pill.classList.remove('idle', 'recording', 'processing', 'error')
  pill.classList.add(s)
}

async function initAudio(): Promise<void> {
  // teardown d'une éventuelle session précédente (ré-init sur changement de micro)
  try {
    micStream?.getTracks().forEach((t) => t.stop())
  } catch {
    /* noop */
  }
  try {
    await audioCtx?.close()
  } catch {
    /* noop */
  }
  micStream = null
  audioCtx = null

  try {
    let noiseSuppression = false
    let micDeviceId = ''
    try {
      const s = await window.venta.getSettings()
      noiseSuppression = !!s.noiseSuppression
      gateEnabled = s.vadEnabled !== false
      micDeviceId = s.micDeviceId || ''
    } catch {
      /* défauts */
    }

    const audio: MediaTrackConstraints = {
      channelCount: 1,
      echoCancellation: true,
      // AGC coupé : il remonte le bruit de fond pendant les silences (carburant des hallucinations).
      autoGainControl: false,
      noiseSuppression
    }
    if (micDeviceId) audio.deviceId = { exact: micDeviceId }

    const stream = await navigator.mediaDevices.getUserMedia({ audio })
    micStream = stream

    // Chromium délivre directement du 16 kHz mono : aucun rééchantillonnage manuel.
    audioCtx = new AudioContext({ sampleRate: 16000 })
    const source = audioCtx.createMediaStreamSource(stream)

    // Passe-haut 80 Hz : coupe ronflement secteur, ventilateur, plosives (rien d'utile sous ~85 Hz).
    const hp = audioCtx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 80
    hp.Q.value = 0.707

    await audioCtx.audioWorklet.addModule(new URL('./capture-processor.js', import.meta.url))
    const node = new AudioWorkletNode(audioCtx, 'capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1
    })

    source.connect(hp)
    hp.connect(node)
    node.connect(audioCtx.destination) // sortie silencieuse (pour que le nœud soit traité)

    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const input = e.data
      let sum = 0
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
      level = Math.sqrt(sum / input.length)
      if (recording) chunks.push(input)
      else pushPreroll(input) // alimente le pré-roll quand on n'enregistre pas
    }

    // Le contexte doit tourner en continu pour que le pré-roll se remplisse (le micro est
    // de toute façon déjà ouvert via getUserMedia). On résout une éventuelle suspension.
    await audioCtx.resume().catch(() => {})
  } catch (err) {
    setState('error')
    console.error('getUserMedia/AudioWorklet a échoué', err)
  }
}

const BAR_COUNT = bars.length
function animate(): void {
  const l = Math.min(1, level * 8)
  const t = performance.now() / 1000
  const rec = pill.classList.contains('recording')
  const proc = pill.classList.contains('processing')
  const err = pill.classList.contains('error')
  for (let i = 0; i < BAR_COUNT; i++) {
    // enveloppe centrée (plus haut au milieu)
    const center = 1 - Math.abs((i - (BAR_COUNT - 1) / 2) / ((BAR_COUNT - 1) / 2))
    const env = 0.4 + 0.6 * center
    let v: number
    if (rec) {
      // écoute : ondulation par barre, modulée par le niveau micro
      const wob = 0.5 + 0.5 * Math.sin(t * 9 + i * 0.55)
      v = 0.14 + l * env * (0.55 + 0.45 * wob)
    } else if (proc) {
      // traitement : onde de "chargement" (violette) qui traverse la barre
      v = 0.16 + 0.46 * (0.5 + 0.5 * Math.sin(t * 6 - i * 0.5))
    } else if (err) {
      // erreur : barres figées (pas de rebond) -> lecture "stop", calme
      v = 0.2 * env + 0.05
    } else {
      // repos : ligne calme qui respire légèrement
      v = 0.11 + Math.sin(t * 1.6 + i * 0.5) * 0.03
    }
    bars[i].style.transform = `scaleY(${Math.max(0.1, Math.min(1, v))})`
  }
  requestAnimationFrame(animate)
}

function concat(): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const pcm = new Float32Array(total)
  let off = 0
  for (const c of chunks) {
    pcm.set(c, off)
    off += c.length
  }
  return pcm
}

// Sous ce pic, le clip est du silence numérique : on n'envoie rien (évite une hallucination).
const FALLBACK_FLOOR = 0.0015

function finalize(): Float32Array {
  const raw = concat()
  if (raw.length === 0) return raw
  if (!gateEnabled) return normalizeAndPad(raw)

  const trimmed = trimSilence(raw)
  if (trimmed.length > 0) return normalizeAndPad(trimmed)
  // Le VAD n'a rien gardé. Si le clip n'est pas du silence pur (micro à très faible gain),
  // on envoie quand même le brut : la normalisation remonte le niveau pour Whisper.
  if (peakFrameRms(raw) > FALLBACK_FLOOR) return normalizeAndPad(raw)
  return new Float32Array(0) // réellement silencieux
}

// Sons fichiers : le son d'enregistrement (resources/record.mp3) joué à l'endroit pour "start",
// et à l'ENVERS (notes inversées) pour "done" = son de confirmation/fermeture.
let recordBuffer: AudioBuffer | null = null
let reversedBuffer: AudioBuffer | null = null
let currentSource: AudioBufferSourceNode | null = null

/** Inverse temporellement un AudioBuffer (lecture à l'envers). */
function reverseBuffer(ctx: AudioContext, buf: AudioBuffer): AudioBuffer {
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate)
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const src = buf.getChannelData(ch)
    const dst = out.getChannelData(ch)
    for (let i = 0, j = buf.length - 1; i < buf.length; i++, j--) dst[i] = src[j]
  }
  return out
}

/** Charge le son d'enregistrement depuis le main, le décode et prépare sa version inversée. */
async function loadSounds(): Promise<void> {
  try {
    const b64 = await window.venta.getRecordSound()
    if (!b64) return // pas de fichier -> on garde les bips synthétiques
    if (!soundCtx) soundCtx = new AudioContext()
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const buf = await soundCtx.decodeAudioData(bytes.buffer)
    recordBuffer = buf
    reversedBuffer = reverseBuffer(soundCtx, buf)
  } catch (e) {
    console.warn('son d’enregistrement indisponible, repli sur bips synthétiques', e)
  }
}

/** Joue un AudioBuffer ponctuel (volume modéré), sur le contexte son dédié. */
function playBuffer(buf: AudioBuffer): void {
  if (!soundCtx) return
  void soundCtx.resume()
  // Coupe le son précédent (ex. le son de début encore en cours) -> pas de chevauchement.
  try {
    currentSource?.stop()
  } catch {
    /* déjà arrêtée */
  }
  const src = soundCtx.createBufferSource()
  const g = soundCtx.createGain()
  g.gain.value = 0.75
  src.buffer = buf
  src.connect(g)
  g.connect(soundCtx.destination)
  src.onended = (): void => {
    if (currentSource === src) currentSource = null
  }
  currentSource = src
  src.start()
}

/** Sons de retour : fichier (start = à l'endroit, done = à l'envers), sinon bips synthétiques. */
function playTone(kind: 'start' | 'done' | 'error'): void {
  try {
    if (!soundCtx) soundCtx = new AudioContext()
    if (kind === 'start' && recordBuffer) return playBuffer(recordBuffer)
    if (kind === 'done' && reversedBuffer) return playBuffer(reversedBuffer)
    // Repli synthétique (toujours pour 'error', ou si le fichier n'a pas pu être chargé).
    const ctx = soundCtx
    void ctx.resume()
    const now = ctx.currentTime
    const beep = (freq: number, start: number, dur: number, gain = 0.06): void => {
      const osc = ctx.createOscillator()
      const g = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      g.gain.setValueAtTime(0, now + start)
      g.gain.linearRampToValueAtTime(gain, now + start + 0.012)
      g.gain.linearRampToValueAtTime(0, now + start + dur)
      osc.connect(g)
      g.connect(ctx.destination)
      osc.start(now + start)
      osc.stop(now + start + dur + 0.02)
    }
    if (kind === 'start') beep(880, 0, 0.09)
    else if (kind === 'done') {
      beep(880, 0, 0.07)
      beep(1320, 0.075, 0.1)
    } else {
      beep(300, 0, 0.18, 0.08)
    }
  } catch {
    /* noop */
  }
}

window.venta.onRecordStart(async () => {
  if (audioCtx && audioCtx.state === 'suspended') await audioCtx.resume()
  hideToastBanner() // efface une éventuelle bannière d'erreur de la dictée précédente
  chunks = preroll.slice() // démarre avec le pré-roll -> on ne perd pas l'attaque de la phrase
  recording = true
  setState('recording')
  // déclenche l'animation d'entrée (splash depuis le bas) — rAF pour garantir la transition
  requestAnimationFrame(() => pill.classList.add('show'))
  // rafraîchit le réglage anti-silence (au cas où il a été changé sans relancer)
  window.venta
    .getSettings()
    .then((s) => {
      gateEnabled = s.vadEnabled !== false
    })
    .catch(() => {})
})

window.venta.onRecordStop(() => {
  recording = false
  const pcm = finalize()
  chunks = []
  window.venta.sendAudio(pcm)
  setState('processing')
})

// Annulation (Échap) : on stoppe la capture et on JETTE l'audio (aucun sendAudio).
// Le main remet l'état à idle (-> animation de sortie via onState).
window.venta.onRecordCancel(() => {
  recording = false
  chunks = []
})

window.venta.onState((s) => {
  setState(s)
  if (s === 'idle') pill.classList.remove('show') // animation de sortie (descente)
})
window.venta.onSound((kind) => playTone(kind))
window.venta.onReinitAudio(() => void initAudio())

// ── Bannière d'erreur à l'écran (réutilise la fenêtre overlay) ──
const toastEl = document.getElementById('toast') as HTMLDivElement
const toastMsg = document.getElementById('toastMsg') as HTMLSpanElement
let toastHideTimer: ReturnType<typeof setTimeout> | null = null
function showToastBanner(message: string): void {
  pill.classList.remove('show') // la barre de dictée redescend si elle est encore là
  toastMsg.textContent = message
  if (toastHideTimer) clearTimeout(toastHideTimer)
  // courte tempo : laisse la barre descendre avant que la bannière jaillisse (pas de chevauchement)
  setTimeout(() => requestAnimationFrame(() => toastEl.classList.add('show')), 130)
  toastHideTimer = setTimeout(() => {
    toastEl.classList.remove('show')
    toastHideTimer = null
  }, 2400)
}
function hideToastBanner(): void {
  if (toastHideTimer) {
    clearTimeout(toastHideTimer)
    toastHideTimer = null
  }
  toastEl.classList.remove('show')
}
window.venta.onOverlayToast((m) => showToastBanner(m))

void initAudio()
void loadSounds()
animate()
