// FM Bell Pad — modulación de frecuencia de 2 operadores (estilo Chowning):
// un modulador con ratio fijo desplaza la fase del portador y genera
// parciales inarmónicos de tipo campana. El ADSR global lo sostiene como un
// "bell" continuo.
import { SynthVoice } from './synth-voice.js';

const TWO_PI = 2 * Math.PI;
const MOD_RATIO = 2.4; // modulador/portador — parciales inarmónicos de campana
const MOD_INDEX = 3.5; // índice de modulación fijo — brillo del timbre

export class FmBellPad extends SynthVoice {
  constructor(sampleRate) {
    super(sampleRate);
    this.carrierPhase = [0, 0, 0];
    this.modPhase = [0, 0, 0];
  }

  noteOn() {
    this.carrierPhase[0] = 0;
    this.carrierPhase[1] = 0;
    this.carrierPhase[2] = 0;
    this.modPhase[0] = 0;
    this.modPhase[1] = 0;
    this.modPhase[2] = 0;
  }

  renderSample(freqs) {
    let sample = 0;
    for (let n = 0; n < 3; n++) {
      const f = freqs[n];
      this.modPhase[n] += (TWO_PI * f * MOD_RATIO) / this.sampleRate;
      if (this.modPhase[n] >= TWO_PI) this.modPhase[n] -= TWO_PI;
      this.carrierPhase[n] += (TWO_PI * f) / this.sampleRate;
      if (this.carrierPhase[n] >= TWO_PI) this.carrierPhase[n] -= TWO_PI;
      sample += Math.sin(this.carrierPhase[n] + MOD_INDEX * Math.sin(this.modPhase[n]));
    }
    return sample / 3;
  }
}
