// Régénère resources/icon.png (512) + resources/icon.ico (16→256) depuis resources/icon.svg.
// Rasterisation via canvas Chromium (alpha exact, indépendant du scaleFactor écran), zéro
// dépendance externe. Lancer avec :  npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const RES = path.join(__dirname, '..', 'resources')
const SVG = readFileSync(path.join(RES, 'icon.svg'), 'utf8')
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const ALL_SIZES = [16, 24, 32, 48, 64, 128, 256, 512]

/** Assemble un .ico depuis des PNG (PNG-in-ICO, supporté Windows Vista+). */
function buildIco(images) {
  const count = images.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // réservé
  header.writeUInt16LE(1, 2) // type = icône
  header.writeUInt16LE(count, 4)
  const entries = Buffer.alloc(16 * count)
  let offset = 6 + 16 * count
  const datas = []
  images.forEach((im, i) => {
    const b = im.buf
    const e = entries.subarray(i * 16, i * 16 + 16)
    e.writeUInt8(im.size >= 256 ? 0 : im.size, 0) // largeur (0 = 256)
    e.writeUInt8(im.size >= 256 ? 0 : im.size, 1) // hauteur
    e.writeUInt8(0, 2) // couleurs palette
    e.writeUInt8(0, 3) // réservé
    e.writeUInt16LE(1, 4) // plans
    e.writeUInt16LE(32, 6) // bits/pixel
    e.writeUInt32LE(b.length, 8) // taille des données
    e.writeUInt32LE(offset, 12) // offset
    offset += b.length
    datas.push(b)
  })
  return Buffer.concat([header, entries, ...datas])
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 256, height: 256, webPreferences: { offscreen: true } })
  await win.loadURL('about:blank')

  const b64 = Buffer.from(SVG, 'utf8').toString('base64')
  const dataUrls = await win.webContents.executeJavaScript(`(async () => {
    const src = 'data:image/svg+xml;base64,${b64}';
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
    const sizes = ${JSON.stringify(ALL_SIZES)};
    const out = {};
    for (const n of sizes) {
      const c = document.createElement('canvas');
      c.width = n; c.height = n;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, n, n);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, n, n);
      out[n] = c.toDataURL('image/png');
    }
    return out;
  })()`)

  const toBuf = (n) => Buffer.from(dataUrls[n].split(',')[1], 'base64')

  writeFileSync(path.join(RES, 'icon.png'), toBuf(512))
  writeFileSync(path.join(RES, 'icon.ico'), buildIco(ICO_SIZES.map((size) => ({ size, buf: toBuf(size) }))))

  console.log('ICON_DONE')
  app.quit()
})

setTimeout(() => { console.log('ICON_TIMEOUT'); app.exit(1) }, 25000)
