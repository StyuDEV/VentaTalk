import { app, BrowserWindow, ipcMain, screen, session, clipboard, Notification } from 'electron'
import { join, dirname } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'

import {
  getSettings,
  getSetting,
  setSettings,
  type ActivationMode,
  type WhisperModelId,
  type AppSettings
} from './settings'
import {
  startHotkey,
  stopHotkey,
  setHotkey,
  setCancelHotkey,
  setActivationMode,
  captureHotkey,
  resetActivation
} from './hotkey'
import { createTray, rebuildTrayMenu, destroyTray } from './tray'
import {
  WHISPER_MODELS,
  LLM_MODEL,
  whisperModelPath,
  llmModelPath,
  isPresent,
  isGpuBinPresent,
  ensureWhisperGpuBin,
  resolveWhisperEngine,
  detectGpuVendor,
  downloadModel,
  cleanupPartials,
  type DownloadProgress
} from './models'
import {
  ensureEngine,
  transcribe,
  freeWhisper,
  recoverFromHang,
  killStrayServers,
  type EngineConfig
} from './transcribe'
import { ensureLlm, cleanup, freeLlm } from './cleanup'
import { applyReplacements } from './replacements'
import { stripDisfluencies } from './disfluencies'
import { injectText, undoLastInjection } from './inject'
import { configureSysAudioMute, muteSystemAudio, unmuteSystemAudio, disposeSysAudio } from './sysaudio'
import { appIcon, resourcePath } from './resources'
import { addHistory, getHistory, deleteHistory, clearHistory } from './history'
import { initAutoUpdate, isUpdateReady, checkForUpdates, quitAndInstall } from './updater'
import { changelogFor, allChangelogs } from './changelog'
import { log } from './log'

interface ChangelogPayload {
  version: string
  changes: string[]
}
// Changelog à montrer au prochain affichage des réglages (après une MAJ). Consommé une fois.
let pendingChangelog: ChangelogPayload | null = null

let lastTranscript = ''
let muteArmed = false // l'option "couper le son" est active pour la dictée en cours
let muteApplied = false // on a réellement coupé le son système (à restaurer)

function playSound(kind: 'start' | 'done' | 'error'): void {
  if (getSetting('soundFeedback')) sendOverlay('sound', kind)
}

/** Rétablit le son système si on l'avait coupé (idempotent, sûr à appeler plusieurs fois). */
function restoreSystemAudio(): void {
  muteArmed = false
  if (muteApplied) {
    muteApplied = false
    unmuteSystemAudio()
  }
}

// Ordre de préférence quand le modèle choisi n'est pas téléchargé (FR d'abord, langue par défaut).
const MODEL_PREFERENCE: WhisperModelId[] = ['fr-distil-dec16', 'large-v3-turbo', 'small', 'base']

/** Modèle effectivement utilisable : le choix de l'utilisateur s'il est présent, sinon le
 *  meilleur modèle déjà téléchargé. Évite de bloquer la dictée si le défaut n'est pas là. */
function resolveWhisperModel(s: AppSettings): WhisperModelId | null {
  if (isPresent(WHISPER_MODELS[s.whisperModel])) return s.whisperModel
  for (const id of MODEL_PREFERENCE) {
    if (isPresent(WHISPER_MODELS[id])) return id
  }
  return null
}

function engineConfig(): EngineConfig {
  const s = getSettings()
  const model = resolveWhisperModel(s) ?? s.whisperModel
  return {
    modelPath: whisperModelPath(model),
    language: s.language,
    vocabulary: s.vocabulary
  }
}

const RENDERER_URL = process.env['ELECTRON_RENDERER_URL']

let overlayWin: BrowserWindow | null = null
let settingsWin: BrowserWindow | null = null
let overlayHideTimer: ReturnType<typeof setTimeout> | null = null
// Bannière d'erreur à l'écran : tant que ce timer tourne, la fenêtre overlay reste affichée (le toast
// gère lui-même son masquage) et hideOverlay ne la cache pas prématurément.
let overlayToastTimer: ReturnType<typeof setTimeout> | null = null
const OVERLAY_TOAST_MS = 2700
let isQuitting = false

