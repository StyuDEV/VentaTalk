import { app } from 'electron'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync,
  readdirSync,
  rmSync,
  copyFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { getSetting, type WhisperModelId } from './settings'

export interface ModelInfo {
  id: string
  file: string
  url: string
  /** Taille approx. en octets (pour l'UI ; la vraie taille vient de content-length). */
  approxBytes: number
}

const HF = 'https://huggingface.co'

export const WHISPER_MODELS: Record<WhisperModelId, ModelInfo> = {
  base: {
    id: 'base',
    file: 'ggml-base.bin',
    url: `${HF}/ggerganov/whisper.cpp/resolve/main/ggml-base.bin`,
    approxBytes: 147_951_465
  },
  small: {
    id: 'small',
    file: 'ggml-small.bin',
    url: `${HF}/ggerganov/whisper.cpp/resolve/main/ggml-small.bin`,
    approxBytes: 487_601_967
  },
  'large-v3-turbo': {
    id: 'large-v3-turbo',
    file: 'ggml-large-v3-turbo.bin',
    url: `${HF}/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin`,
    approxBytes: 1_624_555_275
  },
  // Modèle fine-tuné FRANÇAIS (bofenghuang) en ggml q5_0 — meilleur WER fr, moins d'hallucinations.
  'fr-distil-dec16': {
    id: 'fr-distil-dec16',
    file: 'ggml-fr-distil-dec16-q5_0.bin',
    url: `${HF}/bofenghuang/whisper-large-v3-french-distil-dec16/resolve/main/ggml-model-q5_0.bin`,
    approxBytes: 791_000_000
  }
}

export const LLM_MODEL: ModelInfo = {
  id: 'qwen2.5-3b-instruct',
  file: 'Qwen2.5-3B-Instruct-Q4_K_M.gguf',
  url: `${HF}/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf`,
  approxBytes: 2_018_918_016
}

export function modelsDir(): string {
  const dir = join(app.getPath('userData'), 'models')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function whisperModelPath(id: WhisperModelId): string {
  return join(modelsDir(), WHISPER_MODELS[id].file)
}

export function llmModelPath(): string {
  return join(modelsDir(), LLM_MODEL.file)
}

export function isPresent(info: ModelInfo): boolean {
  const p = join(modelsDir(), info.file)
  // Le téléchargement écrit dans un .part puis renomme : un fichier présent est complet.
  // Le seuil (100 ko) ne sert qu'à rejeter un fichier vide/corrompu, et reste compatible
  // avec le petit modèle VAD (~885 ko).
  return existsSync(p) && statSync(p).size > 100_000
}

export interface DownloadProgress {
  kind: string
  received: number
  total: number
  percent: number
  done: boolean
  error?: string
}

/**
 * Télécharge un modèle (whisper ou LLM) en streaming vers un fichier .part,
 * puis renomme. `onProgress` est appelé régulièrement.
 */
export async function downloadModel(
  info: ModelInfo,
  kind: string,
  onProgress: (p: DownloadProgress) => void
): Promise<void> {
  const dest = join(modelsDir(), info.file)
  const tmp = `${dest}.part`

  if (isPresent(info)) {
    onProgress({ kind, received: info.approxBytes, total: info.approxBytes, percent: 100, done: true })
    return
  }

  const res = await fetch(info.url, { redirect: 'follow' })
  if (!res.ok || !res.body) {
    throw new Error(`Téléchargement échoué (${res.status}) pour ${info.url}`)
  }

  const total = Number(res.headers.get('content-length')) || info.approxBytes
  let received = 0
  let lastEmit = 0

  const fileStream = createWriteStream(tmp)
  const nodeStream = Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0])

  await new Promise<void>((resolve, reject) => {
    nodeStream.on('data', (chunk: Buffer) => {
      received += chunk.length
      const now = Date.now()
      if (now - lastEmit > 150) {
        lastEmit = now
        onProgress({
          kind,
          received,
          total,
          percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0,
          done: false
        })
      }
    })
    nodeStream.on('error', reject)
    fileStream.on('error', reject)
    fileStream.on('finish', () => resolve())
    nodeStream.pipe(fileStream)
  })

  renameSync(tmp, dest)
  onProgress({ kind, received: total, total, percent: 100, done: true })
}

export function cleanupPartial(info: ModelInfo): void {
  const tmp = join(modelsDir(), `${info.file}.part`)
  if (existsSync(tmp)) {
    try {
      unlinkSync(tmp)
    } catch {
      /* noop */
    }
  }
}

// ─────────────────────── moteurs GPU whisper (auto-détectés selon la carte) ──
// NVIDIA → CUDA (le plus rapide) ; AMD/Intel (ou inconnu) → Vulkan (universel, via le pilote
// système). Repli CPU = smart-whisper (cf. transcribe.ts) si aucun moteur GPU n'est présent.

export type WhisperEngine = 'cuda' | 'vulkan'
export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'none'

interface EngineInfo extends ModelInfo {
  subfolder: string
}

export const WHISPER_ENGINES: Record<WhisperEngine, EngineInfo> = {
  cuda: {
    id: 'whisper-cuda',
    subfolder: 'cuda',
    file: 'whisper-cublas-12.4.0-bin-x64.zip',
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-cublas-12.4.0-bin-x64.zip',
    approxBytes: 260_000_000
  },
  vulkan: {
    id: 'whisper-vulkan',
    subfolder: 'vulkan',
    // Construit en CI sur le repo (.github/workflows/build-whisper-vulkan.yml) — léger (~20-60 Mo),
    // utilise le pilote Vulkan du système (AMD / Intel / NVIDIA). Tag de release : whisper-vulkan-v1.
    file: 'whisper-vulkan-bin-x64.zip',
    url: 'https://github.com/StyuDEV/VentaTalk/releases/download/whisper-vulkan-v1/whisper-vulkan-bin-x64.zip',
    approxBytes: 60_000_000
  }
}

