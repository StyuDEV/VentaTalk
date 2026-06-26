import Store from 'electron-store'

/** Une dictée passée, conservée pour relecture / recopie / réinjection. */
export interface HistoryItem {
  /** Identifiant stable (timestamp + séquence) — sert de clé pour supprimer/réinjecter. */
  id: string
  /** Texte final injecté (après nettoyage). */
  text: string
  /** Date de création (epoch ms). */
  at: number
  /** Modèle Whisper effectivement utilisé. */
  model: string
}

interface HistoryDb {
  items: HistoryItem[]
}

// Borne LRU : on garde les N dernières dictées (les plus récentes en tête).
const LIMIT = 30

// Store dédié (séparé de ventatalk-settings) : l'historique peut contenir des données
// sensibles, on le purge indépendamment des réglages.
let store: Store<HistoryDb> | null = null
let seq = 0

function db(): Store<HistoryDb> {
  if (!store) store = new Store<HistoryDb>({ name: 'ventatalk-history', defaults: { items: [] } })
  return store
}

export function getHistory(): HistoryItem[] {
  return db().get('items', [])
}

/** Ajoute une dictée en tête, borne à LIMIT. Le caller décide d'appeler (gate keepHistory). */
export function addHistory(text: string, model: string): void {
  const trimmed = text.trim()
  if (!trimmed) return
  const item: HistoryItem = { id: `${Date.now()}-${seq++}`, text: trimmed, at: Date.now(), model }
  const items = [item, ...getHistory()].slice(0, LIMIT)
  db().set('items', items)
}

/** Supprime une entrée par id, retourne la liste restante. */
export function deleteHistory(id: string): HistoryItem[] {
  const items = getHistory().filter((it) => it.id !== id)
  db().set('items', items)
  return items
}

export function clearHistory(): void {
  db().set('items', [])
}