type PipelineState = 'idle' | 'recording' | 'processing'
let state: PipelineState = 'idle'
// Génération de dictée : incrémentée à chaque début ET à chaque annulation (Échap). runPipeline
// capture sa génération au départ et abandonne si elle a changé entre-temps (dictée annulée).
let dictationGen = 0
// Filet : après le relâchement, on attend l'audio de l'overlay. S'il n'arrive JAMAIS (renderer
// overlay planté, exception dans finalize…), on ne reste pas coincé en "processing" à vie.
let audioWaitTimer: ReturnType<typeof setTimeout> | null = null
const AUDIO_WAIT_MS = 12000
function clearAudioWait(): void {
  if (audioWaitTimer) {
    clearTimeout(audioWaitTimer)
    audioWaitTimer = null
  }
}
// Durée de MAINTIEN de la touche (mesurée au relâchement). Sert à distinguer un vrai essai de dictée
// d'un appui accidentel quand la transcription ne rend aucun texte — la longueur de l'audio ne suffit
// pas (le VAD réduit le silence à zéro, donc on ne saurait pas que l'utilisateur a tenu la touche).
let recordStartAt = 0
let lastRecordMs = 0
// Une MAJ est devenue prête pendant une dictée : on amènera l'écran de MAJ au premier plan dès que
// le pipeline revient à l'idle (pour ne pas voler le focus de l'app cible en pleine dictée).
let pendingUpdateReveal = false
// L'écran plein de MAJ a déjà été amené au premier plan pour ce téléchargement (one-shot).
let updateScreenShown = false

// ───────────────────────────────────────────────────────────── windows ──

function loadPage(win: BrowserWindow, page: 'overlay' | 'settings'): void {
  if (RENDERER_URL) {
    win.loadURL(`${RENDERER_URL}/${page}/index.html`)
  } else {
    win.loadFile(join(__dirname, `../renderer/${page}/index.html`))
  }
}

function createOverlayWindow(): void {
  overlayWin = new BrowserWindow({
    width: 340,
    height: 150, // grande fenêtre transparente : laisse la place à l'animation (montée) + au halo
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false, // ne vole jamais le focus de l'app cible
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true, // le preload n'utilise que contextBridge/ipcRenderer -> compatible sandbox
      contextIsolation: true
    }
  })
  overlayWin.setAlwaysOnTop(true, 'screen-saver')
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlayWin.setIgnoreMouseEvents(true) // purement informatif -> clic-traversant (la grande zone ne bloque rien)
  loadPage(overlayWin, 'overlay')
}

function positionOverlay(): void {
  if (!overlayWin) return
  const { workArea } = screen.getPrimaryDisplay()
  const [w, h] = overlayWin.getSize()
  const x = Math.round(workArea.x + (workArea.width - w) / 2)
  // Bas de la fenêtre au bas de l'écran (au-dessus de la barre des tâches) : la pilule
  // semble jaillir du bord inférieur. Le repos est à 26 px du bord (cf. CSS bottom:26px).
  const y = Math.round(workArea.y + workArea.height - h)
  overlayWin.setPosition(x, y)
}

function showOverlay(): void {
  if (!overlayWin) return
  if (overlayHideTimer) {
    clearTimeout(overlayHideTimer)
    overlayHideTimer = null
  }
  if (overlayToastTimer) {
    // une dictée démarre pendant qu'un toast d'erreur s'affichait : on annule son masquage différé
    clearTimeout(overlayToastTimer)
    overlayToastTimer = null
  }
  positionOverlay()
  overlayWin.showInactive() // affiche SANS prendre le focus
}

function hideOverlay(): void {
  if (!overlayWin) return
  if (overlayToastTimer) return // un toast d'erreur est à l'écran : il gère lui-même son masquage
  // L'animation de sortie est jouée par l'overlay sur l'event state 'idle' ; on masque
  // réellement la fenêtre une fois la descente terminée (~240 ms).
  if (overlayHideTimer) clearTimeout(overlayHideTimer)
  overlayHideTimer = setTimeout(() => {
    overlayWin?.hide()
    overlayHideTimer = null
  }, 260)
}

/**
 * Bannière d'erreur À L'ÉCRAN (sous le curseur), via la fenêtre overlay : une pilule façon Dynamic
 * Island, un peu plus large, avec le message. Visible où l'utilisateur travaille (pas seulement dans
 * les Réglages). Miroir in-app (toast) si la fenêtre Réglages est ouverte.
 */
