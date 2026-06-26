// Logique PURE des raccourcis (parsing, matching, sérialisation), sans état ni
// écoute d'événements -> testable en isolation. hotkey.ts gère l'état clavier.
//
// On suit les modificateurs par KEYCODE réel (pas par les flags d'événement, qui
// peuvent rester « bloqués » quand Windows intercepte une combinaison comme
// Alt+Shift pour changer de clavier). Les flags servent uniquement à corriger
// (auto-réparation : un flag à false purge le keycode resté coincé).
import { UiohookKey } from 'uiohook-napi'

export type Mod = 'Ctrl' | 'Alt' | 'Shift' | 'Win'
export const MOD_ORDER: Mod[] = ['Ctrl', 'Alt', 'Shift', 'Win']

const K = UiohookKey as unknown as Record<string, number>
const codes = (...names: string[]): number[] =>
  names.map((n) => K[n]).filter((c): c is number => typeof c === 'number')

/** Keycodes (gauche + droite) de chaque modificateur générique. */
export const MOD_KEYCODES: Record<Mod, number[]> = {
  Ctrl: codes('Ctrl', 'CtrlRight'),
  Alt: codes('Alt', 'AltRight'),
  Shift: codes('Shift', 'ShiftRight'),
  Win: codes('Meta', 'MetaRight')
}
export const MOD_CODES = new Set<number>(Object.values(MOD_KEYCODES).flat())

export const NAME_TO_CODE: Record<string, number> = {}
export const CODE_TO_NAME: Record<number, string> = {}
{
  const names: string[] = [
    'Space', 'CapsLock', 'Tab', 'Enter', 'Escape', 'Backquote', 'BracketLeft', 'BracketRight',
    'Semicolon', 'Quote', 'Comma', 'Period', 'Slash', 'Backslash', 'Minus', 'Equal',
    'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'
  ]
  for (let i = 1; i <= 24; i++) names.push('F' + i)
  for (let c = 65; c <= 90; c++) names.push(String.fromCharCode(c)) // A..Z
  for (let d = 0; d <= 9; d++) names.push(String(d)) // 0..9
  for (let n = 0; n <= 9; n++) names.push('Numpad' + n)
  for (const name of names) {
    const code = K[name]
    if (typeof code === 'number') {
      NAME_TO_CODE[name] = code
      if (!(code in CODE_TO_NAME)) CODE_TO_NAME[code] = name
    }
  }
}

export interface ParsedHotkey {
  mods: Mod[]
  keys: number[]
}

/** "Alt+Shift", "Ctrl+Space", "F9" -> modificateurs + keycodes. */
export function parseHotkey(str: string): ParsedHotkey {
  const mods: Mod[] = []
  const keys: number[] = []
  for (const raw of (str || '').split('+')) {
    const part = raw.trim()
    if (!part) continue
    if ((MOD_ORDER as string[]).includes(part)) {
      if (!mods.includes(part as Mod)) mods.push(part as Mod)
    } else if (part === 'RightAlt') {
      if (!mods.includes('Alt')) mods.push('Alt')
    } else if (part === 'RightControl') {
      if (!mods.includes('Ctrl')) mods.push('Ctrl')
    } else if (part === 'RightShift') {
      if (!mods.includes('Shift')) mods.push('Shift')
    } else if (NAME_TO_CODE[part] != null) {
      keys.push(NAME_TO_CODE[part])
    }
  }
  return { mods, keys }
}

export function isModDown(m: Mod, pressed: Set<number>): boolean {
  return MOD_KEYCODES[m].some((c) => pressed.has(c))
}

/** La combinaison est-elle entièrement tenue, vu les touches réellement enfoncées ? */
export function isComboActive(required: ParsedHotkey, pressed: Set<number>): boolean {
  if (required.mods.length === 0 && required.keys.length === 0) return false
  for (const m of required.mods) if (!isModDown(m, pressed)) return false
  for (const k of required.keys) if (!pressed.has(k)) return false
  return true
}

/** Modificateurs actifs (dans l'ordre canonique) d'après les touches enfoncées. */
export function activeMods(pressed: Set<number>): Mod[] {
  return MOD_ORDER.filter((m) => isModDown(m, pressed))
}

/** Modificateurs + touche capturés -> chaîne normalisée ("Alt+Shift"). */
export function buildHotkeyString(mods: Mod[], key: number | null): string {
  const parts: string[] = MOD_ORDER.filter((m) => mods.includes(m))
  if (key != null && CODE_TO_NAME[key]) parts.push(CODE_TO_NAME[key])
  return parts.join('+')
}