let cachedVendor: GpuVendor | null = null
/** Fabricant du GPU via Win32_VideoController (mis en cache : le matériel ne change pas au runtime). */
export function detectGpuVendor(): GpuVendor {
  if (cachedVendor) return cachedVendor
  let names = ''
  try {
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_VideoController).Name -join "|"'],
      { windowsHide: true, encoding: 'utf8', timeout: 5000 }
    )
    names = (r.stdout || '').toLowerCase()
  } catch {
    /* noop */
  }
  cachedVendor = /nvidia|geforce|\brtx\b|\bgtx\b|quadro/.test(names)
    ? 'nvidia'
    : /amd|radeon|\bati\b/.test(names)
      ? 'amd'
      : /intel|\barc\b|iris|hd graphics|\buhd\b/.test(names)
        ? 'intel'
        : 'none'
  return cachedVendor
}

/**
 * Moteur whisper à utiliser. Réglage `whisperEngine` : 'cuda'/'vulkan' forcent ; 'auto' (défaut)
 * choisit selon le GPU détecté (NVIDIA → CUDA, tout le reste → Vulkan).
 */
export function resolveWhisperEngine(): WhisperEngine {
  const pref = getSetting('whisperEngine')
  if (pref === 'cuda' || pref === 'vulkan') return pref
  return detectGpuVendor() === 'nvidia' ? 'cuda' : 'vulkan'
}

const whisperBinRoot = (): string => join(app.getPath('userData'), 'whisper-bin')

// Migration : les anciennes installs ont whisper-server.exe À PLAT dans whisper-bin/ (moteur CUDA).
// On le déplace UNE fois dans whisper-bin/cuda/ pour éviter de re-télécharger ~646 Mo.
let migratedLegacy = false
function migrateLegacyBin(): void {
  if (migratedLegacy) return
  migratedLegacy = true
  const root = whisperBinRoot()
  if (existsSync(join(root, 'whisper-server.exe')) && !existsSync(join(root, 'cuda', 'whisper-server.exe'))) {
    try {
      mkdirSync(join(root, 'cuda'), { recursive: true })
      for (const name of readdirSync(root)) {
        const p = join(root, name)
        if (statSync(p).isDirectory()) continue // ne pas toucher aux sous-dossiers cuda/ vulkan/
        renameSync(p, join(root, 'cuda', name))
      }
    } catch {
      /* noop : au pire, re-téléchargement */
    }
  }
}

export function whisperBinDir(engine: WhisperEngine = resolveWhisperEngine()): string {
  const d = join(whisperBinRoot(), WHISPER_ENGINES[engine].subfolder)
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

export function whisperServerExe(engine: WhisperEngine = resolveWhisperEngine()): string {
  migrateLegacyBin()
  return join(whisperBinDir(engine), 'whisper-server.exe')
}

export function isGpuBinPresent(engine: WhisperEngine = resolveWhisperEngine()): boolean {
  return existsSync(whisperServerExe(engine))
}

/** Stream un URL vers un fichier avec progression. */
async function downloadTo(
  url: string,
  dest: string,
  kind: string,
  onProgress: (p: DownloadProgress) => void,
  approx: number
): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`Téléchargement échoué (${res.status})`)
  const total = Number(res.headers.get('content-length')) || approx
  let received = 0
  let lastEmit = 0
  const fileStream = createWriteStream(dest)
  const nodeStream = Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0])
  await new Promise<void>((resolve, reject) => {
    nodeStream.on('data', (chunk: Buffer) => {
      received += chunk.length
      const now = Date.now()
      if (now - lastEmit > 150) {
        lastEmit = now
        onProgress({
          kind,
          received,
          total,
          percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0,
          done: false
        })
      }
    })
    nodeStream.on('error', reject)
    fileStream.on('error', reject)
    fileStream.on('finish', () => resolve())
    nodeStream.pipe(fileStream)
  })
}

/** Met whisper-server.exe + ses DLLs à plat dans whisperBinDir (gère un éventuel sous-dossier). */
function flattenBin(dir: string): void {
  if (existsSync(join(dir, 'whisper-server.exe'))) return
  for (const name of readdirSync(dir)) {
    const sub = join(dir, name)
    if (statSync(sub).isDirectory() && existsSync(join(sub, 'whisper-server.exe'))) {
      for (const f of readdirSync(sub)) copyFileSync(join(sub, f), join(dir, f))
      rmSync(sub, { recursive: true, force: true })
      return
    }
  }
}

/** Télécharge + extrait le moteur GPU adapté à la carte (CUDA pour NVIDIA, sinon Vulkan). */
export async function ensureWhisperGpuBin(onProgress: (p: DownloadProgress) => void): Promise<void> {
  const engine = resolveWhisperEngine()
  if (isGpuBinPresent(engine)) {
    onProgress({ kind: 'whisper-gpu', received: 1, total: 1, percent: 100, done: true })
    return
  }
  const info = WHISPER_ENGINES[engine]
  const dir = whisperBinDir(engine)
  const zip = join(tmpdir(), info.file)
  await downloadTo(info.url, zip, 'whisper-gpu', onProgress, info.approxBytes)

  const res = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`],
    { windowsHide: true }
  )
  if (res.status !== 0) throw new Error('Extraction du moteur GPU échouée')
  flattenBin(dir)
  try {
    unlinkSync(zip)
  } catch {
    /* noop */
  }
  if (!isGpuBinPresent(engine)) throw new Error('whisper-server.exe introuvable après extraction')
  onProgress({ kind: 'whisper-gpu', received: 1, total: 1, percent: 100, done: true })
}
