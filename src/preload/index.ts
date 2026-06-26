import { contextBridge, ipcRenderer } from 'electron'

/** Une dictée passée (miroir de main/history.ts — découplé exprès du process main). */
export interface HistoryItem {
  id: string
  text: string
  at: number
  model: string
}

export interface VentaApi {
  // ── overlay (capture audio) ──
  onRecordStart: (cb: () => void) => void
  onRecordStop: (cb: () => void) => void
  /** Dictée annulée (Échap) : stopper la capture SANS renvoyer l'audio. */
  onRecordCancel: (cb: () => void) => void
  onState: (cb: (state: 'idle' | 'recording' | 'processing') => void) => void
  onSound: (cb: (kind: 'start' | 'done' | 'error') => void) => void
  onReinitAudio: (cb: () => void) => void
  sendAudio: (pcm: Float32Array) => void

  // ── réglages ──
  getSettings: () => Promise<any>
  setSettings: (patch: Record<string, unknown>) => Promise<any>
  captureHotkey: () => Promise<string | null>
  modelsStatus: () => Promise<any>
  downloadModel: (kind: string) => Promise<{ ok: boolean; error?: string }>
  onModelProgress: (cb: (p: any) => void) => void
  onToast: (cb: (message: string) => void) => void
  /** Émis quand la fenêtre de réglages devient visible (pour rejouer les animations d'entrée). */
  onSettingsShown: (cb: () => void) => void
  /** Émis quand l'historique change (nouvelle dictée) → rafraîchir la liste si ouverte. */
  onHistoryChanged: (cb: () => void) => void
  openSettings: () => Promise<void>
  /** Octets (base64) du son d'enregistrement (resources/record.mp3), ou null si absent. */
  getRecordSound: () => Promise<string | null>

  /** Version de l'app (package.json). */
  getVersion: () => Promise<string>
  /** Vrai si l'app est packagée (build installé) — sert à masquer les outils de dev. */
  isPackaged: () => Promise<boolean>
  /** Désinstalle l'app + supprime modèles/données. Confirmation INTERNE côté renderer.
   *  Renvoie 'dev' si non packagé (rien n'est supprimé) ; sinon l'app quitte. */
  uninstall: () => Promise<'dev' | void>
  /** Déclenche une vérification de mise à jour (no-op hors version installée). */
  checkUpdate: () => Promise<void>
  /** Une mise à jour est téléchargée et prête à installer. */
  isUpdateReady: () => Promise<boolean>
  /** Installe la mise à jour téléchargée et redémarre l'app. */
  installUpdate: () => Promise<void>
  /** Émis quand une mise à jour devient prête (affiche le bandeau). */
  onUpdateReady: (cb: () => void) => void
  /** Émis pendant le téléchargement d'une mise à jour (0–100), pour la progression du bandeau. */
  onUpdateProgress: (cb: (percent: number) => void) => void
  /** Émis quand un téléchargement de mise à jour échoue → réinitialiser le bandeau. */
  onUpdateFailed: (cb: () => void) => void
  /** Changelog à afficher après une MAJ (consommé une fois), ou null. */
  changelogGet: () => Promise<{ version: string; changes: string[] } | null>
  /** Notes de la version courante, à la demande. */
  changelogCurrent: () => Promise<{ version: string; changes: string[] } | null>
  /** Historique complet des notes de version (toutes les anciennes versions). */
  changelogAll: () => Promise<{ version: string; changes: string[] }[]>

  // ── historique des dictées ──
  historyGet: () => Promise<HistoryItem[]>
  historyDelete: (id: string) => Promise<HistoryItem[]>
  historyClear: () => Promise<void>
  /** Copie un texte dans le presse-papiers (toujours sûr). */
  historyCopy: (text: string) => Promise<void>
  /** Réinjecte un texte dans l'app précédemment active (best-effort : masque les réglages d'abord). */
  historyReinject: (text: string) => Promise<void>
}

const api: VentaApi = {
  onRecordStart: (cb) => ipcRenderer.on('record:start', () => cb()),
  onRecordStop: (cb) => ipcRenderer.on('record:stop', () => cb()),
  onRecordCancel: (cb) => ipcRenderer.on('record:cancel', () => cb()),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onSound: (cb) => ipcRenderer.on('sound', (_e, k) => cb(k)),
  onReinitAudio: (cb) => ipcRenderer.on('audio:reinit', () => cb()),
  sendAudio: (pcm) => ipcRenderer.send('audio:data', pcm),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  captureHotkey: () => ipcRenderer.invoke('hotkey:capture'),
  modelsStatus: () => ipcRenderer.invoke('models:status'),
  downloadModel: (kind) => ipcRenderer.invoke('models:download', kind),
  onModelProgress: (cb) => ipcRenderer.on('models:progress', (_e, p) => cb(p)),
  onToast: (cb) => ipcRenderer.on('toast', (_e, m) => cb(m)),
  onSettingsShown: (cb) => ipcRenderer.on('settings:shown', () => cb()),
  onHistoryChanged: (cb) => ipcRenderer.on('history:changed', () => cb()),
  openSettings: () => ipcRenderer.invoke('app:openSettings'),
  getRecordSound: () => ipcRenderer.invoke('sound:get'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  isPackaged: () => ipcRenderer.invoke('app:isPackaged'),
  uninstall: () => ipcRenderer.invoke('app:uninstall'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  isUpdateReady: () => ipcRenderer.invoke('update:isReady'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateReady: (cb) => ipcRenderer.on('update:ready', () => cb()),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, p) => cb(p)),
  onUpdateFailed: (cb) => ipcRenderer.on('update:failed', () => cb()),
  changelogGet: () => ipcRenderer.invoke('changelog:get'),
  changelogCurrent: () => ipcRenderer.invoke('changelog:current'),
  changelogAll: () => ipcRenderer.invoke('changelog:all'),

  historyGet: () => ipcRenderer.invoke('history:get'),
  historyDelete: (id) => ipcRenderer.invoke('history:delete', id),
  historyClear: () => ipcRenderer.invoke('history:clear'),
  historyCopy: (text) => ipcRenderer.invoke('history:copy', text),
  historyReinject: (text) => ipcRenderer.invoke('history:reinject', text)
}

contextBridge.exposeInMainWorld('venta', api)
