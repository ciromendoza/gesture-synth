// FM Bell Pad — modulación de frecuencia de 2 operadores por tono.
import { SynthVoice } from './synth-voice.js';

const TWO_PI = 2 * Math.PI;
const MOD_RATIO = 2.4;
const MOD_INDEX = 3.5;

export class FmBellPad extends SynthVoice {
  constructor(sampleRate) {
    super(sampleRate);
    this.carrierPhase = [0, 0, 0, 0];
    this.modPhase = [0, 0, 0, 0];
  }

  noteOn() {
    this.carrierPhase[0] = 0;
    this.carrierPhase[1] = 0;
    this.carrierPhase[2] = 0;
    this.carrierPhase[3] = 0;
    this.modPhase[0] = 0;
    this.modPhase[1] = 0;
    this.modPhase[2] = 0;
    this.modPhase[3] = 0;
  }

  renderSample(freqs, toneCount = 3, seventhMix = 0) {
    const extension = toneCount === 4 ? (seventhMix > 0 ? seventhMix : 1) : seventhMix;
    let sample = 0;
    for (let n = 0; n < 3; n++) {
      const f = freqs[n];
      this.modPhase[n] += (TWO_PI * f * MOD_RATIO) / this.sampleRate;
      if (this.modPhase[n] >= TWO_PI) this.modPhase[n] -= TWO_PI;
      this.carrierPhase[n] += (TWO_PI * f) / this.sampleRate;
      if (this.carrierPhase[n] >= TWO_PI) this.carrierPhase[n] -= TWO_PI;
      sample += Math.sin(this.carrierPhase[n] + MOD_INDEX * Math.sin(this.modPhase[n]));
    }
    if (extension > 0) {
      const f = freqs[3];
      this.modPhase[3] += (TWO_PI * f * MOD_RATIO) / this.sampleRate;
      if (this.modPhase[3] >= TWO_PI) this.modPhase[3] -= TWO_PI;
      this.carrierPhase[3] += (TWO_PI * f) / this.sampleRate;
      if (this.carrierPhase[3] >= TWO_PI) this.carrierPhase[3] -= TWO_PI;
      sample += Math.sin(this.carrierPhase[3] + MOD_INDEX * Math.sin(this.modPhase[3])) * extension;
    }
    return sample / (3 + extension);
  }
}