function overlayToast(message: string): void {
  settingsWin?.webContents.send('toast', message) // miroir si la fenêtre Réglages est ouverte
  if (!overlayWin) return
  if (overlayHideTimer) {
    clearTimeout(overlayHideTimer)
    overlayHideTimer = null
  }
  if (overlayToastTimer) clearTimeout(overlayToastTimer)
  positionOverlay()
  overlayWin.showInactive()
  sendOverlay('overlay:toast', message)
  // garde la fenêtre affichée le temps du toast (entrée + maintien + sortie ~240 ms), puis masque.
  overlayToastTimer = setTimeout(() => {
    overlayToastTimer = null
    overlayWin?.hide()
  }, OVERLAY_TOAST_MS)
}

function sendOverlay(channel: string, payload?: unknown): void {
  overlayWin?.webContents.send(channel, payload)
}

function createSettingsWindow(): void {
  settingsWin = new BrowserWindow({
    width: 900,
    height: 660,
    minWidth: 780,
    minHeight: 560,
    show: false,
    title: 'VentaTalk — Réglages',
    icon: appIcon(),
    autoHideMenuBar: true,
    resizable: true,
    backgroundColor: '#0a0b12', // évite le flash blanc au chargement (= --ink)
    // Barre de titre custom : on masque la barre native et on habille les contrôles
    // (min/agrandir/fermer) Windows à notre palette. La zone de drag est définie en CSS
    // (.titlebar, -webkit-app-region: drag). Conserve resize + Snap Layouts natifs.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0a0b12', symbolColor: '#9499bd', height: 36 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true, // le preload n'utilise que contextBridge/ipcRenderer -> compatible sandbox
      contextIsolation: true
    }
  })
  loadPage(settingsWin, 'settings')
  // (re)joue les animations d'entrée à chaque affichage (la fenêtre est créée cachée :
  // sans ça, les animations se jouent une fois pendant qu'elle est invisible).
  settingsWin.on('show', () => settingsWin?.webContents.send('settings:shown'))
  settingsWin.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      settingsWin?.hide()
    }
  })
}

function openSettings(): void {
  if (!settingsWin) createSettingsWindow()
  settingsWin?.show()
  settingsWin?.focus()
}

function toast(message: string, opts?: { onClick?: () => void }): void {
  settingsWin?.webContents.send('toast', message)
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title: 'VentaTalk', body: message })
      if (opts?.onClick) n.on('click', opts.onClick)
      n.show()
    }
  } catch {
    /* noop */
  }
}

// ─────────────────────────────────────────────────────── pipeline vocal ──

// Watchdog : sentinelle renvoyée quand une étape dépasse son budget de temps. Filet ultime contre
// un serveur GPU figé / une transcription qui s'éternise — sans ça, l'app resterait coincée en
// "processing" à vie (le bug "ça tourne en boucle à l'infini").
const TIMEOUT = Symbol('timeout')
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let t: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    t = setTimeout(() => resolve(TIMEOUT), ms)
  })
  const guarded = p.then(
    (v) => {
      if (t) clearTimeout(t)
      return v
    },
    (e) => {
      if (t) clearTimeout(t)
      throw e
    }
  )
  // Empêche un rejet TARDIF du perdant (tâche orpheline qui échoue APRÈS le timeout — ex. le serveur
  // GPU tué par recoverFromHang fait échouer son fetch encore en vol) de devenir un unhandledRejection.
  void guarded.catch(() => {})
  return Promise.race([guarded, timeout])
}
// Filet ultime de la transcription : au-delà on abandonne et on rend la main. PROPORTIONNEL à la
// durée (large) pour ne JAMAIS couper une transcription qui progresse — en usage normal (GPU) une
// dictée revient en quelques secondes ; ce délai ne sert que si le repli CPU s'éternise vraiment
// sur un très long passage (audio non annulable). Plancher 2 min, plafond 6 min.
function transcribeWatchdogMs(samples: number, sampleRate = 16000): number {
  const seconds = samples / sampleRate
  return Math.min(360000, Math.max(120000, Math.round(seconds * 2000) + 90000))
}
// La dictée au curseur n'a pas vocation à durer très longtemps : au-delà on tronque (la qualité de
// Whisper se dégrade et le CPU s'éternise). 300 s = 5 min — large pour un usage normal.
const MAX_AUDIO_SAMPLES = 16000 * 300

