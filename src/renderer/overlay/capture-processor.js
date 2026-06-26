// AudioWorklet : capture le micro hors du thread UI (pas de glitch/troncature).
// Poste chaque bloc Float32 (16 kHz mono) au thread principal. Sortie silencieuse
// (nécessaire pour que le nœud soit "tiré" par le graphe audio).
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (input && input[0]) {
      this.port.postMessage(input[0].slice(0))
    }
    return true
  }
}
registerProcessor('capture', CaptureProcessor)
