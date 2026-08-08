// Square Pad — pulso (duty 50%) con anti-aliasing PolyBLEP.
// square(t) = saw(t) − saw(t + 0.5): dos sierras desfasadas media fase
// restadas dan exactamente ±1. Cada discontinuidad del pulso hereda el
// suavizado BLEP de la sierra correspondiente — sin clicks al envolver.
import { SynthVoice } from './synth-voice.js';
import { polyBLEP } from './polyblep.js';

export class SquarePad extends SynthVoice {
  constructor(sampleRate) {
    super(sampleRate);
    this.phases = [0, 0, 0];
  }

  noteOn() {
    this.phases[0] = 0;
    this.phases[1] = 0;
    this.phases[2] = 0;
  }

  renderSample(freqs) {
    let sample = 0;
    for (let n = 0; n < 3; n++) {
      const dt = freqs[n] / this.sampleRate;
      this.phases[n] += dt;
      if (this.phases[n] >= 1.0) this.phases[n] -= 1.0;
      const t = this.phases[n];
      const t2 = t >= 0.5 ? t - 0.5 : t + 0.5; // fase desfasada media vuelta
      const sawA = 2.0 * t - 1.0 - polyBLEP(t, dt);
      const sawB = 2.0 * t2 - 1.0 - polyBLEP(t2, dt);
      sample += sawA - sawB;
    }
    return sample / 3;
  }
}