function onRecordStart(): void {
  if (state !== 'idle') return
  const s = getSettings()
  if (!resolveWhisperModel(s)) {
    toast('Modèle de transcription manquant — télécharge-le dans les Réglages.')
    openSettings()
    return
  }
  if (!isGpuBinPresent()) {
    // Transcription 100 % GPU : sans moteur GPU installé, on ne peut rien faire (plus de repli CPU).
    toast('Moteur GPU manquant — installe-le dans les Réglages.')
    openSettings()
    return
  }
  dictationGen++ // nouvelle dictée (toute génération antérieure devient obsolète)
  recordStartAt = Date.now()
  state = 'recording'
  showOverlay()
  sendOverlay('record:start')
  sendOverlay('state', 'recording')
  playSound('start')
  if (s.muteWhileDictating) {
    // Coupe le son système APRÈS le début du son "écoute" (sinon on le couperait aussi), et
    // seulement si on écoute toujours. Rétabli au relâchement (onRecordStop), avant le son "confirme".
    // 700 ms : laisse entendre l'attaque du son sans trop retarder la coupure du son externe.
    muteArmed = true
    const delayMs = s.soundFeedback ? 700 : 0
    setTimeout(() => {
      if (muteArmed && state === 'recording') {
        muteApplied = true
        void muteSystemAudio()
      }
    }, delayMs)
  }
}

function onRecordStop(): void {
  if (state !== 'recording') return
  lastRecordMs = Date.now() - recordStartAt
  state = 'processing'
  restoreSystemAudio() // rétablit le son système avant de jouer le son de fermeture
  // Son de fermeture (MP3 inversé) IMMÉDIAT au relâchement — pas après la transcription/IA
  // (sinon il arrive avec un décalage bizarre).
  playSound('done')
  sendOverlay('state', 'processing')
  sendOverlay('record:stop') // l'overlay renverra ensuite 'audio:data'
  // Garde-fou : si 'audio:data' n'arrive jamais (overlay planté/exception), on rend la main.
  clearAudioWait()
  audioWaitTimer = setTimeout(() => {
    audioWaitTimer = null
    if (state !== 'processing') return
    log.warn('onRecordStop: aucun audio reçu après le relâchement — récupération forcée')
    dictationGen++ // un audio tardif éventuel sera ignoré (state revenu à idle)
    playSound('error')
    overlayToast('Problème micro — réessaie')
    restoreSystemAudio()
    state = 'idle'
    sendOverlay('state', 'idle')
  }, AUDIO_WAIT_MS)
}

/**
 * Annule la dictée en cours (touche Échap). Coupe la capture si on enregistrait, et invalide le
 * pipeline si on était déjà en traitement (via dictationGen). Rend l'app à l'état idle proprement.
 */
function cancelDictation(): void {
  if (state === 'idle') return
  dictationGen++ // invalide tout runPipeline en cours (il abandonnera avant d'injecter)
  clearAudioWait()
  muteArmed = false
  restoreSystemAudio()
  // Pas de son ici : l'annulation est volontaire (un buzzer d'erreur induirait en erreur) ;
  // la sortie visuelle de la barre (overlay -> idle) sert de retour.
  resetActivation() // évite qu'un toggle reste "armé" après l'annulation
  sendOverlay('record:cancel') // l'overlay stoppe la capture SANS renvoyer l'audio
  state = 'idle'
  hideOverlay()
  sendOverlay('state', 'idle')
}

