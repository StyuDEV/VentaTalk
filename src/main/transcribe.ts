import os from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { whisperServerExe, whisperBinRoot } from './models'

const N_THREADS = Math.max(2, Math.min(os.cpus().length, 8))
const HOST = '127.0.0.1'
const PORT = 8917
// Garde-fou : si le serveur GPU fige, on abandonne le fetch (sinon l'app reste coincée en
// "processing" à vie). Le délai est PROPORTIONNEL à la durée de l'audio : une longue dictée prend
// légitimement plus de temps — un délai fixe trop court échouerait à tort. 2× le temps réel : un
// GPU qui marche ne l'atteint JAMAIS (whisper.cpp est plus rapide que le temps réel, même un iGPU
// Vulkan modeste) ; ce budget ne sert qu'à détecter un serveur RÉELLEMENT figé. Plancher 30 s,
// plafond 3 min. (Il n'y a PAS de repli CPU : trop lent — supprimé volontairement.)
const INFERENCE_TIMEOUT_MIN_MS = 30000
const INFERENCE_TIMEOUT_MAX_MS = 180000
/** Budget d'attente du serveur GPU selon la durée de l'audio (plancher 30 s, plafond 3 min). */
export function gpuTimeoutMs(samples: number, sampleRate = 16000): number {
  const seconds = samples / sampleRate
  return Math.min(
    INFERENCE_TIMEOUT_MAX_MS,
    Math.max(INFERENCE_TIMEOUT_MIN_MS, Math.round(seconds * 2000))
  )
}
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface EngineConfig {
  modelPath: string
  language: string
  vocabulary: string
}

type Backend = 'gpu' | null
let backend: Backend = null
let currentModel: string | null = null
let currentCfg: EngineConfig | null = null

// ── moteur GPU : whisper-server (CUDA NVIDIA / Vulkan AMD-Intel) en sidecar, modèle en VRAM ──
// Pas de moteur CPU : la transcription est 100 % GPU (le repli CPU smart-whisper était trop lent).
let server: ChildProcess | null = null
let serverSig: string | null = null

/** Initial prompt : biais ponctuation/casse + vocabulaire. Poussé même SANS vocabulaire
 *  (le biais de ponctuation est gratuit et améliore casse/ponctuation par défaut). */
function initialPrompt(cfg: { language: string; vocabulary?: string }): string {
  const fr = !cfg.language || cfg.language === 'auto' || cfg.language === 'fr'
  const base = `Transcription${fr ? ' en français' : ''}, ponctuée.`
  const vocab = cfg.vocabulary?.trim()
  return vocab ? `${base} Vocabulaire : ${vocab}` : base
}

/** Construit les arguments de whisper-server depuis la config (anti-hallucination, langue, prompt). */
function serverArgs(cfg: EngineConfig): string[] {
  const args = ['-m', cfg.modelPath, '--host', HOST, '--port', String(PORT), '-t', String(N_THREADS)]
  // Langue forcée (fr) au lieu de l'auto-détection -> bien plus fiable sur clips courts.
  args.push('-l', cfg.language && cfg.language !== 'auto' ? cfg.language : 'auto')
  // Anti-hallucination + précision : suppression tokens non-vocaux, seuil entropie, beam search,
  // et plafond de contexte texte (-mc 64 : coupe les boucles d'hallucination sur longues dictées).
  // (Le VAD anti-silence est fait côté client — le VAD du serveur v1.9.1 est défaillant.)
  args.push('-sns', '-et', '2.6', '-bs', '5', '-mc', '64')
  // Initial prompt : ponctuation/casse par défaut + biais d'orthographe du vocabulaire.
  args.push('--prompt', initialPrompt(cfg))
  return args
}

/**
 * Prépare le moteur GPU (whisper-server). Lève une erreur si le moteur GPU n'est pas installé ou
 * ne démarre pas — il n'y a PAS de repli CPU (volontairement retiré : trop lent). Le pipeline
 * affichera alors un message d'erreur.
 */
export async function ensureEngine(cfg: EngineConfig): Promise<Backend> {
  currentCfg = cfg
  if (!existsSync(whisperServerExe())) {
    backend = null
    throw new Error('Moteur GPU non installé — télécharge-le dans les Réglages.')
  }
  await ensureServer(cfg)
  backend = 'gpu'
  currentModel = cfg.modelPath
  return 'gpu'
}

export function activeBackend(): Backend {
  return backend
}

// Sérialise les (re)démarrages du serveur : la préchauffe (preloadModels) et une dictée peuvent
// appeler ensureServer en même temps — sans file, on spawnerait deux serveurs (conflit port 8917)
// ou on retournerait "prêt" pendant que l'autre appel est encore en train de redémarrer.
let serverOp: Promise<void> = Promise.resolve()

function ensureServer(cfg: EngineConfig): Promise<void> {
  const run = serverOp.then(() => doEnsureServer(cfg))
  serverOp = run.catch(() => {}) // la file survit à un échec (le suivant retentera)
  return run
}

