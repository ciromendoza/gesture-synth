// Square Pad — pulso duty 50% con anti-aliasing PolyBLEP.
import { SynthVoice } from './synth-voice.js';
import { polyBLEP } from './polyblep.js';

export class SquarePad extends SynthVoice {
  constructor(sampleRate) {
    super(sampleRate);
    this.phases = [0, 0, 0, 0];
  }

  noteOn() {
    this.phases[0] = 0;
    this.phases[1] = 0;
    this.phases[2] = 0;
    this.phases[3] = 0;
  }

  renderSample(freqs, toneCount = 3, seventhMix = 0) {
    const extension = toneCount === 4 ? (seventhMix > 0 ? seventhMix : 1) : seventhMix;
    let sample = 0;
    for (let n = 0; n < 3; n++) {
      const dt = freqs[n] / this.sampleRate;
      this.phases[n] += dt;
      if (this.phases[n] >= 1.0) this.phases[n] -= 1.0;
      const t = this.phases[n];
      const t2 = t >= 0.5 ? t - 0.5 : t + 0.5;
      const sawA = 2.0 * t - 1.0 - polyBLEP(t, dt);
      const sawB = 2.0 * t2 - 1.0 - polyBLEP(t2, dt);
      sample += sawA - sawB;
    }
    if (extension > 0) {
      const dt = freqs[3] / this.sampleRate;
      this.phases[3] += dt;
      if (this.phases[3] >= 1.0) this.phases[3] -= 1.0;
      const t = this.phases[3];
      const t2 = t >= 0.5 ? t - 0.5 : t + 0.5;
      const sawA = 2.0 * t - 1.0 - polyBLEP(t, dt);
      const sawB = 2.0 * t2 - 1.0 - polyBLEP(t2, dt);
      sample += (sawA - sawB) * extension;
    }
    return sample / (3 + extension);
  }
}