async function runPipeline(pcm: Float32Array): Promise<void> {
  if (state !== 'processing') return
  const gen = dictationGen // capture la génération : si elle change, la dictée a été annulée
  const s = getSettings()
  // Borne la durée : un audio très long fait s'éterniser la transcription (surtout en repli CPU).
  let pcmIn = pcm
  if (pcmIn.length > MAX_AUDIO_SAMPLES) {
    pcmIn = pcmIn.subarray(0, MAX_AUDIO_SAMPLES)
    toast('Dictée très longue : tronquée à 5 min pour rester fiable.')
  }
  try {
    await ensureEngine(engineConfig())
    const transcribed = await withTimeout(transcribe(pcmIn), transcribeWatchdogMs(pcmIn.length))
    if (gen !== dictationGen) return // annulée pendant la transcription
    if (transcribed === TIMEOUT) {
      // La transcription ne rend pas la main (repli CPU non annulable sur un audio très long) : on
      // abandonne pour ne JAMAIS rester coincé en "processing". On invalide la tâche orpheline (pas
      // d'injection tardive si elle finit plus tard), on remet le moteur d'aplomb et on rend la main.
      dictationGen++
      void recoverFromHang()
      playSound('error')
      overlayToast('Trop long — abandonné')
      restoreSystemAudio()
      state = 'idle'
      sendOverlay('state', 'idle')
      return
    }
    let text = transcribed

    // Passe déterministe : retire euh/hum/bégaiements MÊME sans LLM (texte propre par défaut).
    if (text) text = stripDisfluencies(text)

    // Dictionnaire couche 2 : remplacements déterministes avant le LLM.
    if (text) text = applyReplacements(text, s.replacements)

    if (s.aiCleanup && text) {
      try {
        if (isPresent(LLM_MODEL)) {
          await ensureLlm(llmModelPath())
          text = await cleanup(text, s.vocabulary)
          // Dictionnaire autoritaire : on réapplique APRÈS le LLM (qui a pu re-casser un terme).
          text = applyReplacements(text, s.replacements)
        }
      } catch (e) {
        log.warn('nettoyage LLM échoué (texte brut conservé)', e)
      }
    }
    if (gen !== dictationGen) return // annulée pendant le nettoyage LLM

    if (text) {
      lastTranscript = text
      try {
        await injectText(text, s.injectMode, s.keepOnClipboard)
      } catch (e) {
        // Injection refusée (fenêtre admin/élevée, RDP, jeu plein écran…) : le texte est SAUVÉ dans le
        // presse-papiers (inject.ts ne restaure pas en cas d'échec) → collable à la main. On ne ment pas
        // avec « Erreur de transcription » : la transcription a réussi, c'est l'écriture qui a échoué.
        log.warn('injection échouée', e)
        clipboard.writeText(text)
        playSound('error')
        overlayToast('Texte non inséré — colle avec Ctrl+V')
      }
      // Historique enregistré MÊME si l'injection a échoué (le texte n'est pas perdu).
      if (s.keepHistory) {
        addHistory(text, resolveWhisperModel(s) ?? s.whisperModel)
        settingsWin?.webContents.send('history:changed') // rafraîchit la liste si la fenêtre est ouverte
      }
      rebuildTrayMenu() // active "Copier / Annuler la dernière dictée" + sous-menu "Récent"
      // (pas de son ici : le son de fermeture a déjà été joué au relâchement ;
      //  l'overlay reste visible "Transcription…" puis sort à l'état idle dans finally)
    } else {
      // Aucun texte produit. On se base sur la DURÉE DE MAINTIEN de la touche (pas sur la longueur de
      // l'audio, que le VAD a pu réduire à zéro sur du silence) : si l'utilisateur a tenu la touche un
      // temps réel (> 0,8 s), on le SIGNALE — sinon (appui accidentel court) on reste silencieux.
      if (lastRecordMs > 800) {
        playSound('error')
        overlayToast('Rien entendu — parle plus fort')
      }
    }
  } catch (err) {
    if (gen !== dictationGen) return // annulée : on ne signale pas l'erreur
    log.warn('pipeline: erreur de transcription', err)
    playSound('error')
    overlayToast('Erreur de transcription')
  } finally {
    // Si la dictée a été annulée entre-temps, cancelDictation a déjà tout remis à idle : ne pas
    // ré-toucher l'état (une nouvelle dictée a peut-être déjà démarré).
    if (gen === dictationGen) {
      restoreSystemAudio() // filet : normalement déjà rétabli au record:stop
      state = 'idle'
      hideOverlay()
      sendOverlay('state', 'idle')
      if (pendingUpdateReveal) {
        // Une MAJ est devenue prête pendant cette dictée : on la montre maintenant (in-app).
        pendingUpdateReveal = false
        openSettings()
      }
    }
  }
}

// ───────────────────────────────────────────────────── application des réglages ──

function applySettings(): void {
  const s = getSettings()
  setHotkey(s.hotkey)
  setCancelHotkey(s.cancelHotkey)
  setActivationMode(s.activationMode)
  app.setLoginItemSettings({ openAtLogin: s.launchAtLogin })
  // (Pré)chauffe ou met en veille le sidecar de coupure du son système selon le réglage.
  void configureSysAudioMute(s.muteWhileDictating)
}

