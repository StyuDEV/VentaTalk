import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

// electron-updater est 100% JS (pas de module natif) → aucun rebuild, compatible avec le
// chemin du hub contenant des espaces. Ne fait quelque chose QUE dans la version installée
// (app.isPackaged) : en dev il n'y a pas d'app-update.yml et checkForUpdates() lèverait.

let updateDownloaded = false
let started = false
// Vrai pendant une vérification déclenchée par l'utilisateur (bouton/menu) : on lui donne un
// retour « à jour » ou « erreur ». La vérif AUTOMATIQUE au démarrage reste silencieuse.
let manualCheck = false
// Vrai quand le téléchargement EN COURS a été lancé par l'utilisateur (clic « Vérifier ») : sert
// à savoir, une fois la MAJ prête, s'il faut lui ouvrir les réglages (il attend) ou rester discret.
let manualDownload = false
// Vrai entre le début du téléchargement et la MAJ prête : permet de réinitialiser le bandeau de
// progression si le téléchargement échoue en cours de route (sinon il reste figé sur « … X % »).
let downloading = false

export interface UpdaterHooks {
  onToast: (message: string) => void
  /**
   * Appelé quand une mise à jour est téléchargée et prête à installer (pour rafraîchir le tray
   * + afficher le bouton in-app). `wasManual` = l'utilisateur l'avait déclenchée via « Vérifier ».
   */
  onUpdateReady: (info: { wasManual: boolean }) => void
  /** Progression du téléchargement (0–100), pour le bandeau in-app. */
  onProgress?: (percent: number) => void
  /** Un téléchargement EN COURS a échoué → réinitialiser le bandeau de progression. */
  onDownloadError?: () => void
}

export function isUpdateReady(): boolean {
  return updateDownloaded
}

/** Branche les événements et lance une vérification silencieuse au démarrage. Idempotent. */
export function initAutoUpdate(hooks: UpdaterHooks): void {
  if (!app.isPackaged || started) return
  started = true

  // Pas de logger : par défaut electron-updater écrit ses logs via `console`, qui partent sur
  // stdout/stderr → ils s'affichent dans le terminal (PowerShell) quand l'app est lancée depuis
  // une console. On coupe complètement pour rester silencieux côté utilisateur.
  autoUpdater.logger = null
  autoUpdater.autoDownload = true
  // Filet : si l'utilisateur quitte sans cliquer « Redémarrer & installer », la MAJ s'applique
  // quand même à la fermeture.
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info: { version?: string }) => {
    // Une MAJ existe : on mémorise si c'est l'utilisateur qui l'a déclenchée (pour lui ouvrir les
    // réglages quand ce sera prêt), puis on rend la main au flux silencieux/téléchargement.
    if (manualCheck) manualDownload = true
    manualCheck = false
    downloading = true // le téléchargement démarre (autoDownload)
    hooks.onToast(`Mise à jour ${info?.version ?? ''} disponible — téléchargement en cours…`)
  })
  autoUpdater.on('update-not-available', () => {
    if (manualCheck) {
      manualCheck = false
      hooks.onToast('VentaTalk est déjà à jour. ✓')
    }
  })
  autoUpdater.on('download-progress', (p: { percent?: number }) => {
    hooks.onProgress?.(Math.max(0, Math.min(100, Math.round(p?.percent ?? 0))))
  })
  autoUpdater.on('update-downloaded', () => {
    updateDownloaded = true
    downloading = false
    const wasManual = manualDownload
    manualDownload = false
    hooks.onUpdateReady({ wasManual })
  })
  autoUpdater.on('error', () => {
    if (downloading) {
      // Un téléchargement était en cours : on réinitialise le bandeau (sinon il reste figé) et on
      // prévient. autoInstallOnAppQuit reste un filet si une MAJ avait déjà été récupérée.
      downloading = false
      manualDownload = false
      hooks.onDownloadError?.()
      hooks.onToast('Téléchargement de la mise à jour interrompu — réessaie plus tard.')
    } else if (manualCheck) {
      // Échec d'une vérification déclenchée par l'utilisateur (souvent : hors-ligne).
      manualCheck = false
      hooks.onToast('Vérification des mises à jour impossible (hors-ligne ?).')
    }
    // Sinon (vérif auto silencieuse échouée) : on reste muet.
  })

  manualCheck = false
  try {
    void autoUpdater.checkForUpdates()
  } catch {
    /* noop */
  }
}

/** Vérification manuelle (bouton réglages / menu tray). Donne TOUJOURS un retour. */
export function checkForUpdates(onToast: (m: string) => void): void {
  if (!app.isPackaged) {
    onToast('Les mises à jour ne sont disponibles que dans la version installée.')
    return
  }
  manualCheck = true
  onToast('Recherche de mises à jour…')
  // Filet : si checkForUpdates ne déclenche aucun event (ex. lève sans 'error'), on évite
  // de rester silencieux — un échec synchrone affiche le message d'erreur.
  try {
    const p = autoUpdater.checkForUpdates()
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        if (manualCheck) {
          manualCheck = false
          onToast('Vérification des mises à jour impossible (hors-ligne ?).')
        }
      })
    }
  } catch {
    manualCheck = false
    onToast('Vérification des mises à jour impossible.')
  }
}

/** Redémarre et installe la mise à jour déjà téléchargée. */
export function quitAndInstall(): void {
  if (!updateDownloaded) return
  try {
    // (isSilent=true, isForceRunAfter=true) : l'installeur NSIS est `oneClick:false` (assisté) ;
    // sans le mode silencieux, quitAndInstall afficherait l'assistant (page de fin à cliquer) au
    // lieu d'un redémarrage transparent. true/true installe en silence (réutilise le dossier
    // existant, install per-user → pas d'UAC) puis relance VentaTalk tout seul.
    autoUpdater.quitAndInstall(true, true)
  } catch {
    /* noop */
  }
}
