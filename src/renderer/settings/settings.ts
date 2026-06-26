const v = window.venta

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const LANGUAGES: Array<[string, string]> = [
  ['auto', 'Auto (détection)'],
  ['fr', 'Français'],
  ['en', 'Anglais'],
  ['es', 'Espagnol'],
  ['de', 'Allemand'],
  ['it', 'Italien'],
  ['pt', 'Portugais'],
  ['nl', 'Néerlandais'],
  ['ru', 'Russe'],
  ['zh', 'Chinois'],
  ['ja', 'Japonais'],
  ['ko', 'Coréen'],
  ['ar', 'Arabe']
]

const WHISPER_LABELS: Record<string, string> = {
  base: 'Base — rapide, qualité correcte',
  small: 'Small — bon compromis',
  'large-v3-turbo': 'Large v3 Turbo — meilleure qualité',
  'fr-distil-dec16': 'Français (bofenghuang) — optimisé FR'
}

function fmtSize(bytes: number): string {
  if (bytes > 1e9) return (bytes / 1e9).toFixed(1) + ' Go'
  return Math.round(bytes / 1e6) + ' Mo'
}

// Touches qui ÉCRIVENT un caractère si pressées sans modificateur (miroir, par NOM, de
// hotkey-combo.ts TEXT_KEY_NAMES — dupliqué ici car ce module natif ne peut pas être importé
// dans le renderer). Un raccourci en touche textuelle SEULE taperait ce caractère dans l'app
// cible (uiohook ne peut pas avaler la frappe) → on le refuse à la capture.
const TEXT_KEYS = new Set<string>([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  ...'0123456789'.split('').flatMap((d) => [d, 'Numpad' + d]),
  'Space', 'Tab', 'Enter',
  'Backquote', 'BracketLeft', 'BracketRight', 'Semicolon', 'Quote',
  'Comma', 'Period', 'Slash', 'Backslash', 'Minus', 'Equal'
])
const HOTKEY_MODS = new Set(['Ctrl', 'Alt', 'Shift', 'Win'])

/** Le raccourci écrirait-il un caractère dans l'app cible (touche textuelle SANS modificateur) ? */
function comboWritesChar(combo: string): boolean {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean)
  if (parts.some((p) => HOTKEY_MODS.has(p))) return false // un modificateur protège
  return parts.some((p) => TEXT_KEYS.has(p))
}

let toastTimer: ReturnType<typeof setTimeout> | null = null
function showToast(message: string): void {
  const el = $('toast')
  el.textContent = message
  el.classList.add('show')
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200)
}

// ───────────────────────────────────────────── progression téléchargements ──

const progressBars = new Map<string, HTMLElement>()
const wizardBars = new Map<string, HTMLElement>()

type Progress = { kind: string; percent: number; done: boolean; error?: string }
function updateBar(bar: HTMLElement | null | undefined, p: Progress): void {
  if (!bar) return
  bar.classList.add('show')
  const fill = bar.querySelector('i') as HTMLElement
  fill.style.width = (p.error ? 0 : p.percent) + '%'
  if (p.done && !p.error) setTimeout(() => bar.classList.remove('show'), 600)
}
v.onModelProgress((p: Progress) => {
  updateBar(progressBars.get(p.kind), p)
  updateBar(wizardBars.get(p.kind), p)
})

