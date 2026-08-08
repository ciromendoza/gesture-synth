// Sine Pad — osciladores seno para la triada o la séptima activa.
import { SynthVoice } from './synth-voice.js';

export class SinePad extends SynthVoice {
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
      this.phases[n] += freqs[n] / this.sampleRate;
      if (this.phases[n] >= 1.0) this.phases[n] -= 1.0;
      sample += Math.sin(2 * Math.PI * this.phases[n]);
    }
    if (extension > 0) {
      this.phases[3] += freqs[3] / this.sampleRate;
      if (this.phases[3] >= 1.0) this.phases[3] -= 1.0;
      sample += Math.sin(2 * Math.PI * this.phases[3]) * extension;
    }
    return sample / (3 + extension);
  }
}
