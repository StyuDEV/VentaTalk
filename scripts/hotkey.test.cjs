// Test de la logique de raccourcis (combinaisons + capture), sans hook global.
// Usage : node scripts/hotkey.test.cjs <chemin-du-bundle-esbuild>
const hk = require(process.argv[2])

const K = { Ctrl: 29, Alt: 56, Shift: 42, Space: 57, F9: 67, A: 30, Escape: 1 }
const ev = (keycode, m = {}) => ({
  keycode,
  ctrlKey: !!m.ctrl,
  altKey: !!m.alt,
  shiftKey: !!m.shift,
  metaKey: !!m.win
})

let failures = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`))
  if (!ok) failures++
}

function fresh() {
  const ev2 = []
  hk.__reset()
  hk.__setHandlers({
    onStart: () => ev2.push('start'),
    onStop: () => ev2.push('stop'),
    onCancel: () => ev2.push('cancel')
  })
  return ev2
}

// A) touche simple F9 (hold)
{
  const e = fresh()
  hk.setActivationMode('hold'); hk.setHotkey('F9')
  hk.handleKeyEvent('keydown', ev(K.F9))
  hk.handleKeyEvent('keyup', ev(K.F9))
  check('F9 hold start/stop', e, ['start', 'stop'])
}

// B) Alt+Shift (hold) — start quand les deux sont tenus, stop au relâchement d'un
{
  const e = fresh()
  hk.setHotkey('Alt+Shift')
  hk.handleKeyEvent('keydown', ev(K.Alt, { alt: true }))
  check('Alt seul ne déclenche pas', e, [])
  hk.handleKeyEvent('keydown', ev(K.Shift, { alt: true, shift: true }))
  check('Alt+Shift déclenche', e, ['start'])
  hk.handleKeyEvent('keyup', ev(K.Shift, { alt: true, shift: false }))
  check('relâcher Shift arrête', e, ['start', 'stop'])
  hk.handleKeyEvent('keyup', ev(K.Alt, { alt: false }))
  check('relâcher Alt = rien de plus', e, ['start', 'stop'])
}

// C) Ctrl+Space (hold) — Ctrl seul ne fait rien
{
  const e = fresh()
  hk.setHotkey('Ctrl+Space')
  hk.handleKeyEvent('keydown', ev(K.Ctrl, { ctrl: true }))
  hk.handleKeyEvent('keydown', ev(K.Space, { ctrl: true }))
  hk.handleKeyEvent('keyup', ev(K.Space, { ctrl: true }))
  hk.handleKeyEvent('keyup', ev(K.Ctrl, { ctrl: false }))
  check('Ctrl+Space start/stop', e, ['start', 'stop'])
}

// D) auto-répétition d'une touche maintenue = pas de double start
{
  const e = fresh()
  hk.setHotkey('F9')
  hk.handleKeyEvent('keydown', ev(K.F9))
  hk.handleKeyEvent('keydown', ev(K.F9)) // auto-repeat
  hk.handleKeyEvent('keydown', ev(K.F9))
  hk.handleKeyEvent('keyup', ev(K.F9))
  check('auto-repeat = un seul start/stop', e, ['start', 'stop'])
}

// E) toggle mode
{
  const e = fresh()
  hk.setActivationMode('toggle'); hk.setHotkey('F9')
  hk.handleKeyEvent('keydown', ev(K.F9))
  hk.handleKeyEvent('keyup', ev(K.F9))
  check('toggle: 1er appui = start', e, ['start'])
  hk.handleKeyEvent('keydown', ev(K.F9))
  hk.handleKeyEvent('keyup', ev(K.F9))
  check('toggle: 2e appui = stop', e, ['start', 'stop'])
}

// I) RÉGRESSION : Alt+Shift, keyup d'Alt avalé mais flag corrige -> Shift seul n'active pas
{
  const e = fresh()
  hk.setActivationMode('hold'); hk.setHotkey('Alt+Shift')
  hk.handleKeyEvent('keydown', ev(K.Alt, { alt: true }))
  hk.handleKeyEvent('keydown', ev(K.Shift, { alt: true, shift: true })) // start
  hk.handleKeyEvent('keyup', ev(K.Shift, { alt: false, shift: false })) // Alt keyup manquant, flag heal
  hk.handleKeyEvent('keydown', ev(K.Shift, { alt: false, shift: true })) // Shift seul plus tard
  hk.handleKeyEvent('keyup', ev(K.Shift, { alt: false, shift: false }))
  check('REGRESSION keyup avalé + flag heal: Shift seul inerte', e, ['start', 'stop'])
}

// J) RÉGRESSION : flag Alt bloqué à true, mais keyup keycode d'Alt reçu -> Shift seul n'active pas
{
  const e = fresh()
  hk.setHotkey('Alt+Shift')
  hk.handleKeyEvent('keydown', ev(K.Alt, { alt: true }))
  hk.handleKeyEvent('keydown', ev(K.Shift, { alt: true, shift: true })) // start
  hk.handleKeyEvent('keyup', ev(K.Alt, { alt: true })) // Alt relâché, flag RESTE bloqué true
  hk.handleKeyEvent('keyup', ev(K.Shift, { alt: true, shift: false })) // stop
  hk.handleKeyEvent('keydown', ev(K.Shift, { alt: true, shift: true })) // Shift seul, flag Alt encore bloqué
  hk.handleKeyEvent('keyup', ev(K.Shift, { alt: true, shift: false }))
  check('REGRESSION flag Alt bloqué: Shift seul inerte', e, ['start', 'stop'])
}

// F) capture Alt+Shift
;(async () => {
  {
    const e = fresh()
    hk.setActivationMode('hold')
    const p = hk.captureHotkey()
    hk.handleKeyEvent('keydown', ev(K.Alt, { alt: true }))
    hk.handleKeyEvent('keydown', ev(K.Shift, { alt: true, shift: true }))
    hk.handleKeyEvent('keyup', ev(K.Shift, { alt: true, shift: false }))
    const res = await p
    check('capture Alt+Shift', res, 'Alt+Shift')
    check('capture ne déclenche pas start/stop', e, [])
  }

  // G) capture F9
  {
    fresh()
    const p = hk.captureHotkey()
    hk.handleKeyEvent('keydown', ev(K.F9))
    hk.handleKeyEvent('keyup', ev(K.F9))
    check('capture F9', await p, 'F9')
  }

  // H) capture Ctrl+Space
  {
    fresh()
    const p = hk.captureHotkey()
    hk.handleKeyEvent('keydown', ev(K.Ctrl, { ctrl: true }))
    hk.handleKeyEvent('keydown', ev(K.Space, { ctrl: true }))
    hk.handleKeyEvent('keyup', ev(K.Space, { ctrl: true }))
    check('capture Ctrl+Space', await p, 'Ctrl+Space')
  }

  // I) Échap déclenche onCancel (annulation) sans toucher start/stop
  {
    const e = fresh()
    hk.setActivationMode('hold'); hk.setHotkey('F9')
    hk.handleKeyEvent('keydown', ev(K.Escape))
    check('Échap -> cancel', e, ['cancel'])
  }

  // J) une touche quelconque (hors raccourci) ne déclenche PAS d'annulation
  {
    const e = fresh()
    hk.setHotkey('F9')
    hk.handleKeyEvent('keydown', ev(K.A))
    hk.handleKeyEvent('keyup', ev(K.A))
    check('A ne cancel pas', e, [])
  }

  // K) Échap pendant la capture ne déclenche PAS onCancel (capture en cours)
  {
    const e = fresh()
    const p = hk.captureHotkey()
    hk.handleKeyEvent('keydown', ev(K.Escape))
    hk.handleKeyEvent('keyup', ev(K.Escape))
    await p
    check('Échap en capture ne cancel pas', e, [])
  }

  console.log(failures === 0 ? '\nALL_PASS' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})()
