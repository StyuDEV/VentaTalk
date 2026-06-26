import Store from 'electron-store'

export type ActivationMode = 'hold' | 'toggle'
export type WhisperModelId = 'base' | 'small' | 'large-v3-turbo' | 'fr-distil-dec16'
export type InjectMode = 'paste' | 'keystroke'
export type WhisperEnginePref = 'auto' | 'cuda' | 'vulkan'

export interface AppSettings {
  /** Nom de la touche (clé de HOTKEY_OPTIONS), ex. "F9". */
  hotkey: string
  /** "hold" = maintenir pour parler ; "toggle" = appuyer pour démarrer/arrêter. */
  activationMode: ActivationMode
  /** "auto" ou code langue ("fr", "en", "es"...). */
  language: string
  whisperModel: WhisperModelId
  /** Utiliser le GPU (whisper.cpp en sidecar) si le moteur GPU est installé. */
  useGpu: boolean
  /** Moteur whisper GPU : 'auto' (détecté selon la carte), 'cuda' (NVIDIA) ou 'vulkan' (AMD/Intel). */
  whisperEngine: WhisperEnginePref
  /** VAD énergie ADAPTATIF côté client (dsp.ts) : coupe le silence aux bords -> anti-hallucination.
   *  (Le VAD du serveur whisper.cpp v1.9.1 est défaillant — ne pas s'y fier.) */
  vadEnabled: boolean
  /** Vocabulaire/noms propres injectés dans l'initial prompt (biais d'orthographe). */
  vocabulary: string
  /** Suppression de bruit du micro (getUserMedia). false = signal plus brut (souvent meilleur WER). */
  noiseSuppression: boolean
  /** Règles de remplacement déterministes "faux=>correct" (une par ligne), post-transcription. */
  replacements: string
  /** Nettoyage IA du texte avant injection. */
  aiCleanup: boolean
  /** "paste" (Ctrl+V, rapide) ou "keystroke" (frappe Unicode, marche dans les terminaux). */
  injectMode: InjectMode
  /** Laisse la dictée dans le presse-papiers après injection (filet anti-perte). */
  keepOnClipboard: boolean
  /** deviceId du micro choisi ('' = micro par défaut). */
  micDeviceId: string
  launchAtLogin: boolean
  soundFeedback: boolean
  /** Coupe le son système (sortie par défaut) pendant la dictée, puis le restaure. */
  muteWhileDictating: boolean
  /** Conserve l'historique des dictées (electron-store séparé). false = rien n'est gardé. */
  keepHistory: boolean
  /** Passe à true une fois l'assistant de 1er lancement terminé (ne se rouvre plus seul). */
  onboardingDone: boolean
  /** Dernière version pour laquelle le changelog a été vu — sert à l'afficher après une MAJ. */
  lastSeenVersion: string
}

const defaults: AppSettings = {
  hotkey: 'F9',
  activationMode: 'hold',
  language: 'fr',
  // Défaut FR fine-tuné (meilleur WER fr, moins d'hallucinations). resolveWhisperModel()
  // retombe sur un autre modèle déjà téléchargé si celui-ci est absent (pas de régression).
  whisperModel: 'fr-distil-dec16',
  useGpu: true,
  whisperEngine: 'auto',
  vadEnabled: true,
  vocabulary: '',
  noiseSuppression: false,
  replacements: '',
  aiCleanup: true,
  injectMode: 'paste',
  // OFF par défaut : on restaure le presse-papiers après collage (moins intrusif). Le filet
  // anti-perte est assuré par l'historique des dictées + « Copier la dernière dictée ».
  keepOnClipboard: false,
  micDeviceId: '',
  launchAtLogin: false,
  soundFeedback: true,
  muteWhileDictating: false,
  keepHistory: true,
  onboardingDone: false,
  lastSeenVersion: ''
}

// Init paresseuse : électron-store a besoin du chemin userData (dispo après import d'app).
let store: Store<AppSettings> | null = null
function db(): Store<AppSettings> {
  if (!store) store = new Store<AppSettings>({ name: 'ventatalk-settings', defaults })
  return store
}

export function getSettings(): AppSettings {
  return { ...defaults, ...db().store }
}

export function getSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return db().get(key, defaults[key]) as AppSettings[K]
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) db().set(k, v as never)
  }
  return getSettings()
}
