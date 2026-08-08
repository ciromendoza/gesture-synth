// Saw Pad — diente de sierra con anti-aliasing PolyBLEP.
import { SynthVoice } from './synth-voice.js';
import { polyBLEP } from './polyblep.js';

export class SawPad extends SynthVoice {
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
      const naive = 2.0 * this.phases[n] - 1.0;
      sample += naive - polyBLEP(this.phases[n], dt);
    }
    if (extension > 0) {
      const dt = freqs[3] / this.sampleRate;
      this.phases[3] += dt;
      if (this.phases[3] >= 1.0) this.phases[3] -= 1.0;
      const naive = 2.0 * this.phases[3] - 1.0;
      sample += (naive - polyBLEP(this.phases[3], dt)) * extension;
    }
    return sample / (3 + extension);
  }
}
