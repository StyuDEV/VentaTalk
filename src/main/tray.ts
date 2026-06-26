import { Tray, Menu, app } from 'electron'
import { trayIcon } from './resources'
import { getSettings, setSettings, type ActivationMode } from './settings'
import type { HistoryItem } from './history'

export interface TrayCallbacks {
  openSettings: () => void
  quit: () => void
  onActivationModeChange: (mode: ActivationMode) => void
  hasLastTranscript: () => boolean
  copyLast: () => void
  undoLast: () => void
  /** Dictées récentes (les plus récentes en tête) pour le sous-menu "Récent". */
  recentHistory: () => HistoryItem[]
  /** Copie un texte dans le presse-papiers. */
  copyText: (text: string) => void
  /** Une mise à jour est téléchargée et prête à installer. */
  updateReady: () => boolean
  /** Redémarre pour installer la mise à jour. */
  installUpdate: () => void
  /** Vérification manuelle des mises à jour. */
  checkUpdate: () => void
}

let tray: Tray | null = null
let callbacks: TrayCallbacks | null = null

export function createTray(cb: TrayCallbacks): Tray {
  callbacks = cb
  tray = new Tray(trayIcon())
  tray.setToolTip('VentaTalk — dictée vocale')
  tray.on('click', () => cb.openSettings())
  rebuildTrayMenu()
  return tray
}

/** Abrège un texte pour l'afficher comme libellé de menu (une ligne). */
function menuLabel(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 48 ? oneLine.slice(0, 47) + '…' : oneLine
}

export function rebuildTrayMenu(): void {
  if (!tray || !callbacks) return
  const cb = callbacks
  const s = getSettings()
  const recent = cb.recentHistory().slice(0, 5)
  const updateItems: Electron.MenuItemConstructorOptions[] = cb.updateReady()
    ? [
        { type: 'separator' },
        { label: '⟳ Redémarrer pour installer la mise à jour', click: () => cb.installUpdate() }
      ]
    : []
  const menu = Menu.buildFromTemplate([
    { label: `VentaTalk  ·  ${s.hotkey} pour parler`, enabled: false },
    ...updateItems,
    { type: 'separator' },
    { label: 'Réglages…', click: () => cb.openSettings() },
    {
      label: "Mode d'activation",
      submenu: [
        {
          label: 'Maintenir pour parler',
          type: 'radio',
          checked: s.activationMode === 'hold',
          click: () => {
            setSettings({ activationMode: 'hold' })
            cb.onActivationModeChange('hold')
            rebuildTrayMenu()
          }
        },
        {
          label: 'Appuyer pour démarrer / arrêter',
          type: 'radio',
          checked: s.activationMode === 'toggle',
          click: () => {
            setSettings({ activationMode: 'toggle' })
            cb.onActivationModeChange('toggle')
            rebuildTrayMenu()
          }
        }
      ]
    },
    { type: 'separator' },
    {
      label: 'Copier la dernière dictée',
      enabled: cb.hasLastTranscript(),
      click: () => cb.copyLast()
    },
    {
      label: 'Annuler la dernière dictée',
      enabled: cb.hasLastTranscript(),
      click: () => cb.undoLast()
    },
    {
      label: 'Récent',
      enabled: recent.length > 0,
      submenu:
        recent.length > 0
          ? recent.map((it) => ({
              label: menuLabel(it.text),
              toolTip: 'Copier dans le presse-papiers',
              click: () => cb.copyText(it.text)
            }))
          : [{ label: '(aucune dictée)', enabled: false }]
    },
    { type: 'separator' },
    { label: 'Vérifier les mises à jour…', click: () => cb.checkUpdate() },
    { label: 'Quitter VentaTalk', click: () => cb.quit() }
  ])
  tray.setContextMenu(menu)
  tray.setToolTip(`VentaTalk — ${s.activationMode === 'hold' ? 'maintenir' : 'appuyer'} ${s.hotkey}`)
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}

// utilisé pour garder une référence d'app si besoin futur
export const _appRef = app
