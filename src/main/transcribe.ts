import os from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { Whisper, WhisperSamplingStrategy, type TranscribeParams } from 'smart-whisper'
import { whisperServerExe } from './models'

const N_THREADS = Math.max(2, Math.min(os.cpus().length, 8))
const HOST = '127.0.0.1'
const PORT = 8917
// Garde-fou : si le serveur whisper fige, on abandonne le fetch pour basculer en CPU
// (sinon l'app reste coincée en "processing" à vie).
const INFERENCE_TIMEOUT_MS = 20000
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface EngineConfig {
  modelPath: string
  useGpu: boolean
  language: string
  vocabulary: string
}

type Backend = 'gpu' | 'cpu' | null
let backend: Backend = null
let currentModel: string | null = null
let currentCfg: EngineConfig | null = null

// ── moteur GPU : whisper-server (CUDA) en sidecar, modèle gardé en VRAM ──
let server: ChildProcess | null = null
let serverSig: string | null = null

// ── moteur CPU : smart-whisper (repli) ──
let cpu: Whisper | null = null

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

/** Prépare le moteur. GPU (serveur) si demandé + binaire présent, sinon repli CPU. */
export async function ensureEngine(cfg: EngineConfig): Promise<Backend> {
  currentCfg = cfg
  if (cfg.useGpu && existsSync(whisperServerExe())) {
    try {
      await ensureServer(cfg)
      backend = 'gpu'
      currentModel = cfg.modelPath
      return 'gpu'
    } catch {
      await stopServer() // le serveur n'a pas démarré -> repli CPU
    }
  }
  await ensureCpu(cfg.modelPath)
  backend = 'cpu'
  currentModel = cfg.modelPath
  return 'cpu'
}

export function activeBackend(): Backend {
  return backend
}

async function ensureServer(cfg: EngineConfig): Promise<void> {
  const args = serverArgs(cfg)
  const sig = JSON.stringify(args)
  if (server && serverSig === sig) return // déjà lancé avec la même config
  await stopServer()
  server = spawn(whisperServerExe(), args, { windowsHide: true, stdio: 'ignore' })
  server.on('exit', () => {
    server = null
    serverSig = null
  })
  serverSig = sig
  await waitForServer()
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

async function ensureCpu(modelPath: string): Promise<void> {
  if (cpu && currentModel === modelPath) return
  if (cpu) {
    await cpu.free()
    cpu = null
  }
  cpu = new Whisper(modelPath, { gpu: false })
}

export function isLoaded(): boolean {
  return backend !== null
}

/** Transcrit un PCM Float32 mono 16 kHz -> texte brut. */
export async function transcribe(pcm: Float32Array, language: string): Promise<string> {
  if (pcm.length < 16000 * 0.25) return '' // < 0,25 s : ignore (appui accidentel)

  if (backend === 'gpu') {
    try {
      return await transcribeGpu(pcm)
    } catch {
      if (currentModel) await ensureCpu(currentModel)
      backend = 'cpu'
      return transcribeCpu(pcm, language)
    }
  }
  return transcribeCpu(pcm, language)
}

async function transcribeGpu(pcm: Float32Array): Promise<string> {
  const wav = floatToWav(pcm)
  const form = new FormData()
  form.append('file', new Blob([wav as unknown as BlobPart], { type: 'audio/wav' }), 'audio.wav')
  form.append('response_format', 'text')
  form.append('temperature', '0') // déterministe (langue/seuils gérés au lancement du serveur)

  // Timeout : si le serveur fige, on abort -> le catch de transcribe() bascule en CPU.
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), INFERENCE_TIMEOUT_MS)
  try {
    const res = await fetch(`http://${HOST}:${PORT}/inference`, { method: 'POST', body: form, signal: ctl.signal })
    if (!res.ok) throw new Error('inference HTTP ' + res.status)
    return (await res.text()).replace(/\s+/g, ' ').trim()
  } finally {
    clearTimeout(timer)
  }
}

async function transcribeCpu(pcm: Float32Array, language: string): Promise<string> {
  if (!cpu) throw new Error('moteur CPU non chargé')
  const lang = currentCfg?.language || language || 'auto'
  // Repli CPU aligné sur le GPU : même beam search, suppression non-vocale, seuil entropie,
  // prompt (ponctuation + vocabulaire) et plafond de contexte -> qualité homogène en mode dégradé.
  const params: Partial<TranscribeParams> = {
    language: lang && lang !== 'auto' ? lang : 'auto',
    n_threads: N_THREADS,
    strategy: WhisperSamplingStrategy.WHISPER_SAMPLING_BEAM_SEARCH,
    beam_size: 5,
    suppress_non_speech_tokens: true,
    entropy_thold: 2.6,
    temperature: 0,
    n_max_text_ctx: 64,
    initial_prompt: initialPrompt({ language: lang, vocabulary: currentCfg?.vocabulary })
  }
  const task = await cpu.transcribe(pcm, params)
  const segments = await task.result
  return segments
    .map((s) => s.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export async function freeWhisper(): Promise<void> {
  await stopServer()
  if (cpu) {
    await cpu.free()
    cpu = null
  }
  backend = null
  currentModel = null
  currentCfg = null
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
