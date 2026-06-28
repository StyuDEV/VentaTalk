import { uIOhook } from 'uiohook-napi'
import type { ActivationMode } from './settings'
import {
  type Mod,
  type ParsedHotkey,
  MOD_KEYCODES,
  MOD_CODES,
  CODE_TO_NAME,
  parseHotkey,
  isComboActive,
  activeMods,
  buildHotkeyString
} from './hotkey-combo'

export interface HotkeyHandlers {
  onStart: () => void
  onStop: () => void
  /** Raccourci d'annulation pressé : annule la dictée en cours (no-op si rien en cours, géré côté index.ts). */
  onCancel?: () => void
}

interface KeyEvent {
  keycode: number
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

// Ensemble des touches RÉELLEMENT enfoncées (modificateurs inclus, par keycode).
const pressed = new Set<number>()

let required: ParsedHotkey = parseHotkey('F9')
// Raccourci d'annulation (configurable). Défaut Échap. Détecté sur le front montant (une fois par appui).
let cancelRequired: ParsedHotkey = parseHotkey('Escape')
let cancelWasActive = false
let handlers: HotkeyHandlers | null = null
let mode: ActivationMode = 'hold'
let started = false
let wasActive = false
let toggleOn = false

/**
 * Auto-réparation : si le flag d'un modificateur est à false, on purge ses keycodes
 * (au cas où un keyup aurait été avalé par Windows, ex. switch de clavier Alt+Shift).
 */
function reconcile(e: KeyEvent): void {
  if (!e.ctrlKey) for (const c of MOD_KEYCODES.Ctrl) pressed.delete(c)
  if (!e.altKey) for (const c of MOD_KEYCODES.Alt) pressed.delete(c)
  if (!e.shiftKey) for (const c of MOD_KEYCODES.Shift) pressed.delete(c)
  if (!e.metaKey) for (const c of MOD_KEYCODES.Win) pressed.delete(c)
}

export function setHotkey(str: string): void {
  const parsed = parseHotkey(str)
  if (parsed.mods.length || parsed.keys.length) {
    required = parsed
    wasActive = false
    toggleOn = false
  }
}

/** Définit le raccourci d'annulation de la dictée en cours (combo, ex. "Escape", "Ctrl+Q"). */
export function setCancelHotkey(str: string): void {
  const parsed = parseHotkey(str)
  if (parsed.mods.length || parsed.keys.length) {
    cancelRequired = parsed
    cancelWasActive = false
  }
}

export function setActivationMode(m: ActivationMode): void {
  mode = m
  wasActive = false
  toggleOn = false
}

function evaluate(): void {
  const now = isComboActive(required, pressed)
  if (now && !wasActive) {
    wasActive = true
    if (mode === 'hold') handlers?.onStart()
    else {
      toggleOn = !toggleOn
      if (toggleOn) handlers?.onStart()
      else handlers?.onStop()
    }
  } else if (!now && wasActive) {
    wasActive = false
    if (mode === 'hold') handlers?.onStop()
  }
}

// ── capture d'une combinaison personnalisée ──
let captureMode = false
let capturePeak: { mods: Mod[]; key: number | null } | null = null
let captureResolve: ((s: string | null) => void) | null = null
let captureTimer: ReturnType<typeof setTimeout> | null = null

function snapshot(): { mods: Mod[]; key: number | null } {
  const mods = activeMods(pressed)
  let key: number | null = null
  for (const c of pressed) {
    if (!MOD_CODES.has(c) && CODE_TO_NAME[c] != null) {
      key = c
      break
    }
  }
  return { mods, key }
}
function comboSize(s: { mods: Mod[]; key: number | null }): number {
  return s.mods.length + (s.key != null ? 1 : 0)
}

/** Capture la prochaine combinaison tapée et renvoie sa représentation ("Alt+Shift"). */
export function captureHotkey(): Promise<string | null> {
  return new Promise((resolve) => {
    captureMode = true
    capturePeak = null
    captureResolve = resolve
    if (captureTimer) clearTimeout(captureTimer)
    captureTimer = setTimeout(() => finishCapture(), 8000)
  })
}

function finishCapture(): void {
  captureMode = false
  if (captureTimer) {
    clearTimeout(captureTimer)
    captureTimer = null
  }
  const peak = capturePeak
  capturePeak = null
  let str: string | null = null
  if (peak && comboSize(peak) > 0) str = buildHotkeyString(peak.mods, peak.key)
  wasActive = false
  toggleOn = false
  const r = captureResolve
  captureResolve = null
  r?.(str)
}

/** Cœur du traitement d'un événement clavier (exporté pour les tests). */
export function handleKeyEvent(type: 'keydown' | 'keyup', e: KeyEvent): void {
  if (type === 'keydown') pressed.add(e.keycode)
  else pressed.delete(e.keycode)
  reconcile(e)

  if (captureMode) {
    if (type === 'keydown') {
      const snap = snapshot()
      if (!capturePeak || comboSize(snap) >= comboSize(capturePeak)) capturePeak = snap
    } else if (capturePeak && comboSize(capturePeak) > 0) {
      finishCapture()
    }
    return
  }
  // Raccourci d'annulation -> demande d'annulation de la dictée en cours (index.ts ignore si idle).
  evaluateCancel()
  evaluate()
}

/** Front montant du raccourci d'annulation : déclenche onCancel une seule fois par appui. */
function evaluateCancel(): void {
  const now = isComboActive(cancelRequired, pressed)
  if (now && !cancelWasActive) {
    cancelWasActive = true
    handlers?.onCancel?.()
  } else if (!now && cancelWasActive) {
    cancelWasActive = false
  }
}

/**
 * Remet à zéro l'état d'activation (utilisé après une annulation Échap). En mode "toggle", évite
 * que la prochaine pression du raccourci compte comme un "off" (la dictée a déjà été coupée) ; en
 * mode "hold", force un nouvel appui propre.
 */
export function resetActivation(): void {
  wasActive = false
  toggleOn = false
}

export function startHotkey(h: HotkeyHandlers): void {
  handlers = h
  uIOhook.on('keydown', (e) => handleKeyEvent('keydown', e))
  uIOhook.on('keyup', (e) => handleKeyEvent('keyup', e))
  uIOhook.start()
  started = true
}

export function stopHotkey(): void {
  if (!started) return
  try {
    uIOhook.stop()
  } catch {
    /* noop */
  }
  started = false
}

// ── helpers de test (n'affectent pas le runtime de prod) ──
export function __setHandlers(h: HotkeyHandlers | null): void {
  handlers = h
}
export function __reset(): void {
  pressed.clear()
  wasActive = false
  toggleOn = false
  cancelWasActive = false
  captureMode = false
  capturePeak = null
  captureResolve = null
  if (captureTimer) {
    clearTimeout(captureTimer)
    captureTimer = null
  }
}