async function renderModels(): Promise<void> {
  const status = await v.modelsStatus()
  const settings = await v.getSettings()

  // ── Whisper ──
  const container = $('whisperModels')
  container.innerHTML = ''
  for (const m of status.whisper as Array<{ id: string; approxBytes: number; present: boolean }>) {
    const wrap = document.createElement('div')
    wrap.className = 'model'
    wrap.innerHTML = `
      <div class="model-head">
        <div class="model-name">
          <input type="radio" name="whisperModel" value="${m.id}" ${m.id === settings.whisperModel ? 'checked' : ''} />
          <div>
            <div>${WHISPER_LABELS[m.id] ?? m.id}</div>
            <div class="size">${fmtSize(m.approxBytes)}</div>
          </div>
        </div>
        <div class="control">
          <span class="badge ${m.present ? 'ok' : 'no'}">${m.present ? 'Téléchargé' : 'Absent'}</span>
          <button data-dl="${m.id}" ${m.present ? 'disabled' : ''}>${m.present ? 'OK' : 'Télécharger'}</button>
        </div>
      </div>
      <div class="progress" data-prog="${m.id}"><i></i></div>`
    container.appendChild(wrap)
    progressBars.set(m.id, wrap.querySelector('[data-prog]') as HTMLElement)
  }

  // ── LLM ──
  const llm = status.llm as { id: string; approxBytes: number; present: boolean }
  $('llmModel').innerHTML = `
    <div class="model">
      <div class="model-head">
        <div class="model-name"><div>
          <div>Qwen2.5 3B Instruct (nettoyage)</div>
          <div class="size">${fmtSize(llm.approxBytes)}</div>
        </div></div>
        <div class="control">
          <span class="badge ${llm.present ? 'ok' : 'no'}">${llm.present ? 'Téléchargé' : 'Absent'}</span>
          <button data-dl="llm" ${llm.present ? 'disabled' : ''}>${llm.present ? 'OK' : 'Télécharger'}</button>
        </div>
      </div>
      <div class="progress" data-prog="llm"><i></i></div>
    </div>`
  progressBars.set('llm', $('llmModel').querySelector('[data-prog]') as HTMLElement)

  // ── Moteur GPU (auto : CUDA pour NVIDIA, Vulkan pour AMD/Intel) ──
  const gpu = status.gpu as { present: boolean; engine: 'cuda' | 'vulkan'; vendor: string }
  const eng =
    gpu.engine === 'cuda'
      ? { name: 'whisper.cpp CUDA', size: '~260 Mo · NVIDIA (cuBLAS)' }
      : { name: 'whisper.cpp Vulkan', size: '~20–60 Mo · AMD / Intel' }
  $('gpuEngine').innerHTML = `
    <div class="model">
      <div class="model-head">
        <div class="model-name"><div>
          <div>${eng.name}</div>
          <div class="size">${eng.size}</div>
        </div></div>
        <div class="control">
          <span class="badge ${gpu.present ? 'ok' : 'no'}">${gpu.present ? 'Installé' : 'Absent'}</span>
          <button data-dl="whisper-gpu" ${gpu.present ? 'disabled' : ''}>${gpu.present ? 'OK' : 'Installer'}</button>
        </div>
      </div>
      <div class="progress" data-prog="whisper-gpu"><i></i></div>
    </div>`
  progressBars.set('whisper-gpu', $('gpuEngine').querySelector('[data-prog]') as HTMLElement)

  // radio modèle actif
  document.querySelectorAll<HTMLInputElement>('input[name="whisperModel"]').forEach((r) => {
    r.addEventListener('change', () => {
      if (r.checked) void v.setSettings({ whisperModel: r.value })
    })
  })

  // téléchargements
  document.querySelectorAll<HTMLButtonElement>('button[data-dl]').forEach((b) => {
    b.addEventListener('click', async () => {
      const kind = b.dataset.dl as string
      progressBars.get(kind)?.classList.add('show')
      b.disabled = true
      b.textContent = '…'
      const res = await v.downloadModel(kind)
      if (!res.ok) {
        showToast('Échec : ' + (res.error ?? 'téléchargement'))
        b.disabled = false
        b.textContent = 'Réessayer'
      } else {
        await renderModels()
      }
    })
  })
}

v.onToast((m: string) => showToast(m))

async function populateMics(current: string): Promise<void> {
  const sel = $('micDevice') as HTMLSelectElement
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true })
    tmp.getTracks().forEach((t) => t.stop()) // débloque les libellés
  } catch {
    /* permission refusée -> on garde "Par défaut" */
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const mics = devices.filter((d) => d.kind === 'audioinput')
    sel.innerHTML =
      '<option value="">Par défaut</option>' +
      mics.map((d, i) => `<option value="${d.deviceId}">${d.label || 'Micro ' + (i + 1)}</option>`).join('')
    sel.value = current
  } catch {
    /* noop */
  }
  sel.addEventListener('change', () => void v.setSettings({ micDeviceId: sel.value }))
}

// ────────────────────────────────────────────────────────────── historique ──

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
}

