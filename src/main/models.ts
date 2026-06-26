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
import type { WhisperModelId } from './settings'

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

// ───────────────────────────────── moteur GPU (whisper.cpp CUDA) ──

/** Build CUDA 12.4 de whisper.cpp (runtime cuBLAS inclus, pas besoin du toolkit). */
export const WHISPER_GPU: ModelInfo = {
  id: 'whisper-gpu',
  file: 'whisper-cublas-12.4.0-bin-x64.zip',
  url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-cublas-12.4.0-bin-x64.zip',
  approxBytes: 260_000_000
}

export function whisperBinDir(): string {
  const d = join(app.getPath('userData'), 'whisper-bin')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

export function whisperServerExe(): string {
  return join(whisperBinDir(), 'whisper-server.exe')
}

export function isGpuBinPresent(): boolean {
  return existsSync(whisperServerExe())
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

/** Télécharge + extrait le moteur GPU s'il manque. */
export async function ensureWhisperGpuBin(onProgress: (p: DownloadProgress) => void): Promise<void> {
  if (isGpuBinPresent()) {
    onProgress({ kind: 'whisper-gpu', received: 1, total: 1, percent: 100, done: true })
    return
  }
  const dir = whisperBinDir()
  const zip = join(tmpdir(), WHISPER_GPU.file)
  await downloadTo(WHISPER_GPU.url, zip, 'whisper-gpu', onProgress, WHISPER_GPU.approxBytes)

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
  if (!isGpuBinPresent()) throw new Error('whisper-server.exe introuvable après extraction')
  onProgress({ kind: 'whisper-gpu', received: 1, total: 1, percent: 100, done: true })
}
