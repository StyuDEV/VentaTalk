// Journal persistant (process MAIN) : écrit dans %APPDATA%/ventatalk/logs/main.log.
// But : pouvoir diagnostiquer un souci chez un ami (« ça écrit rien ») sans reproduire.
// Le logging ne doit JAMAIS planter l'app : tout est try/catch et silencieux en cas d'échec.
import { app } from 'electron'
import { appendFileSync, mkdirSync, statSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'

let logFile: string | null = null
let ready = false
const MAX_BYTES = 1_000_000 // ~1 Mo -> rotation simple (on archive l'ancien en main.old.log)

function init(): void {
  if (ready) return
  ready = true
  try {
    const dir = app.getPath('logs') // %APPDATA%/<app>/logs (créé au besoin)
    mkdirSync(dir, { recursive: true })
    logFile = join(dir, 'main.log')
    if (existsSync(logFile) && statSync(logFile).size > MAX_BYTES) {
      try {
        renameSync(logFile, join(dir, 'main.old.log'))
      } catch {
        /* noop */
      }
    }
  } catch {
    logFile = null
  }
}

function fmt(a: unknown): string {
  if (a instanceof Error) return a.stack || a.message
  if (typeof a === 'string') return a
  try {
    return JSON.stringify(a)
  } catch {
    return String(a)
  }
}

function write(level: string, args: unknown[]): void {
  if (!ready) init()
  if (!logFile) return
  try {
    appendFileSync(logFile, `[${new Date().toISOString()}] [${level}] ${args.map(fmt).join(' ')}\n`)
  } catch {
    /* le logging ne doit jamais faire planter l'app */
  }
}

export const log = {
  info: (...a: unknown[]): void => write('INFO', a),
  warn: (...a: unknown[]): void => write('WARN', a),
  error: (...a: unknown[]): void => write('ERROR', a),
  /** À appeler une fois au démarrage : trace le lancement + branche les rejets/exceptions non gérés. */
  install(version: string): void {
    init()
    write('INFO', [`──────── VentaTalk ${version} démarré ────────`])
    process.on('unhandledRejection', (r) => write('ERROR', ['unhandledRejection', r]))
    process.on('uncaughtException', (e) => write('ERROR', ['uncaughtException', e]))
  }
}