function fmtTime(at: number): string {
  return new Date(at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

async function renderHistory(): Promise<void> {
  const list = $('historyList')
  const s = await v.getSettings()
  const items = (await v.historyGet()) as Array<{ id: string; text: string; at: number }>
  const warn = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>`
  const notice = s.keepHistory
    ? ''
    : `<div class="hist-notice">${warn}<span>L'historique est désactivé — active « Conserver l'historique » ci-dessus pour enregistrer tes nouvelles dictées.</span></div>`
  if (!items.length) {
    list.innerHTML = notice + '<div class="hist-empty">Aucune dictée pour le moment.</div>'
    return
  }
  list.innerHTML =
    notice +
    items
    .map(
      (it) => `
      <div class="hist-item" data-id="${it.id}">
        <div class="hist-text">${escapeHtml(it.text)}</div>
        <div class="hist-meta">
          <span class="hist-time">${fmtTime(it.at)}</span>
          <span class="hist-btns">
            <button data-act="copy">Copier</button>
            <button data-act="reinject">Réinjecter</button>
            <button data-act="del" class="ghost-danger">Suppr.</button>
          </span>
        </div>
      </div>`
    )
    .join('')
  list.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) => {
    b.addEventListener('click', async () => {
      const item = b.closest('.hist-item') as HTMLElement
      const id = item.dataset.id as string
      const text = (item.querySelector('.hist-text') as HTMLElement).textContent ?? ''
      if (b.dataset.act === 'copy') await v.historyCopy(text)
      else if (b.dataset.act === 'reinject') await v.historyReinject(text)
      else if (b.dataset.act === 'del') {
        await v.historyDelete(id)
        await renderHistory()
      }
    })
  })
}

// ────────────────────────────────────────────── assistant de 1er lancement ──

let wizStep = 0
const WIZ_STEPS = 3

/** Sens du glissement entre étapes (Continuer = depuis la droite, Retour = depuis la gauche). */
function setWizDir(dir: 'fwd' | 'bwd' | 'none'): void {
  const body = document.querySelector('.wz-body') as HTMLElement | null
  if (!body) return
  body.classList.toggle('fwd', dir === 'fwd')
  body.classList.toggle('bwd', dir === 'bwd')
}

function paintWizard(): void {
  const dots = Array.from(document.querySelectorAll<HTMLElement>('[data-dot]'))
  const stepEls = Array.from(document.querySelectorAll<HTMLElement>('[data-step]'))
  stepEls.forEach((el) => el.classList.toggle('on', Number(el.dataset.step) === wizStep))
  dots.forEach((d) => d.classList.toggle('on', Number(d.dataset.dot) <= wizStep))
  ;($('wzBack') as HTMLButtonElement).style.visibility = wizStep === 0 ? 'hidden' : 'visible'
  ;($('wzNext') as HTMLButtonElement).textContent = wizStep === WIZ_STEPS - 1 ? 'Terminer' : 'Continuer'
  // Étape 0 : on démarre l'écoute live automatiquement (plus de bouton « Tester ») ; sinon on coupe.
  if (wizStep === 0) {
    if (!micStream) void startMicTest()
  } else {
    stopMicTest()
  }
}

function showWizard(): void {
  wizStep = 0
  setWizDir('none') // 1er affichage : simple fondu, pas de slide directionnel
  resetMicTest()
  paintWizard()
  void refreshWizardCards()
  $('onboarding').classList.add('show')
}

async function finishWizard(): Promise<void> {
  stopMicTest()
  await v.setSettings({ onboardingDone: true })
  $('onboarding').classList.remove('show')
  await renderModels()
}

// ── test micro (assistant, étape 0) : sélecteur + niveau live + dB ──
let micStream: MediaStream | null = null
let micRAF = 0
let micCtx: AudioContext | null = null

function stopMicTest(): void {
  if (micRAF) cancelAnimationFrame(micRAF)
  micRAF = 0
  micStream?.getTracks().forEach((t) => t.stop())
  micStream = null
  if (micCtx) {
    void micCtx.close().catch(() => {})
    micCtx = null
  }
}

function setMicStatus(text: string, cls = ''): void {
  const st = document.getElementById('micStatus')
  if (st) {
    st.className = 'size mic-status' + (cls ? ' ' + cls : '')
    st.textContent = text
  }
}

function resetMicTest(): void {
  stopMicTest()
  const fill = document.getElementById('wzMicFill') as HTMLElement | null
  const dbEl = document.getElementById('wzMicDb')
  const retry = document.getElementById('wzMicRetry') as HTMLElement | null
  if (fill) {
    fill.style.width = '0%'
    fill.classList.remove('loud')
  }
  if (dbEl) dbEl.textContent = '—'
  if (retry) retry.style.display = 'none'
  setMicStatus('Initialisation du micro…')
}

/** Remplit le sélecteur de micro de l'assistant (libellés débloqués via une permission éphémère). */
async function populateWzMics(current: string): Promise<void> {
  const sel = document.getElementById('wzMicDevice') as HTMLSelectElement | null
  if (!sel) return
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true })
    tmp.getTracks().forEach((t) => t.stop())
  } catch {
    /* permission refusée -> garde « Par défaut » */
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const mics = devices.filter((d) => d.kind === 'audioinput')
    sel.innerHTML =
      '<option value="">Par défaut</option>' +
      mics.map((d, i) => `<option value="${d.deviceId}">${d.label || 'Micro ' + (i + 1)}</option>`).join('')
    sel.value = current
  } catch {
    /* noop */
  }
}

/** Écoute live le micro sélectionné : barre de niveau + dB en continu, avec zones de qualité. */
async function startMicTest(): Promise<void> {
  stopMicTest()
  const fill = $('wzMicFill')
  const dbEl = $('wzMicDb')
  const retry = $('wzMicRetry')
  retry.style.display = 'none'
  const deviceId = ($('wzMicDevice') as HTMLSelectElement).value
  setMicStatus('Initialisation du micro…')
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true
    })
  } catch {
    setMicStatus('Micro inaccessible — vérifie les permissions micro de Windows.', 'err')
    retry.style.display = ''
    return
  }
  micCtx = new AudioContext()
  const src = micCtx.createMediaStreamSource(micStream)
  const analyser = micCtx.createAnalyser()
  analyser.fftSize = 1024
  src.connect(analyser)
  const data = new Uint8Array(analyser.fftSize)
  const loop = (): void => {
    analyser.getByteTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) {
      const x = (data[i] - 128) / 128
      sum += x * x
    }
    const rms = Math.sqrt(sum / data.length)
    const db = rms > 1e-5 ? 20 * Math.log10(rms) : -100 // dBFS approx
    // mappe [-60 dB, 0 dB] -> [0 %, 100 %] ; zone « bon niveau » = -40 à -10 dB (33–83 %)
    fill.style.width = Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) + '%'
    const tooLoud = db > -10
    fill.classList.toggle('loud', tooLoud)
    dbEl.textContent = db <= -100 ? '—' : String(Math.round(db))
    if (db < -40) setMicStatus('Trop faible — rapproche-toi ou monte le volume du micro.')
    else if (tooLoud) setMicStatus('Un peu fort — éloigne-toi un peu.', 'warn')
    else setMicStatus('Bon niveau ✓', 'ok')
    micRAF = requestAnimationFrame(loop)
  }
  loop()
}

function wizardCard(containerId: string, kind: string, title: string, size: string, present: boolean): void {
  const el = $(containerId)
  el.innerHTML = `
    <div class="model-head">
      <div class="model-name"><div><div>${title}</div><div class="size">${size}</div></div></div>
      <div class="control">
        <span class="badge ${present ? 'ok' : 'no'}">${present ? 'Prêt' : 'Absent'}</span>
        <button data-wzdl="${kind}" ${present ? 'disabled' : ''}>${present ? 'OK' : 'Télécharger'}</button>
      </div>
    </div>
    <div class="progress" data-wzprog="${kind}"><i></i></div>`
  wizardBars.set(kind, el.querySelector('[data-wzprog]') as HTMLElement)
  const btn = el.querySelector('button[data-wzdl]') as HTMLButtonElement
  btn.addEventListener('click', async () => {
    btn.disabled = true
    btn.textContent = '…'
    const res = await v.downloadModel(kind)
    if (res.ok) await refreshWizardCards()
    else {
      btn.disabled = false
      btn.textContent = 'Réessayer'
      showToast('Échec : ' + (res.error ?? 'téléchargement'))
    }
  })
}

async function refreshWizardCards(): Promise<void> {
  const status = await v.modelsStatus()
  const gpu = status.gpu as { present: boolean; engine: 'cuda' | 'vulkan' }
  const llm = status.llm as { present: boolean }
  const model = (status.whisper as Array<{ id: string; present: boolean }>).find((m) => m.id === 'fr-distil-dec16')
  const gpuName = gpu.engine === 'cuda' ? 'whisper.cpp CUDA (NVIDIA)' : 'whisper.cpp Vulkan (AMD/Intel)'
  const gpuSize = gpu.engine === 'cuda' ? '~260 Mo · recommandé' : '~20–60 Mo · recommandé'
  wizardCard('wzGpu', 'whisper-gpu', `Moteur GPU — ${gpuName}`, gpuSize, gpu.present)
  wizardCard('wzModel', 'fr-distil-dec16', 'Modèle français (bofenghuang)', '~791 Mo · optimisé FR', model?.present ?? false)
  wizardCard('wzLlm', 'llm', 'Nettoyage IA — Qwen2.5 3B', '~2 Go · optionnel', llm.present)
}

function wireOnboarding(hotkey: string): void {
  const fmt = (c: string): string => c.replace(/Space/g, 'Espace')
  ;($('wzBack') as HTMLButtonElement).addEventListener('click', () => {
    if (wizStep > 0) {
      wizStep--
      setWizDir('bwd')
      paintWizard()
    }
  })
  ;($('wzNext') as HTMLButtonElement).addEventListener('click', async () => {
    if (wizStep < WIZ_STEPS - 1) {
      wizStep++
      setWizDir('fwd')
      paintWizard()
    } else {
      await finishWizard()
    }
  })
  ;($('wzSkip') as HTMLButtonElement).addEventListener('click', () => void finishWizard())

  // sélecteur de micro de l'assistant : enregistre le choix, garde le réglage principal synchro, relance l'écoute
  ;($('wzMicDevice') as HTMLSelectElement).addEventListener('change', async () => {
    const id = ($('wzMicDevice') as HTMLSelectElement).value
    await v.setSettings({ micDeviceId: id })
    const main = document.getElementById('micDevice') as HTMLSelectElement | null
    if (main) main.value = id
    void startMicTest()
  })
  ;($('wzMicRetry') as HTMLButtonElement).addEventListener('click', () => void startMicTest())

  const wzHotkey = $('wzHotkey')
  wzHotkey.textContent = fmt(hotkey)
  const wzCapture = $('wzHotkeyCapture') as HTMLButtonElement
  wzCapture.addEventListener('click', async () => {
    wzCapture.disabled = true
    wzHotkey.textContent = '…'
    wzHotkey.classList.add('capturing')
    const captured = await v.captureHotkey()
    wzHotkey.classList.remove('capturing')
    wzCapture.disabled = false
    if (captured && comboWritesChar(captured)) {
      // Touche textuelle seule : elle s'écrirait dans le texte → on refuse.
      wzHotkey.textContent = fmt(hotkey)
      showToast('« ' + fmt(captured) + ' » s’écrirait dans ton texte. Ajoute Ctrl/Alt/Maj ou une touche F1–F12.')
    } else if (captured) {
      await v.setSettings({ hotkey: captured })
      wzHotkey.textContent = fmt(captured)
    } else {
      wzHotkey.textContent = fmt(hotkey)
    }
  })
}

// ─────────────────────────────────────────────────── navigation (sidebar) ──

function setupNav(): void {
  const items = Array.from(document.querySelectorAll<HTMLButtonElement>('.nav-item'))
  const panels = Array.from(document.querySelectorAll<HTMLElement>('.panel'))
  const content = document.querySelector('.content') as HTMLElement
  items.forEach((it) => {
    it.addEventListener('click', () => {
      const key = it.dataset.nav
      items.forEach((x) => x.classList.toggle('active', x === it))
      // retirer .active partout puis l'ajouter au bon panneau → la cascade rejoue
      panels.forEach((p) => p.classList.remove('active'))
      const target = panels.find((p) => p.dataset.panel === key)
      if (target) target.classList.add('active')
      content.scrollTop = 0
      requestAnimationFrame(positionAllSeg) // le panneau cible est maintenant visible
    })
  })
}

/** Place l'indicateur coulissant de chaque contrôle segmenté sous l'option cochée. */
function positionAllSeg(): void {
  document.querySelectorAll<HTMLElement>('.seg').forEach((seg) => {
    const ind = seg.querySelector('.seg-ind') as HTMLElement | null
    const checked = seg.querySelector('input:checked') as HTMLInputElement | null
    if (!ind || !checked) return
    const label = checked.closest('label') as HTMLElement | null
    if (!label || label.offsetParent === null) return // panneau caché → repositionné à l'affichage
    ind.style.left = label.offsetLeft + 'px'
    ind.style.width = label.offsetWidth + 'px'
  })
}

/** Crée l'indicateur de chaque segment et le fait glisser au changement. */
function setupSeg(): void {
  document.querySelectorAll<HTMLElement>('.seg').forEach((seg) => {
    if (!seg.querySelector('.seg-ind')) {
      const ind = document.createElement('div')
      ind.className = 'seg-ind'
      seg.prepend(ind)
    }
    seg.querySelectorAll<HTMLInputElement>('input').forEach((inp) => {
      inp.addEventListener('change', () => positionAllSeg())
    })
  })
  requestAnimationFrame(positionAllSeg)
}

/** Rejoue la transition du panneau visible (fenêtre créée cachée → l'entrée se jouait à vide). */
function revealActivePanel(): void {
  const p = document.querySelector('.panel.active') as HTMLElement | null
  if (!p) return
  p.classList.remove('active')
  void p.offsetWidth // reflow → le pageIn rejoue à la ré-ajout de .active
  p.classList.add('active')
  requestAnimationFrame(positionAllSeg)
}
v.onSettingsShown(() => {
  revealActivePanel()
  void renderHistory() // la liste peut avoir changé pendant que la fenêtre était masquée
})
v.onHistoryChanged(() => void renderHistory()) // nouvelle dictée → rafraîchit en direct
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    revealActivePanel()
    void renderHistory()
  }
})

// ──────────────────────────────────────────────────────────────────── init ──

// ────────────────────────────────────────── changelog (nouveautés MAJ) ──

function renderChangelog(cl: { version: string; changes: string[] }): void {
  $('clVer').textContent = 'v' + cl.version
  $('clList').innerHTML = cl.changes.map((c) => `<li>${escapeHtml(c)}</li>`).join('')
  $('changelog').classList.add('show')
}

async function init(): Promise<void> {
  const s = await v.getSettings()

  setupNav()

  // version + vérification des mises à jour
  v.getVersion().then((ver) => ($('appVer').textContent = 'v' + ver))
  const doCheck = (): void => void v.checkUpdate()
  $('checkUpdate').addEventListener('click', doCheck)
  $('checkUpdate2').addEventListener('click', doCheck)

  // désinstallation complète (app + modèles + données) — confirmation INTERNE (modal in-app)
  const unModal = $('uninstall')
  const closeUninstall = (): void => unModal.classList.remove('show', 'busy')
  ;($('uninstallBtn') as HTMLButtonElement).addEventListener('click', () => {
    unModal.classList.remove('busy')
    unModal.classList.add('show')
  })
  $('unCancel').addEventListener('click', closeUninstall)
  // clic sur le fond (hors carte) = annuler
  unModal.addEventListener('click', (e) => {
    if (e.target === unModal) closeUninstall()
  })
  // Échap = annuler (tant que la désinstallation n'est pas lancée)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && unModal.classList.contains('show') && !unModal.classList.contains('busy'))
      closeUninstall()
  })
  ;($('unConfirm') as HTMLButtonElement).addEventListener('click', async () => {
    unModal.classList.add('busy') // bascule sur l'écran « en cours », l'app va se fermer
    const res = await v.uninstall()
    // En dev (non packagé) l'app ne se ferme pas : on l'explique dans le modal au lieu d'une pop-up.
    if (res === 'dev') {
      unModal.classList.remove('busy')
      $('unWarn').textContent = 'Indisponible en mode développement (uniquement dans la version installée).'
    }
  })

  // écran PLEIN « mise à jour en cours » : téléchargement → prête → installation (prend toute la fenêtre)
  const us = $('updateScreen')
  const usTitle = $('usTitle')
  const usSub = $('usSub')
  const usFill = $('usFill')
  const usPct = $('usPct')
  let updateInstalling = false

  const showUpdateScreen = (mode: 'downloading' | 'ready' | 'installing', percent = 0): void => {
    us.className = mode // état courant (downloading | ready | installing) — pris en charge par le CSS
    us.classList.add('show')
    if (mode === 'downloading') {
      usTitle.textContent = 'Mise à jour en cours…'
      usSub.textContent = 'Téléchargement de la nouvelle version'
      usFill.style.width = percent + '%'
      usPct.textContent = percent + ' %'
    } else if (mode === 'ready') {
      usTitle.textContent = 'Mise à jour prête'
      usSub.textContent = 'Clique pour redémarrer et installer — ça prend quelques secondes.'
      usFill.style.width = '100%'
    } else {
      usTitle.textContent = 'Installation en cours…'
      usSub.textContent = 'VentaTalk va redémarrer automatiquement.'
    }
  }

  ;($('usInstall') as HTMLButtonElement).addEventListener('click', () => {
    updateInstalling = true
    showUpdateScreen('installing')
    void v.installUpdate()
  })
  v.onUpdateProgress((p) => {
    if (!updateInstalling) showUpdateScreen('downloading', p)
  })
  v.onUpdateReady(() => {
    if (!updateInstalling) showUpdateScreen('ready')
  })
  v.onUpdateFailed(() => {
    if (!updateInstalling) us.classList.remove('show')
  })
  void v.isUpdateReady().then((ready) => {
    if (ready) showUpdateScreen('ready')
  })

  // Aperçu local de l'écran de MAJ — DEV uniquement (pour tester le rendu sans vraie mise à jour).
  if (!(await v.isPackaged())) {
    ;($('previewUpdateRow') as HTMLElement).style.display = ''
    ;($('previewUpdate') as HTMLButtonElement).addEventListener('click', () => {
      updateInstalling = false
      let p = 0
      showUpdateScreen('downloading', 0)
      const timer = setInterval(() => {
        p += 6
        if (p >= 100) {
          clearInterval(timer)
          showUpdateScreen('downloading', 100)
          setTimeout(() => showUpdateScreen('ready'), 600)
        } else {
          showUpdateScreen('downloading', p)
        }
      }, 150)
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') us.classList.remove('show') // Échap ferme l'aperçu (dev)
    })
  }

  // raccourci
  let currentHotkey = s.hotkey
  const hotkeyDisplay = $('hotkeyDisplay') as HTMLSpanElement
  const captureBtn = $('hotkeyCapture') as HTMLButtonElement
  const presetsEl = $('hotkeyPresets')
  const PRESETS = ['F9', 'F8', 'Alt+Space', 'Ctrl+Space', 'Alt+Shift']
  const fmtCombo = (c: string): string => c.replace(/Space/g, 'Espace')
  const showHotkey = (c: string): void => {
    currentHotkey = c
    hotkeyDisplay.textContent = fmtCombo(c)
  }

  showHotkey(s.hotkey)
  presetsEl.innerHTML = PRESETS.map((p) => `<label data-preset="${p}">${fmtCombo(p)}</label>`).join('')
  presetsEl.querySelectorAll<HTMLElement>('[data-preset]').forEach((el) => {
    el.addEventListener('click', async () => {
      const p = el.dataset.preset as string
      await v.setSettings({ hotkey: p })
      showHotkey(p)
      showToast('Raccourci : ' + fmtCombo(p))
    })
  })
  captureBtn.addEventListener('click', async () => {
    const label = captureBtn.textContent
    captureBtn.disabled = true
    captureBtn.textContent = 'Appuie sur la combinaison…'
    hotkeyDisplay.textContent = '…'
    hotkeyDisplay.classList.add('capturing')
    const captured = await v.captureHotkey()
    hotkeyDisplay.classList.remove('capturing')
    captureBtn.disabled = false
    captureBtn.textContent = label || 'Changer…'
    if (captured && comboWritesChar(captured)) {
      // Touche textuelle seule : elle s'écrirait dans le texte (uiohook ne peut pas l'avaler) → refus.
      showHotkey(currentHotkey)
      showToast('« ' + fmtCombo(captured) + ' » s’écrirait dans ton texte. Ajoute Ctrl/Alt/Maj ou une touche F1–F12.')
    } else if (captured) {
      await v.setSettings({ hotkey: captured })
      showHotkey(captured)
      showToast('Raccourci : ' + fmtCombo(captured))
    } else {
      showHotkey(currentHotkey)
      showToast('Aucune combinaison détectée')
    }
  })

  // mode (segmenté)
  document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((r) => {
    r.checked = r.value === s.activationMode
    r.addEventListener('change', () => {
      if (r.checked) void v.setSettings({ activationMode: r.value })
    })
  })

  // écriture (segmenté)
  document.querySelectorAll<HTMLInputElement>('input[name="inject"]').forEach((r) => {
    r.checked = r.value === s.injectMode
    r.addEventListener('change', () => {
      if (r.checked) void v.setSettings({ injectMode: r.value })
    })
  })

  // langue
  const langSel = $('language') as HTMLSelectElement
  langSel.innerHTML = LANGUAGES.map(([code, label]) => `<option value="${code}">${label}</option>`).join('')
  langSel.value = s.language
  langSel.addEventListener('change', () => void v.setSettings({ language: langSel.value }))

  // interrupteurs
  const bindToggle = (id: string, key: string): void => {
    const el = $(id) as HTMLInputElement
    el.checked = Boolean((s as Record<string, unknown>)[key])
    el.addEventListener('change', () => {
      void v.setSettings({ [key]: el.checked })
      if (key === 'keepHistory') void renderHistory() // maj du bandeau "désactivé"
    })
  }
  bindToggle('useGpu', 'useGpu')

  // sélecteur de carte graphique (réglages + assistant) : force le moteur whisper, ou auto-détecte
  const bindEngineSelect = (id: string, refresh: () => void): void => {
    const sel = document.getElementById(id) as HTMLSelectElement | null
    if (!sel) return
    sel.value = s.whisperEngine ?? 'auto'
    sel.addEventListener('change', async () => {
      await v.setSettings({ whisperEngine: sel.value as 'auto' | 'cuda' | 'vulkan' })
      document
        .querySelectorAll<HTMLSelectElement>('#whisperEngine, #wzWhisperEngine')
        .forEach((e) => (e.value = sel.value)) // garde les deux sélecteurs synchro
      refresh()
    })
  }
  bindEngineSelect('whisperEngine', () => void renderModels())
  bindEngineSelect('wzWhisperEngine', () => void refreshWizardCards())

  bindToggle('vadEnabled', 'vadEnabled')
  bindToggle('noiseSuppression', 'noiseSuppression')
  bindToggle('aiCleanup', 'aiCleanup')
  bindToggle('keepOnClipboard', 'keepOnClipboard')
  bindToggle('launchAtLogin', 'launchAtLogin')
  bindToggle('soundFeedback', 'soundFeedback')
  bindToggle('muteWhileDictating', 'muteWhileDictating')
  bindToggle('keepHistory', 'keepHistory')

  await populateMics(s.micDeviceId ?? '')
  await populateWzMics(s.micDeviceId ?? '')

  // zones de texte (sauvegarde au change)
  const bindText = (id: string, key: string): void => {
    const el = $(id) as HTMLTextAreaElement
    el.value = ((s as Record<string, unknown>)[key] as string) ?? ''
    el.addEventListener('change', () => void v.setSettings({ [key]: el.value }))
  }
  bindText('vocabulary', 'vocabulary')
  bindText('replacements', 'replacements')

  // historique
  ;($('historyClear') as HTMLButtonElement).addEventListener('click', async () => {
    await v.historyClear()
    await renderHistory()
    showToast('Historique effacé.')
  })
  await renderHistory()

  await renderModels()

  // assistant
  wireOnboarding(s.hotkey)
  ;($('onboardingReplay') as HTMLButtonElement).addEventListener('click', () => showWizard())
  if (!s.onboardingDone) showWizard()

  // « Notes de version » : affiche directement TOUT l'historique (version par version)
  ;($('showChangelog') as HTMLButtonElement).addEventListener('click', async () => {
    const all = await v.changelogAll()
    if (!all.length) {
      showToast('Aucune note de version.')
      return
    }
    $('hlList').innerHTML = all
      .map(
        (c) =>
          `<div class="hl-ver">v${escapeHtml(c.version)}</div><ul>${c.changes
            .map((x) => `<li>${escapeHtml(x)}</li>`)
            .join('')}</ul>`
      )
      .join('')
    $('histLog').classList.add('show')
  })
  ;($('clClose') as HTMLButtonElement).addEventListener('click', () => $('changelog').classList.remove('show'))
  ;($('hlClose') as HTMLButtonElement).addEventListener('click', () => $('histLog').classList.remove('show'))

  setupSeg() // indicateurs coulissants des contrôles segmentés (après réglage des cochés)
  revealActivePanel()

  // après une mise à jour : affiche les nouveautés (consommé une fois côté main)
  const pending = await v.changelogGet()
  if (pending) renderChangelog(pending)
}

void init()
