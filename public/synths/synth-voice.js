// SynthVoice — interfaz común de los 5 pads (contract.md sección 8.3).
// audio-engine.js maneja envolvente, volumen, efectos y soft-clip de forma
// compartida; cada voz solo genera UNA muestra y gestiona su propio estado
// (fases, buffers), pre-alocado TODO en el constructor.
import { ATTACK_TIME, RELEASE_TIME } from '../constants.js';

export class SynthVoice {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    // Envolvente por voz (segundos). Default = ADSR global (fuente única:
    // constants.js).
    this.attackTime = ATTACK_TIME;
    this.releaseTime = RELEASE_TIME;
  }

  // Genera una muestra en [-1, 1] a partir de las 3 frecuencias activas
  // del acorde (ya ajustadas por mayor/menor en audio-engine.js).
  renderSample(freqs) {
    return 0;
  }

  // Retrigger: reset de fases / recarga de buffers.
  // Los pads sostenidos pueden dejarlo vacío.
  noteOn() {}
}
