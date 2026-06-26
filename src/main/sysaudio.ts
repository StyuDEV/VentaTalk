// Coupe le son SYSTÈME (sortie par défaut) pendant la dictée, puis le restaure.
//
// Contrainte du hub : AUCUN module natif à compiler (chemin avec espaces). On réutilise donc
// le pattern "sidecar" (comme whisper-server) : un process PowerShell PERSISTANT qui charge
// une fois l'interop COM Core Audio (IAudioEndpointVolume) puis lit "mute"/"unmute" sur stdin
// — latence ~0 après le démarrage. On mémorise l'état mute précédent pour ne pas réactiver le
// son chez quelqu'un qui l'avait coupé lui-même.

import { spawn, type ChildProcess } from 'node:child_process'

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace VentaSysAudio {
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
  }
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr pNotify);
    int UnregisterControlChangeNotify(IntPtr pNotify);
    int GetChannelCount(out uint pnChannelCount);
    int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
    int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
    int GetMasterVolumeLevel(out float pfLevelDB);
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid pguidEventContext);
    int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid pguidEventContext);
    int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
    int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
  }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  public class MMDeviceEnumeratorComObject { }
  public static class Vol {
    static IAudioEndpointVolume Get() {
      var en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
      IMMDevice dev;
      Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev)); // eRender, eMultimedia
      Guid iid = typeof(IAudioEndpointVolume).GUID;
      object o;
      Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o)); // CLSCTX_ALL
      return (IAudioEndpointVolume)o;
    }
    public static bool GetMute() { bool m; Marshal.ThrowExceptionForHR(Get().GetMute(out m)); return m; }
    public static void SetMute(bool mute) { Guid ctx = Guid.Empty; Marshal.ThrowExceptionForHR(Get().SetMute(mute, ref ctx)); }
  }
}
"@
$prev = $false
[Console]::Out.WriteLine('READY')
while (($line = [Console]::In.ReadLine()) -ne $null) {
  try {
    if ($line -eq 'mute') { $prev = [VentaSysAudio.Vol]::GetMute(); [VentaSysAudio.Vol]::SetMute($true) }
    elseif ($line -eq 'unmute') { [VentaSysAudio.Vol]::SetMute($prev) }
    elseif ($line -eq 'exit') { break }
  } catch { }
}
`

let proc: ChildProcess | null = null
let starting: Promise<void> | null = null
let enabled = false

function encode(s: string): string {
  return Buffer.from(s, 'utf16le').toString('base64')
}

/** Démarre le sidecar (idempotent). Résout dès que le type COM est chargé (signal "READY"). */
function start(): Promise<void> {
  if (proc) return Promise.resolve()
  if (starting) return starting
  starting = new Promise<void>((resolve) => {
    let p: ChildProcess
    try {
      p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encode(PS_SCRIPT)], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore']
      })
    } catch {
      resolve()
      return
    }
    proc = p
    let resolved = false
    const finish = (): void => {
      if (!resolved) {
        resolved = true
        resolve()
      }
    }
    p.stdout?.on('data', (d: Buffer) => {
      if (d.toString().includes('READY')) finish()
    })
    p.once('error', () => {
      proc = null
      finish()
    })
    p.once('exit', () => {
      proc = null
    })
    setTimeout(finish, 5000) // filet : ne pas bloquer si "READY" n'arrive pas
  })
  void starting.finally(() => {
    starting = null
  })
  return starting
}

function send(cmd: string): void {
  try {
    proc?.stdin?.write(cmd + '\n')
  } catch {
    /* noop */
  }
}

/** (Pré)chauffe le sidecar si la fonction est activée. Appelé au démarrage et à chaque réglage. */
export async function configureSysAudioMute(on: boolean): Promise<void> {
  enabled = on
  if (on) await start()
}

/** Coupe le son système si la fonction est activée. Non bloquant côté appelant (à void). */
export async function muteSystemAudio(): Promise<void> {
  if (!enabled) return
  await start()
  send('mute')
}

/** Restaure le son système (à l'état précédent la coupure). Toujours sûr à appeler. */
export function unmuteSystemAudio(): void {
  send('unmute')
}

/** Restaure le son puis arrête le sidecar (à l'extinction de l'app). */
export function disposeSysAudio(): void {
  send('unmute')
  send('exit')
  try {
    proc?.stdin?.end()
  } catch {
    /* noop */
  }
  const p = proc
  proc = null
  setTimeout(() => {
    try {
      p?.kill()
    } catch {
      /* noop */
    }
  }, 200)
}
