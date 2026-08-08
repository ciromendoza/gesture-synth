// SynthVoice — interfaz común de los pads.
// audio-engine.js maneja envolvente, volumen, efectos y soft-clip; cada voz
// solo genera una muestra y gestiona su propio estado (fases, buffers), todo
// pre-alocado en el constructor.
import { ATTACK_TIME, RELEASE_TIME } from '../constants.js';

export class SynthVoice {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.attackTime = ATTACK_TIME;
    this.releaseTime = RELEASE_TIME;
  }

  // `freqs` tiene cuatro posiciones: triada + séptima. toneCount es 3 en el
  // gesto normal y 4 durante el giro a la izquierda. seventhMix permite que
  // la cuarta voz entre/salga gradualmente sin discontinuidades.
  renderSample(freqs, toneCount = 3, seventhMix = 0) {
    return 0;
  }

  // Retrigger: reset de fases / recarga de buffers.
  noteOn() {}
}
