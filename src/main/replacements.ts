/**
 * Applique des règles de remplacement déterministes "faux=>correct" (une par ligne),
 * en mots entiers et insensible à la casse. C'est la 2e couche du dictionnaire (la 1re
 * étant le biais initial_prompt côté Whisper) : fiable pour les erreurs récurrentes.
 *
 * Exemple de `rules` :
 *   quoine=>Qwen
 *   ventatalk=>VentaTalk
 *   git hub=>GitHub
 */
export function applyReplacements(text: string, rules: string): string {
  if (!text || !rules || !rules.trim()) return text
  let out = text
  for (const line of rules.split(/\r?\n/)) {
    const idx = line.indexOf('=>')
    if (idx < 0) continue
    const from = line.slice(0, idx).trim()
    const to = line.slice(idx + 2).trim()
    if (!from) continue
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    try {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${esc})(?=[^\\p{L}\\p{N}]|$)`, 'giu')
      out = out.replace(re, (_m, pre) => pre + to)
    } catch {
      // repli si \p{} non supporté
      const re = new RegExp(`\\b${esc}\\b`, 'gi')
      out = out.replace(re, to)
    }
  }
  return out
}