function preloadModels(): void {
  const s = getSettings()
  if (resolveWhisperModel(s)) {
    // précharge / (re)configure le moteur : relance le serveur GPU si la config a changé
    // (modèle, langue, VAD, vocabulaire) et met le modèle en VRAM.
    ensureEngine(engineConfig()).catch(() => {})
  }
  if (s.aiCleanup && isPresent(LLM_MODEL)) {
    ensureLlm(llmModelPath()).catch(() => {})
  }
}

// ───────────────────────────────────────────────────────────────── IPC ──

function registerIpc(): void {
  ipcMain.on('audio:data', (_e, data: Float32Array | ArrayBuffer | number[]) => {
    clearAudioWait() // l'audio est arrivé : on désarme le filet de onRecordStop
    let pcm: Float32Array
    if (data instanceof Float32Array) pcm = data
    else if (data instanceof ArrayBuffer) pcm = new Float32Array(data)
    else pcm = Float32Array.from(data as number[])
    void runPipeline(pcm)
  })

  ipcMain.handle('settings:get', () => getSettings())

  ipcMain.handle('settings:set', (_e, patch) => {
    const s = setSettings(patch)
    applySettings()
    rebuildTrayMenu()
    // reconfigure le moteur : relance le serveur si langue/VAD/vocabulaire/modèle ont changé,
    // (pré)charge le LLM si nécessaire. ensureEngine est idempotent si rien n'a bougé.
    preloadModels()
    // ré-init de la captation si le micro ou la réduction de bruit ont changé
    if (patch && ('micDeviceId' in patch || 'noiseSuppression' in patch)) {
      overlayWin?.webContents.send('audio:reinit')
    }
    return s
  })

  ipcMain.handle('hotkey:capture', () => captureHotkey())

  ipcMain.handle('models:status', () => ({
    whisper: (Object.keys(WHISPER_MODELS) as WhisperModelId[]).map((id) => ({
      id,
      file: WHISPER_MODELS[id].file,
      approxBytes: WHISPER_MODELS[id].approxBytes,
      present: isPresent(WHISPER_MODELS[id])
    })),
    llm: {
      id: LLM_MODEL.id,
      file: LLM_MODEL.file,
      approxBytes: LLM_MODEL.approxBytes,
      present: isPresent(LLM_MODEL)
    },
    gpu: { present: isGpuBinPresent(), engine: resolveWhisperEngine(), vendor: detectGpuVendor() },
    // Modèle whisper RÉELLEMENT utilisé (le choix s'il est présent, sinon le repli) : permet à l'UI
    // de prévenir quand le modèle choisi est absent et qu'un autre tourne à sa place.
    resolved: resolveWhisperModel(getSettings())
  }))

  ipcMain.handle('models:download', async (_e, kind: string) => {
    const send = (p: DownloadProgress) => settingsWin?.webContents.send('models:progress', p)
    try {
      if (kind === 'whisper-gpu') await ensureWhisperGpuBin(send)
      else if (kind === 'llm') await downloadModel(LLM_MODEL, 'llm', send)
      else await downloadModel(WHISPER_MODELS[kind as WhisperModelId], kind, send)
      preloadModels()
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('téléchargement échoué', kind, err)
      send({ kind, received: 0, total: 0, percent: 0, done: true, error: message })
      return { ok: false, error: message }
    }
  })

  ipcMain.handle('app:openSettings', () => openSettings())
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('app:isPackaged', () => app.isPackaged)
  // Désinstallation COMPLÈTE : app + modèles + moteur GPU + historique + réglages. Irréversible.
  // La confirmation est désormais INTERNE (modal in-app côté renderer) : plus de pop-up native ici.
  // Renvoie 'dev' si non packagé (le renderer l'affiche dans le modal), sinon désinstalle puis quitte.
  ipcMain.handle('app:uninstall', async () => {
    if (!app.isPackaged) return 'dev'
    isQuitting = true
    // Libère moteurs/modèles pour relâcher les verrous de fichiers avant suppression.
    try {
      await freeWhisper()
    } catch {
      /* noop */
    }
    try {
      await freeLlm()
    } catch {
      /* noop */
    }
    const installDir = dirname(app.getPath('exe'))
    const userData = app.getPath('userData') // %APPDATA%/ventatalk : modèles, moteur GPU, historique, réglages
    const updaterCache = join(process.env.LOCALAPPDATA || '', 'ventatalk-updater')
    let uninstaller: string | null = null
    try {
      const f = readdirSync(installDir).find((n) => /uninstall.*\.exe$/i.test(n))
      uninstaller = f ? join(installDir, f) : null
    } catch {
      /* noop */
    }
    // Script détaché : attend la fermeture de l'app (2 s), supprime données + cache, puis lance le
    // désinstalleur NSIS en silence (retire l'app de Program Files + le registre + les raccourcis).
    // Chemins passés en VARIABLES D'ENVIRONNEMENT (jamais interpolés dans la commande) : robuste aux
    // apostrophes dans le nom d'utilisateur (C:\Users\O'Brien\…) et insensible à l'injection PowerShell.
    const ps =
      `Start-Sleep -Seconds 2; ` +
      `$p = @($env:VENTA_USERDATA, $env:VENTA_UPDATER) | Where-Object { $_ }; ` +
      `if ($p) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }; ` +
      `if ($env:VENTA_UNINST) { Start-Process -FilePath $env:VENTA_UNINST -ArgumentList '/S' -Wait -ErrorAction SilentlyContinue }`
    try {
      spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          VENTA_USERDATA: userData,
          VENTA_UPDATER: updaterCache,
          VENTA_UNINST: uninstaller || ''
        }
      }).unref()
    } catch {
      /* noop */
    }
    app.quit()
  })
  ipcMain.handle('app:checkUpdate', () => checkForUpdates(toast))
  ipcMain.handle('update:isReady', () => isUpdateReady())
  ipcMain.handle('update:install', () => {
    isQuitting = true
    quitAndInstall() // quitte, installe la MAJ téléchargée, puis relance
  })
  // Changelog à afficher après une MAJ (consommé une fois), null sinon.
  ipcMain.handle('changelog:get', () => {
    const c = pendingChangelog
    pendingChangelog = null
    return c
  })
  // Notes de la version courante, à la demande (bouton « Notes de version »).
  ipcMain.handle('changelog:current', () => {
    const v = app.getVersion()
    const changes = changelogFor(v)
    return changes ? { version: v, changes } : null
  })
  // Historique complet des notes de version (toutes les anciennes versions).
  ipcMain.handle('changelog:all', () => allChangelogs())

  // Octets du son d'enregistrement (resources/record.mp3) -> l'overlay le décode et le joue
  // (et en joue la version inversée pour la confirmation). Lu côté main pour marcher en build.
  ipcMain.handle('sound:get', () => {
    try {
      return readFileSync(resourcePath('record.mp3')).toString('base64')
    } catch {
      return null
    }
  })

  // ── historique des dictées ──
  ipcMain.handle('history:get', () => getHistory())
  ipcMain.handle('history:delete', (_e, id: string) => deleteHistory(id))
  ipcMain.handle('history:clear', () => {
    clearHistory()
    return true
  })
  ipcMain.handle('history:copy', (_e, text: string) => {
    if (text) {
      clipboard.writeText(text)
      toast('Dictée copiée dans le presse-papiers.')
    }
  })
  // Réinjection best-effort : on masque la fenêtre de réglages pour rendre le focus à
  // l'application précédemment active, puis on injecte (comme l'undo, ça dépend de l'app cible).
  ipcMain.handle('history:reinject', async (_e, text: string) => {
    if (!text) return
    const s = getSettings()
    settingsWin?.hide()
    await new Promise((r) => setTimeout(r, 350)) // laisse l'OS restaurer le focus précédent
    await injectText(text, s.injectMode, s.keepOnClipboard)
  })
}

