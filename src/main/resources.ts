import { app, nativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Résout un fichier de `resources/` aussi bien en dev qu'en build empaqueté. */
export function resourcePath(name: string): string {
  const candidates = [
    join(app.getAppPath(), 'resources', name),
    join(process.resourcesPath || '', 'resources', name),
    join(process.resourcesPath || '', name)
  ]
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return candidates[0]
}

export function appIcon(): Electron.NativeImage {
  return nativeImage.createFromPath(resourcePath('icon.png'))
}

export function trayIcon(): Electron.NativeImage {
  const img = appIcon()
  // Sur Windows une icône 16/32 px est idéale ; Electron redimensionne au besoin.
  return img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 18, height: 18 })
}
