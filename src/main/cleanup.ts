// node-llama-cpp v3 est ESM-only : on l'importe dynamiquement depuis ce module CJS,
// et UNIQUEMENT dans le process main (l'utiliser dans un renderer fait planter l'app).

let llamaModule: any = null
let llama: any = null
let model: any = null
let loadedPath: string | null = null

function systemPrompt(vocabulary?: string): string {
  const base = `Tu es un correcteur de dictée vocale. On te donne une transcription brute issue de la reconnaissance vocale.
Reste FIDÈLE à ce que la personne a dit — y compris le langage familier, l'argot et le registre oral — sans jamais en changer le sens.
Corrige UNIQUEMENT :
- les hésitations pures (euh, heu, hum, hmm...) et les mots répétés par erreur — mais GARDE les
  tournures familières (« bah ouais », « ben non », « genre », « du coup »),
- les reprises/corrections orales (« non plutôt », « pardon », « enfin ») : ne garde que la version finale voulue,
- la ponctuation et les majuscules,
- les fautes d'orthographe et les mots manifestement mal reconnus (homophones),
- l'orthographe et la casse des noms propres / termes de la liste ci-dessous.
NE reformule PAS, NE change PAS le vocabulaire ni le registre : garde l'argot et les tournures familières telles quelles
(ex. « ouais », « grave », « kiffer », « bagnole », « ça passe crème », « je sais pas »). N'ajoute, ne supprime et ne
« rends pas plus soutenu » aucune idée ni aucun mot. Garde la même langue que l'entrée (ne traduis jamais).
Réponds UNIQUEMENT par le texte corrigé, sans aucun préambule, sans guillemets, sans markdown.
Exemples :
- entrée : « euh ouais du coup j'ai trop kiffé la soirée » → sortie : « Ouais, du coup j'ai trop kiffé la soirée. »
- entrée : « on se voit à 14h non plutôt 16h » → sortie : « On se voit à 16h. »
- entrée : « franchement je sais pas trop ça passe crème » → sortie : « Franchement, je sais pas trop, ça passe crème. »`
  const vocab = vocabulary?.trim()
  return vocab ? `${base}\nNoms propres / vocabulaire : ${vocab}` : base
}

/** Retire un éventuel préambule, du markdown de base et les guillemets d'encadrement. */
function stripModelChrome(text: string): string {
  let out = text.trim()
  out = out.replace(/^\s*(?:voici\s+(?:le\s+)?texte(?:\s+corrigé)?\s*:|texte\s+corrigé\s*:|texte\s*:|correction\s*:)\s*/i, '')
  out = out.replace(/```[a-z]*\s*|```/gi, '').replace(/^\s*#+\s*/gm, '').replace(/\*\*/g, '')
  out = out.replace(/^["«»"]+|["«»"]+$/g, '').trim()
  return out
}

/** Charge (ou recharge) le LLM GGUF et le garde en mémoire. */
export async function ensureLlm(modelPath: string): Promise<void> {
  if (model && loadedPath === modelPath) return
  if (!llamaModule) llamaModule = await import('node-llama-cpp')
  if (model) {
    await model.dispose()
    model = null
  }
  // logLevel 'error' : coupe les logs WARN/INFO de llama.cpp (ex. « [node-llama-cpp] load:
  // control-looking token… ») qui fuyaient dans le terminal, tout en gardant les vraies erreurs.
  llama = await llamaModule.getLlama({ logLevel: llamaModule.LlamaLogLevel.error })
  model = await llama.loadModel({ modelPath })
  loadedPath = modelPath
}

export function isLlmLoaded(): boolean {
  return model !== null
}

// Au-delà, le texte + le system prompt débordent le contexte 2048 : le LLM part en context-shift
// (lent, instable) sans réelle valeur ajoutée. On saute le nettoyage (le texte est déjà passé par
// les disfluences déterministes + le dictionnaire de remplacements). ~3000 caractères ≈ une dictée
// de plusieurs minutes — bien au-delà d'un usage normal au curseur.
const MAX_CLEANUP_CHARS = 3000
// Plafond de temps de génération : au-delà, on abandonne le nettoyage (signal d'abort) et on garde
// le texte brut. Empêche une génération qui s'éternise de figer le pipeline.
const CLEANUP_TIMEOUT_MS = 15000

/**
 * Nettoie le texte brut via le LLM. Sans état entre les appels (contexte recréé puis libéré).
 * Garde-fou : si la sortie est vide ou aberrante, ou si le texte est trop long / la génération
 * trop lente, on renvoie le texte brut.
 */
export async function cleanup(rawText: string, vocabulary?: string): Promise<string> {
  const raw = rawText.trim()
  if (!model || !raw) return raw
  // Texte trop long pour le contexte : on saute le LLM (déjà nettoyé en amont).
  if (raw.length > MAX_CLEANUP_CHARS) return raw

  const { LlamaChatSession } = llamaModule
  const context = await model.createContext({ contextSize: 2048 })
  // Abort au bout de CLEANUP_TIMEOUT_MS : stopOnAbortSignal -> la génération s'arrête PROPREMENT
  // (sans exception) ; on retombe alors sur le texte brut (un partiel tronqué est peu fiable).
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), CLEANUP_TIMEOUT_MS)
  try {
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt: systemPrompt(vocabulary)
    })
    // temperature 0 -> nettoyage déterministe (reproductible, testable).
    const out: string = await session.prompt(raw, {
      temperature: 0,
      maxTokens: 1024,
      signal: ctl.signal,
      stopOnAbortSignal: true
    })
    if (ctl.signal.aborted) return raw // timeout atteint : on garde le brut
    const cleaned = stripModelChrome(out || '')
    if (!cleaned) return raw
    // si le modèle a déliré (sortie 3x plus longue), on garde le brut
    if (cleaned.length > raw.length * 3 + 100) return raw
    return cleaned
  } catch {
    return raw
  } finally {
    clearTimeout(timer)
    await context.dispose()
  }
}

export async function freeLlm(): Promise<void> {
  if (model) {
    await model.dispose()
    model = null
    loadedPath = null
  }
}