// ─────────────────────────────────────────────────────────── lifecycle ──

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => openSettings())

  // Défense en profondeur : nos pages sont 100 % locales — aucune raison d'ouvrir une nouvelle
  // fenêtre ni de naviguer ailleurs (une éventuelle XSS ne pourrait ni ouvrir ni rediriger quoi
  // que ce soit). On tolère localhost pour le serveur de dev electron-vite (HMR).
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith('file://') && !url.startsWith('http://localhost')) event.preventDefault()
    })
  })

  app.whenReady().then(() => {
    log.install(app.getVersion()) // journal persistant + capture des rejets/exceptions non gérés
    cleanupPartials() // purge les .part orphelins d'un téléchargement interrompu (jusqu'à ~2 Go)
    // autorise le micro pour nos fenêtres
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
      cb(permission === 'media')
    )
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')

    createOverlayWindow()
    createSettingsWindow()

    createTray({
      openSettings,
      quit: () => {
        isQuitting = true
        app.quit()
      },
      onActivationModeChange: (mode: ActivationMode) => setActivationMode(mode),
      hasLastTranscript: () => lastTranscript.length > 0,
      copyLast: () => {
        if (lastTranscript) {
          clipboard.writeText(lastTranscript)
          toast('Dernière dictée copiée dans le presse-papiers.')
        }
      },
      undoLast: () => void undoLastInjection(),
      recentHistory: () => getHistory(),
      copyText: (text: string) => {
        clipboard.writeText(text)
        toast('Dictée copiée dans le presse-papiers.')
      },
      updateReady: () => isUpdateReady(),
      installUpdate: () => {
        isQuitting = true
        quitAndInstall()
      },
      checkUpdate: () => checkForUpdates(toast)
    })

    applySettings()
    startHotkey({ onStart: onRecordStart, onStop: onRecordStop, onCancel: cancelDictation })
    registerIpc()

    // Auto-update silencieux (uniquement en version installée ; no-op en dev).
    initAutoUpdate({
      onToast: toast,
      onProgress: (percent) => {
        settingsWin?.webContents.send('update:progress', percent)
        // Dès le début du téléchargement, on bascule l'app en mode « mise à jour » plein écran
        // (si aucune dictée en cours — sinon on ne vole pas le focus de l'app cible).
        if (!updateScreenShown && state === 'idle') {
          updateScreenShown = true
          openSettings()
        }
      },
      onDownloadError: () => {
        updateScreenShown = false
        settingsWin?.webContents.send('update:failed')
      },
      onUpdateReady: () => {
        rebuildTrayMenu()
        settingsWin?.webContents.send('update:ready') // écran plein « prête à installer »
        if (state === 'idle') {
          // TOUT reste dans l'app : on amène l'écran de MAJ au premier plan (aucune pop-up
          // externe, aucune fenêtre « à côté »). L'install se fait en silence via le bouton.
          openSettings()
        } else {
          // Dictée en cours : on ne vole pas le focus. On ouvrira dès le retour à l'idle.
          pendingUpdateReveal = true
        }
      }
    })

    // 1er lancement : ouvre les réglages → le renderer affiche l'assistant d'onboarding.
    // Si un modèle est déjà présent (utilisateur existant qui met à jour), on neutralise
    // l'assistant en silence pour ne pas le rouvrir inutilement.
    if (!getSetting('onboardingDone')) {
      if (resolveWhisperModel(getSettings())) setSettings({ onboardingDone: true })
      else openSettings()
    }

    // Changelog post-MAJ : si la version a changé depuis la dernière vue ET que ce n'est pas une
    // toute 1re install (utilisateur déjà configuré), on montre les nouveautés au prochain affichage.
    const curVersion = app.getVersion()
    const lastSeen = getSetting('lastSeenVersion')
    const changes = changelogFor(curVersion)
    if (changes && lastSeen !== curVersion && (lastSeen !== '' || getSetting('onboardingDone'))) {
      pendingChangelog = { version: curVersion, changes }
      openSettings()
    }
    setSettings({ lastSeenVersion: curVersion })

    // Tue d'abord les whisper-server résiduels d'une session précédente (port 8917 squatté après
    // un crash), PUIS précharge — sinon le nouveau serveur ne peut pas se binder. Si une dictée a
    // déjà relancé un serveur entre-temps, killStrayServers épargne son PID (suivi).
    setTimeout(() => {
      void killStrayServers().then(preloadModels)
    }, 1500)
  })

  app.on('window-all-closed', () => {
    // on reste en arrière-plan dans la zone de notification
  })

  app.on('before-quit', () => {
    isQuitting = true
    stopHotkey()
    void freeWhisper()
    void freeLlm()
    disposeSysAudio() // restaure le son système + arrête le sidecar
    destroyTray()
  })
}
