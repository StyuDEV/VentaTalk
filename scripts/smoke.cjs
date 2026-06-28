// Smoke test ABI : charge chaque module natif SOUS Electron et rapporte le résultat.
const { app, clipboard } = require('electron')

app.whenReady().then(async () => {
  const results = {}
  const test = async (name, fn) => {
    try {
      await fn()
      results[name] = 'OK'
    } catch (e) {
      results[name] = 'FAIL: ' + (e && e.message ? e.message : String(e))
    }
  }

  await test('uiohook-napi (require)', () => {
    const { UiohookKey } = require('uiohook-napi')
    if (typeof UiohookKey.F9 !== 'number') throw new Error('UiohookKey absent')
  })

  await test('nut-js/libnut (appel natif)', async () => {
    const { clipboard: nutClip } = require('@nut-tree-fork/nut-js')
    await nutClip.getContent() // force le chargement de libnut.node
  })

  await test('node-llama-cpp (getLlama)', async () => {
    const m = await import('node-llama-cpp')
    await m.getLlama() // charge le binaire llama
  })

  // évite que le presse-papiers reste modifié
  void clipboard

  console.log('SMOKE_RESULTS ' + JSON.stringify(results))
  app.quit()
})

// filet de sécurité
setTimeout(() => {
  console.log('SMOKE_TIMEOUT')
  app.exit(1)
}, 60000)
