// Génère les visuels de l'installeur NSIS depuis le logo waveform :
//   resources/installerSidebar.bmp   (164×314) — bannière des pages bienvenue/fin
//   resources/uninstallerSidebar.bmp (164×314) — idem désinstalleur
//   resources/installerHeader.bmp    (150×57)  — bandeau haut des pages
// Rasterisation via canvas Chromium (alpha exact) → BMP 24 bits via jimp (format NSIS).
// Lancer :  npx electron scripts/make-installer-banner.cjs
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const path = require('node:path')
const Jimp = require('jimp')

const RES = path.join(__dirname, '..', 'resources')

// Barres du logo (mêmes coords que resources/icon.svg : viewBox 160 282 704 460).
const BARS = `
  <rect x="160" y="420" width="96" height="184" rx="48"/>
  <rect x="312" y="356" width="96" height="312" rx="48"/>
  <rect x="464" y="282" width="96" height="460" rx="48"/>
  <rect x="616" y="356" width="96" height="312" rx="48"/>
  <rect x="768" y="420" width="96" height="184" rx="48"/>`

const DEFS = `
  <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
    <stop offset="0" stop-color="#16183a"/><stop offset="0.55" stop-color="#0d0e1d"/><stop offset="1" stop-color="#0a0b12"/>
  </linearGradient>
  <linearGradient id="bar" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#a5b4fc"/><stop offset="1" stop-color="#4f46e5"/>
  </linearGradient>
  <radialGradient id="glow" cx="0.5" cy="0.32" r="0.55">
    <stop offset="0" stop-color="#6366f1" stop-opacity="0.38"/><stop offset="1" stop-color="#6366f1" stop-opacity="0"/>
  </radialGradient>`

const sidebarSvg = `<svg width="164" height="314" xmlns="http://www.w3.org/2000/svg"><defs>${DEFS}</defs>
  <rect width="164" height="314" fill="url(#bg)"/>
  <rect width="164" height="314" fill="url(#glow)"/>
  <g fill="url(#bar)" transform="translate(36,84) scale(0.09)" filter="drop-shadow(0 6px 14px rgba(99,102,241,.5))">${BARS}</g>
  <text x="82" y="186" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="22" font-weight="700" fill="#edeefb" letter-spacing="-0.5">VentaTalk</text>
  <text x="82" y="207" text-anchor="middle" font-family="Consolas, monospace" font-size="9" letter-spacing="1.5" fill="#7e83ac">DICT&#201;E VOCALE LOCALE</text>
  <rect x="58" y="226" width="48" height="2" rx="1" fill="#6366f1" opacity="0.6"/>
</svg>`

// Waveform et texte centrés verticalement dans la bande de 57 px (centre ≈ 28,5).
// La bbox des barres est y[282..742] (centre 512) ; à scale 0.048 → centre local 24,6 ;
// translate y = 28,5 − 24,6 ≈ 4 pour centrer.
const headerSvg = `<svg width="150" height="57" xmlns="http://www.w3.org/2000/svg"><defs>${DEFS}</defs>
  <rect width="150" height="57" fill="#0f1018"/>
  <g fill="url(#bar)" transform="translate(10,4) scale(0.048)">${BARS}</g>
  <text x="55" y="34" font-family="Segoe UI, sans-serif" font-size="15" font-weight="700" fill="#edeefb" letter-spacing="-0.4">VentaTalk</text>
</svg>`

/** Encode un BMP 24 bits BOTTOM-UP standard (hauteur positive) — compatible NSIS/LoadImage. */
function encodeBmp24(bitmap) {
  const { width, height, data } = bitmap
  const rowSize = Math.floor((24 * width + 31) / 32) * 4
  const pixelArraySize = rowSize * height
  const buf = Buffer.alloc(54 + pixelArraySize)
  buf.write('BM', 0)
  buf.writeUInt32LE(54 + pixelArraySize, 2)
  buf.writeUInt32LE(54, 10)
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(width, 18)
  buf.writeInt32LE(height, 22) // positif = bottom-up
  buf.writeUInt16LE(1, 26)
  buf.writeUInt16LE(24, 28)
  buf.writeUInt32LE(pixelArraySize, 34)
  buf.writeInt32LE(2835, 38)
  buf.writeInt32LE(2835, 42)
  let p = 54
  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      buf[p++] = data[i + 2]
      buf[p++] = data[i + 1]
      buf[p++] = data[i]
    }
    for (let k = 0; k < rowSize - width * 3; k++) buf[p++] = 0
  }
  return buf
}

async function render(win, svg, w, h) {
  const b64 = Buffer.from(svg, 'utf8').toString('base64')
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;base64,${b64}'; });
    const c = document.createElement('canvas'); c.width = ${w}; c.height = ${h};
    const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, ${w}, ${h});
    return c.toDataURL('image/png');
  })()`)
  const png = Buffer.from(dataUrl.split(',')[1], 'base64')
  // Le SVG remplit un fond opaque → le PNG est sans transparence ; jimp/bmp-js écrit du BMP 24 bits.
  return await Jimp.read(png)
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 200, height: 360, webPreferences: { offscreen: true } })
  await win.loadURL('about:blank')

  const sidebar = encodeBmp24((await render(win, sidebarSvg, 164, 314)).bitmap)
  writeFileSync(path.join(RES, 'installerSidebar.bmp'), sidebar)
  writeFileSync(path.join(RES, 'uninstallerSidebar.bmp'), sidebar)

  const header = encodeBmp24((await render(win, headerSvg, 150, 57)).bitmap)
  writeFileSync(path.join(RES, 'installerHeader.bmp'), header)

  console.log('BANNER_DONE')
  app.quit()
})

setTimeout(() => { console.log('BANNER_TIMEOUT'); app.exit(1) }, 25000)
