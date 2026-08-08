// Wavetable Pad — tabla fija pre-calculada en el constructor.
import { SynthVoice } from './synth-voice.js';

const TWO_PI = 2 * Math.PI;
const TABLE_SIZE = 2048;
const HARMONICS = 8;

export class WavetablePad extends SynthVoice {
  constructor(sampleRate) {
    super(sampleRate);
    this.table = new Float32Array(TABLE_SIZE);
    let norm = 0;
    for (let h = 1; h <= HARMONICS; h++) norm += 1 / h;
    for (let i = 0; i < TABLE_SIZE; i++) {
      const p = (i / TABLE_SIZE) * TWO_PI;
      let s = 0;
      for (let h = 1; h <= HARMONICS; h++) s += Math.sin(p * h) / h;
      this.table[i] = s / norm;
    }
    this.phases = [0, 0, 0, 0]; // en unidades de tabla [0, TABLE_SIZE)
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
      this.phases[n] += (freqs[n] / this.sampleRate) * TABLE_SIZE;
      if (this.phases[n] >= TABLE_SIZE) this.phases[n] -= TABLE_SIZE;
      const i0 = Math.floor(this.phases[n]);
      const frac = this.phases[n] - i0;
      const i1 = (i0 + 1) % TABLE_SIZE;
      sample += this.table[i0] * (1 - frac) + this.table[i1] * frac;
    }
    if (extension > 0) {
      this.phases[3] += (freqs[3] / this.sampleRate) * TABLE_SIZE;
      if (this.phases[3] >= TABLE_SIZE) this.phases[3] -= TABLE_SIZE;
      const i0 = Math.floor(this.phases[3]);
      const frac = this.phases[3] - i0;
      const i1 = (i0 + 1) % TABLE_SIZE;
      sample += (this.table[i0] * (1 - frac) + this.table[i1] * frac) * extension;
    }
    return sample / (3 + extension);
  }
}
