import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// Les modules natifs (node-llama-cpp, uiohook-napi, @nut-tree-fork/nut-js)
// DOIVENT rester externes (non bundlés) : externalizeDepsPlugin externalise toutes les deps.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      // JAMAIS d'inline en data: URL (défaut Vite : < 4 Ko) : le worklet audio
      // (capture-processor.js) doit rester un VRAI fichier, couvert par le 'self' de la CSP.
      // Un data: exigerait `script-src data:` (vecteur XSS) — et sans lui, la dictée casserait
      // en build packagé (tout en marchant en dev, servi par localhost).
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          settings: resolve(__dirname, 'src/renderer/settings/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay/index.html')
        }
      }
    }
  }
})
