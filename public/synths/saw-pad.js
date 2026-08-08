// Saw Pad — diente de sierra con anti-aliasing PolyBLEP.
// Una sierra naive (2t - 1) alía fuerte en frecuencias altas: el BLEP
// (band-limited step) se resta del valor crudo para suavizar la
// discontinuidad de envoltura (t≈0 y t≈1) — la onda sale sin clicks ásperos.
import { SynthVoice } from './synth-voice.js';
import { polyBLEP } from './polyblep.js';

export class SawPad extends SynthVoice {
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
      const naive = 2.0 * this.phases[n] - 1.0;
      sample += naive - polyBLEP(this.phases[n], dt);
    }
    return sample / 3;
  }
}