async function doEnsureServer(cfg: EngineConfig): Promise<void> {
  const args = serverArgs(cfg)
  const sig = JSON.stringify(args)
  if (server && serverSig === sig) return // déjà lancé avec la même config
  await stopServer()
  const proc = spawn(whisperServerExe(), args, { windowsHide: true, stdio: 'ignore' })
  server = proc
  serverSig = sig
  proc.on('exit', () => {
    // Ne réinitialise le suivi QUE si c'est encore CE processus qu'on suit : l'exit d'un ancien
    // serveur (tué par stopServer juste avant ce spawn) arrive APRÈS — sans ce garde, il
    // orphelinait le nouveau serveur (zombie sur le port 8917, suivi cassé, dictées via un
    // serveur à l'ancienne config).
    if (server === proc) {
      server = null
      serverSig = null
    }
  })
  try {
    await waitForServer()
  } catch (err) {
    // Démarrage raté (crash ou trop long) : on ne laisse pas un process suivi-mais-mort — le
    // prochain appel repartirait sur "déjà lancé" et échouerait au fetch.
    await stopServer()
    throw err
  }
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 240; i++) {
    if (!server) throw new Error('whisper-server (GPU) s’est arrêté au démarrage')
    try {
      const r = await fetch(`http://${HOST}:${PORT}/`)
      if (r.status) return
    } catch {
      /* pas encore prêt */
    }
    await delay(250)
  }
  throw new Error('whisper-server (GPU) trop long à démarrer')
}

async function stopServer(): Promise<void> {
  if (server) {
    try {
      server.kill()
    } catch {
      /* noop */
    }
    server = null
  }
  serverSig = null
}

/**
 * Tue les whisper-server.exe RÉSIDUELS d'une session précédente (crash, fermeture brutale…) qui
 * squattent encore le port 8917 — sinon le serveur relancé ne peut pas se binder et la dictée
 * échoue. Filtré par CHEMIN (uniquement notre dossier whisper-bin) pour ne jamais toucher un
 * process homonyme d'une autre app, et épargne le serveur ÉVENTUELLEMENT déjà relancé par nous
 * (PID suivi). Best-effort, borné : n'empêche jamais le démarrage.
 */
export function killStrayServers(): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve()
    }
    // Chemins/PID passés en VARIABLES D'ENVIRONNEMENT (jamais interpolés) : robuste aux
    // apostrophes dans le chemin et insensible à l'injection (même convention que models.ts).
    const ps =
      `$keep = 0; if ($env:VENTA_KEEP) { $keep = [int]$env:VENTA_KEEP }; ` +
      `Get-CimInstance Win32_Process -Filter "Name='whisper-server.exe'" | ` +
      `Where-Object { $_.ProcessId -ne $keep -and $_.ExecutablePath -and ` +
      `$_.ExecutablePath.StartsWith($env:VENTA_BIN + '\\', [System.StringComparison]::OrdinalIgnoreCase) } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
    try {
      const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        windowsHide: true,
        stdio: 'ignore',
        env: { ...process.env, VENTA_BIN: whisperBinRoot(), VENTA_KEEP: String(server?.pid ?? 0) }
      })
      p.on('exit', finish)
      p.on('error', finish)
      timer = setTimeout(finish, 8000)
    } catch {
      finish()
    }
  })
}

export function isLoaded(): boolean {
  return backend !== null
}

/** Transcrit un PCM Float32 mono 16 kHz -> texte brut (GPU uniquement). */
export async function transcribe(pcm: Float32Array): Promise<string> {
  if (pcm.length < 16000 * 0.25) return '' // < 0,25 s : ignore (appui accidentel)
  try {
    return await transcribeGpu(pcm)
  } catch (err) {
    // Serveur GPU figé ou en erreur : on le TUE (process séparé -> sûr) pour qu'une requête bloquée
    // ne mette pas les dictées suivantes en file derrière elle ; la prochaine en relancera un frais
    // via ensureEngine. Pas de repli CPU : on remonte l'erreur (le pipeline affichera un message).
    await stopServer()
    backend = null
    throw err
  }
}

async function transcribeGpu(pcm: Float32Array): Promise<string> {
  const wav = floatToWav(pcm)
  const form = new FormData()
  form.append('file', new Blob([wav as unknown as BlobPart], { type: 'audio/wav' }), 'audio.wav')
  form.append('response_format', 'text')
  form.append('temperature', '0') // déterministe (langue/seuils gérés au lancement du serveur)

  // Timeout (proportionnel à la durée de l'audio) : si le serveur fige, on abort -> erreur remontée.
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), gpuTimeoutMs(pcm.length))
  try {
    const res = await fetch(`http://${HOST}:${PORT}/inference`, { method: 'POST', body: form, signal: ctl.signal })
    if (!res.ok) throw new Error('inference HTTP ' + res.status)
    return (await res.text()).replace(/\s+/g, ' ').trim()
  } finally {
    clearTimeout(timer)
  }
}

export async function freeWhisper(): Promise<void> {
  await stopServer()
  backend = null
  currentModel = null
  currentCfg = null
}

/**
 * Remet le moteur d'aplomb après un ABANDON (watchdog du pipeline qui a coupé une transcription
 * trop longue). Tue le sidecar GPU figé (process séparé -> sûr). La prochaine dictée réinitialise
 * tout proprement via ensureEngine (backend remis à null).
 */
export async function recoverFromHang(): Promise<void> {
  await stopServer()
  backend = null
  currentModel = null
}

/** Construit un WAV PCM 16-bit mono à partir du Float32. */
function floatToWav(pcm: Float32Array, sampleRate = 16000): Buffer {
  const n = pcm.length
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  let off = 44
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    buf.writeInt16LE(Math.round(s * 32767), off)
    off += 2
  }
  return buf
}
