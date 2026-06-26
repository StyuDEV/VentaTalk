// DSP pur (testable) : VAD léger par énergie + normalisation. Pas de dépendance navigateur.

/** Énergie RMS d'une plage du signal (par défaut tout le signal). */
export function rms(pcm: Float32Array, start = 0, end = pcm.length): number {
  let sum = 0
  for (let i = start; i < end; i++) sum += pcm[i] * pcm[i]
  const n = Math.max(1, end - start)
  return Math.sqrt(sum / n)
}

/** Pic d'énergie RMS parmi les trames de `frame` échantillons (détecte de la parole partout). */
export function peakFrameRms(pcm: Float32Array, frame = 320): number {
  const nFrames = Math.floor(pcm.length / frame)
  let peak = 0
  for (let f = 0; f < nFrames; f++) {
    const e = rms(pcm, f * frame, f * frame + frame)
    if (e > peak) peak = e
  }
  return peak
}

// Sous ce pic d'énergie, le clip est réellement silencieux (aucune parole, même faible).
const ABS_SILENCE = 0.0035

/**
 * Ne garde que la région parlée (coupe le silence aux bords). Le seuil est ADAPTATIF :
 * estimé à partir du plancher de bruit du clip ET proportionnel à son pic -> robuste aux
 * micros à faible gain, là où un seuil absolu (ancien 0.012) jetait toute la dictée en
 * silence. Renvoie un tableau vide UNIQUEMENT si le clip est réellement silencieux.
 */
export function trimSilence(pcm: Float32Array, frame = 320, padF = 8): Float32Array {
  const nFrames = Math.floor(pcm.length / frame)
  if (nFrames === 0) return pcm.length ? pcm.slice() : new Float32Array(0)

  const energies = new Float32Array(nFrames)
  let peak = 0
  for (let f = 0; f < nFrames; f++) {
    const e = rms(pcm, f * frame, f * frame + frame)
    energies[f] = e
    if (e > peak) peak = e
  }
  if (peak < ABS_SILENCE) return new Float32Array(0) // clip réellement silencieux

  // Plancher de bruit : ~20e percentile des trames (robuste à quelques trames fortes).
  const sorted = energies.slice().sort()
  const noise = sorted[Math.floor(nFrames * 0.2)]
  // Seuil = au-dessus du bruit ET proportionnel à la dynamique du clip (s'adapte au gain).
  const gate = Math.max(noise * 2.2, ABS_SILENCE * 0.8, peak * 0.08)

  let first = -1
  let last = -1
  for (let f = 0; f < nFrames; f++) {
    if (energies[f] > gate) {
      if (first < 0) first = f
      last = f
    }
  }
  if (first < 0) return new Float32Array(0)
  const start = Math.max(0, first - padF) * frame
  const end = Math.min(pcm.length, (last + 1 + padF) * frame)
  return pcm.slice(start, end)
}

/** Normalise le pic à ~-0,5 dBFS, clampe [-1,1], et ajoute un padding de silence aux bords. */
export function normalizeAndPad(pcm: Float32Array, sampleRate = 16000, padMs = 100): Float32Array {
  if (pcm.length === 0) return pcm
  let peak = 0
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i])
    if (a > peak) peak = a
  }
  if (peak > 0.001 && peak < 0.95) {
    const g = 0.95 / peak
    for (let i = 0; i < pcm.length; i++) pcm[i] *= g
  }
  for (let i = 0; i < pcm.length; i++) {
    if (pcm[i] > 1) pcm[i] = 1
    else if (pcm[i] < -1) pcm[i] = -1
  }
  const pad = Math.round((padMs / 1000) * sampleRate)
  const out = new Float32Array(pad + pcm.length + pad)
  out.set(pcm, pad)
  return out
}
