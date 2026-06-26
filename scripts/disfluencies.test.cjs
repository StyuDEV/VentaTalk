// Test de la passe déterministe de disfluences (stripDisfluencies).
// Usage : node scripts/disfluencies.test.cjs <chemin-du-bundle-esbuild>
const d = require(process.argv[2])

let fail = 0
function check(name, got, want) {
  const ok = got === want
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`))
  if (!ok) fail++
}

// ── hésitations ──
check('euh isolé en tête', d.stripDisfluencies('euh donc on y va'), 'Donc on y va')
check('hum au milieu', d.stripDisfluencies('je pense hum que oui'), 'Je pense que oui')
check('filler + virgule', d.stripDisfluencies('euh, oui'), 'Oui')
check('deux fillers adjacents', d.stripDisfluencies('euh euh donc'), 'Donc')
check('filler en fin', d.stripDisfluencies('on y va euh'), 'On y va')
// registre familier PRÉSERVÉ : bah/ben ne sont PAS des hésitations à retirer
check('garde "bah ouais" (familier)', d.stripDisfluencies('bah ouais carrément'), 'Bah ouais carrément')
check('garde "ben non" (familier)', d.stripDisfluencies('ben non'), 'Ben non')

// ── faux positifs à éviter ──
check('mot contenant un filler intact', d.stripDisfluencies('le heureux gagnant'), 'Le heureux gagnant')
check('texte déjà propre inchangé', d.stripDisfluencies('Bonjour, ça va ?'), 'Bonjour, ça va ?')
check('espace avant ? conservé (français)', d.stripDisfluencies('euh tu viens ?'), 'Tu viens ?')

// ── bégaiements ──
check('bégaiement mot-outil', d.stripDisfluencies('je je pense'), 'Je pense')
check('bégaiement article', d.stripDisfluencies('le le chat dort'), 'Le chat dort')
check('garde "très très" (emphase)', d.stripDisfluencies('très très bien'), 'Très très bien')
check('garde "non non"', d.stripDisfluencies('non non'), 'Non non')

// ── divers ──
check('recapitalise après retrait en tête', d.stripDisfluencies('euh bonjour'), 'Bonjour')
check('chaîne vide -> inchangée', d.stripDisfluencies(''), '')

console.log(fail === 0 ? '\nALL_PASS' : `\n${fail} FAILED`)
process.exit(fail ? 1 : 0)
