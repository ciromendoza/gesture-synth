// Sine Pad — el oscilador seno original de audio-engine.js migrado a la
// interfaz SynthVoice. Comportamiento idéntico al previo a la ronda de pads.
import { SynthVoice } from './synth-voice.js';

export class SinePad extends SynthVoice {
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
      this.phases[n] += freqs[n] / this.sampleRate;
      if (this.phases[n] >= 1.0) this.phases[n] -= 1.0;
      sample += Math.sin(2 * Math.PI * this.phases[n]);
    }
    return sample / 3;
  }
}
