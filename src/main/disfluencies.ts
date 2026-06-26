/**
 * Nettoyage déterministe des disfluences orales FR — logique PURE (testable hors Electron,
 * comme replacements.ts / hotkey-combo.ts). Tourne dans le pipeline AVANT le LLM, donc le
 * texte injecté reste propre MÊME si le nettoyage IA est désactivé ou le LLM absent.
 *
 * Volontairement conservateur : on ne retire que des hésitations non ambiguës et on ne réduit
 * que les bégaiements de petits mots-outils — on ne touche jamais au sens (les reprises
 * « 14h non 16h » sont laissées au LLM, qui a le contexte).
 */

// Hésitations PURES à retirer quand elles forment un mot isolé (du plus long au plus court).
// On NE retire PAS « bah/ben/beh » : ce sont des marqueurs de registre familier (fidélité au parler).
const FILLERS = ['euheuh', 'euheu', 'heuh', 'euh', 'heu', 'heum', 'hum', 'hmmm', 'hmm', 'mmh', 'mmm']

// Petits mots-outils dont un doublon immédiat est un bégaiement (jamais une emphase voulue,
// contrairement à « très très » ou « non non » qu'on laisse intacts).
const STUTTER = new Set([
  'je', "j'", 'j', 'tu', 'il', 'le', 'la', 'les', 'de', 'des', 'du', 'et', 'à',
  'un', 'une', 'on', 'ce', 'se', 'ne', 'en', 'que', 'qui', "c'", 'c', "l'", 'l', "d'", 'd'
])

/** Réduit les doublons immédiats de mots-outils : « je je pense » -> « je pense ». */
function collapseStutter(text: string): string {
  const tokens = text.split(/(\s+)/) // garde les séparateurs
  const out: string[] = []
  let lastWord = ''
  for (const tok of tokens) {
    if (tok === '' || /^\s+$/.test(tok)) {
      out.push(tok)
      continue
    }
    const w = tok.toLowerCase().replace(/[.,!?;:…]/g, '')
    if (w && w === lastWord && STUTTER.has(w)) {
      // doublon immédiat d'un mot-outil : on saute (et on retire l'espace qui précède)
      if (out.length && /^\s+$/.test(out[out.length - 1])) out.pop()
      continue
    }
    lastWord = w
    out.push(tok)
  }
  return out.join('')
}

/** Retire les hésitations et bégaiements. Idempotent et sûr (préserve le sens). */
export function stripDisfluencies(text: string): string {
  if (!text || !text.trim()) return text
  const alt = FILLERS.join('|')
  let out = text

  // Retire les hésitations isolées (+ une virgule éventuelle qui suit), en gardant la frontière.
  try {
    const re = new RegExp(`(^|[^\\p{L}])(?:${alt})(?:\\s*,)?(?=[^\\p{L}]|$)`, 'giu')
    out = out.replace(re, (_m, pre) => pre)
  } catch {
    const re = new RegExp(`(^|[^A-Za-zÀ-ÿ])(?:${alt})(?:\\s*,)?(?=[^A-Za-zÀ-ÿ]|$)`, 'gi')
    out = out.replace(re, (_m, pre) => pre)
  }

  out = collapseStutter(out)

  // Normalise les espaces doublés et recolle la virgule/le point (en français on GARDE
  // l'espace avant ? ! ; : — on n'y touche donc pas).
  out = out.replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1').trim()
  // Recapitalise la 1re lettre si on a retiré un filler en tête.
  out = out.replace(/^([a-zà-ÿ])/, (m) => m.toUpperCase())
  return out
}
