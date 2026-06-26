// Notes de version, affichées dans l'app après une mise à jour (et via « Notes de version »).
// Clé = version (doit matcher `version` de package.json) ; valeur = liste de nouveautés (FR).
// Garder la plus récente en haut de l'objet pour s'y retrouver.

export const CHANGELOG: Record<string, string[]> = {
  '1.0.0': [
    'Première version stable de VentaTalk.',
    'Dictée vocale 100 % locale (GPU), nettoyée par IA, écrite au curseur dans n’importe quelle application.'
  ]
}

/** Notes de la version donnée, ou null si aucune. */
export function changelogFor(version: string): string[] | null {
  return CHANGELOG[version] ?? null
}

/** Toutes les notes de version, de la plus récente à la plus ancienne (ordre de l'objet). */
export function allChangelogs(): { version: string; changes: string[] }[] {
  return Object.entries(CHANGELOG).map(([version, changes]) => ({ version, changes }))
}
