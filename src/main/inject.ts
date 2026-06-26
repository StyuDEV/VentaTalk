import { clipboard } from 'electron'
import { keyboard, Key } from '@nut-tree-fork/nut-js'
import type { InjectMode } from './settings'

keyboard.config.autoDelayMs = 0

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Écrit `text` dans l'application qui a le focus.
 *  - "paste"     : sauvegarde le presse-papiers, colle (Ctrl+V), puis restaure
 *                  (ou garde la dictée si `keepOnClipboard`). Rapide, idéal apps GUI.
 *  - "keystroke" : frappe Unicode caractère par caractère (SendInput). Marche dans les terminaux.
 *
 * Avec `keepOnClipboard`, la dictée reste dans le presse-papiers même après injection :
 * filet anti-perte si le collage n'a pas atterri dans un champ.
 */
export async function injectText(text: string, mode: InjectMode, keepOnClipboard: boolean): Promise<void> {
  if (!text) return

  if (mode === 'keystroke') {
    await keyboard.type(text)
    if (keepOnClipboard) clipboard.writeText(text)
    return
  }

  const previous = clipboard.readText()
  clipboard.writeText(text)
  await delay(40)
  await keyboard.pressKey(Key.LeftControl, Key.V)
  await keyboard.releaseKey(Key.LeftControl, Key.V)
  await delay(120)
  // Le presse-papiers contient déjà `text` : on le laisse (keepOnClipboard) ou on restaure.
  if (!keepOnClipboard) clipboard.writeText(previous)
}

/** Annule la dernière dictée injectée : Ctrl+Z (best-effort, dépend de l'app cible). */
export async function undoLastInjection(): Promise<void> {
  await keyboard.pressKey(Key.LeftControl, Key.Z)
  await keyboard.releaseKey(Key.LeftControl, Key.Z)
}
