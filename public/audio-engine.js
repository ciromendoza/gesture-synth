// Audio Engine — reads chords from SAB config zone, left hand pinch=volume, rotation=effect amount

import { PAD_CLASSES } from './pad-registry.js';

const DENORMAL = 1e-18; // prevent denormal floats

class AudioEngineProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const sab = options.processorOptions?.sab;
    if (sab) {
      this.int32View = new Int32Array(sab);
      this.float32View = new Float32Array(sab);
    }

    this.sampleRate = globalThis.sampleRate || 48000;
    this.sampleIndex = 0;

    // Envelope (pasos de attack/release se calculan desde la voz activa abajo)
    this.envelope = 0.0;
    this.envelopeState = 'OFF';
    this.fastReleaseStep = 1.0 / (0.008 * this.sampleRate); // 8 ms — hot-swap de pad
    this.currentChordIndex = -1;
    this.noteHeld = false;

    // Synth voices — 6 instancias pre-alocadas una sola vez (registry+factory).
    // Cada voz trae su propia envolvente (attackTime/releaseTime, fuente única
    // de default en constants.js); los pasos se recalculan al cambiar de pad.
    this.voices = PAD_CLASSES.map(Cls => new Cls(this.sampleRate));
    this.voice = this.voices[0];
    this.currentPad = -1;
    this.attackStep = 1.0 / (this.voice.attackTime * this.sampleRate);
    this.releaseStep = 1.0 / (this.voice.releaseTime * this.sampleRate);

    // Pre-allocated buffers (no alloc in process!)
    this.dryBuf = new Float32Array(128);
    this.wetBuf = new Float32Array(128);

    // Effect state
    this.delayBuf = new Float32Array(Math.ceil(this.sampleRate));
    this.delayWritePos = 0;
    this.reverbBuf = new Float32Array(Math.ceil(this.sampleRate * 1.2));
    this.reverbWritePos = 0;
    this.reverbTaps = [0, Math.round(0.023 * this.sampleRate), Math.round(0.053 * this.sampleRate),
                       Math.round(0.091 * this.sampleRate), Math.round(0.137 * this.sampleRate)];
    this.filterPrev = 0.0;
    this.crushHold = 0.0;

    // Smoothed params
    this.smoothVol = 0.0;
    this.smoothMix = 0.0;
    this.smoothParam = 0.5;
    this.SMOOTH = 0.12; // faster response, still no clicks

    // LFO phase accumulators — persistent, incremented per-sample.
    // Deriving phase from sampleIndex * rate causes a phase jump every time
    // rate changes, and the jump grows as sampleIndex keeps growing.
    this._chorusPhase = 0;
    this._tremPhase = 0;
    this._tremRate = 2; // smoothed per-sample in fxTremolo
    this._delayTimeTarget = Math.round(0.1 * this.sampleRate); // initial delay 100ms
  }

  clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // Read 6 chords × 3 notes from SAB config zone (float32 index 11–28)
  readChords() {
    const chords = [];
    for (let c = 0; c < 6; c++) {
      const notes = [];
      for (let n = 0; n < 3; n++) {
        notes.push(this.float32View[11 + c * 3 + n]);
      }
      chords.push(notes);
    }
    return chords;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output?.[0]) return true;
    const out = output[0];
    const N = out.length;

    if (!this.int32View || !this.float32View) {
      out.fill(0);
      return true;
    }

    // ─── Read SAB ──────────────────────────────────────────────────────
    const rightDetected = this.int32View[32];
    const fingerCount = this.float32View[33];
    const rightPalmRot = this.float32View[34];
    const leftDetected = this.int32View[96];
    const pinchDist = this.float32View[97];
    const leftPalmRot = this.float32View[98];
    const selectedEffect = this.int32View[10];
    const selectedPad = this.int32View[30];
    const chords = this.readChords();

    // ─── Params ────────────────────────────────────────────────────────
    const rawVol = leftDetected ? pinchDist : 0.7; // pinchDist is already normalized 0–1
    this.smoothVol += (rawVol - this.smoothVol) * this.SMOOTH;

    let chordIndex = -1;
    if (rightDetected === 1 && fingerCount >= -0.5 && fingerCount <= 5.5) {
      const rc = Math.round(fingerCount);
      if (rc === 0) chordIndex = 5;       // fist → 6th chord
      else if (rc >= 1 && rc <= 5) chordIndex = rc - 1; // 1–5 fingers → chords 0–4
    }

    const majorMinorMix = rightPalmRot > 0.35 ? 1.0 : 0.0;

    // Smoothed effect params from rotation
    const rawMix = leftDetected ? this.clamp(leftPalmRot / Math.PI, 0, 1) : 0.0;
    const rawParam = leftDetected ? this.clamp(leftPalmRot / Math.PI, 0, 1) : 0.5;
    this.smoothMix += (rawMix - this.smoothMix) * this.SMOOTH;
    this.smoothParam += (rawParam - this.smoothParam) * this.SMOOTH;

    const volume = this.smoothVol;
    const mix = this.smoothMix;
    const param = this.smoothParam;

    // ─── Pad switch (hot-swap sin click) ─────────────────────────────────
    // Si el usuario cambia de pad con nota sostenida, cortar el render de un
    // synth y arrancar el otro a mitad de ciclo genera una discontinuidad
    // audible (timbres muy distintos no cruzan suave). Fix: RELEASE corto
    // (8 ms) + re-trigger con el ATTACK de la voz nueva, no el completo.
    if (selectedPad !== this.currentPad) {
      const next = this.voices[selectedPad];
      if (next) {
        this.currentPad = selectedPad;
        this.voice = next;
        this.attackStep = 1.0 / (this.voice.attackTime * this.sampleRate);
        this.releaseStep = 1.0 / (this.voice.releaseTime * this.sampleRate);
        if (this.envelope > 0) this.envelopeState = 'QUICK_RELEASE';
      }
    }

    // ─── Envelope ──────────────────────────────────────────────────────
    this.noteHeld = chordIndex >= 0;
    if (chordIndex >= 0) {
      if (this.envelopeState === 'OFF' || this.envelopeState === 'RELEASE') {
        this.voice.noteOn(); // retrigger específico de la voz (fases, ruido KS)
        this.envelopeState = 'ATTACK';
      }
      this.currentChordIndex = chordIndex;
    } else if (this.envelopeState === 'ATTACK' || this.envelopeState === 'SUSTAIN') {
      this.envelopeState = 'RELEASE';
    }

    // ─── Dry generation ────────────────────────────────────────────────
    const chord = chords[this.currentChordIndex];

    for (let i = 0; i < N; i++) {
      // Envelope
      if (this.envelopeState === 'ATTACK') {
        this.envelope += this.attackStep;
        if (this.envelope >= 1.0) { this.envelope = 1.0; this.envelopeState = 'SUSTAIN'; }
      } else if (this.envelopeState === 'QUICK_RELEASE') {
        this.envelope -= this.fastReleaseStep;
        if (this.envelope <= 0.0) {
          this.envelope = 0.0;
          if (this.noteHeld) {
            this.voice.noteOn();
            this.envelopeState = 'ATTACK';
          } else {
            this.envelopeState = 'OFF';
            this.currentChordIndex = -1;
          }
        }
      } else if (this.envelopeState === 'RELEASE') {
        this.envelope -= this.releaseStep;
        if (this.envelope <= 0.0) { this.envelope = 0.0; this.envelopeState = 'OFF'; this.currentChordIndex = -1; }
      }

      let sample = DENORMAL; // denormal guard
      if (this.envelope > 0 && chord) {
        const thirdMinor = chord[1] * Math.pow(2, -1 / 12);
        const third = chord[1] * (1 - majorMinorMix) + thirdMinor * majorMinorMix;
        const freqs = [chord[0], third, chord[2]];
        sample = this.voice.renderSample(freqs);
        sample *= this.envelope;
        sample *= volume;
      }
      this.dryBuf[i] = sample;
      this.sampleIndex++;
    }

    // ─── Effect ────────────────────────────────────────────────────────
    for (let i = 0; i < N; i++) {
      let p = this.dryBuf[i];
      switch (selectedEffect) {
        case 0: p = this.fxReverb(this.dryBuf[i], param); break;
        case 1: p = this.fxChorus(this.dryBuf[i], param); break;
        case 2: p = this.fxBitcrush(this.dryBuf[i], param); break;
        case 3: p = this.fxFilter(this.dryBuf[i], param); break;
        case 4: p = this.fxDelay(this.dryBuf[i], param); break;
        case 5: p = this.fxTremolo(this.dryBuf[i], param); break;
      }
      this.wetBuf[i] = this.dryBuf[i] * (1 - mix) + p * mix;
    }

    // ─── Output soft-clip ──────────────────────────────────────────────
    for (let i = 0; i < N; i++) {
      let s = this.wetBuf[i];
      // Soft saturation
      if (s > 0.95) s = 0.95 + (s - 0.95) * 0.3;
      else if (s < -0.95) s = -0.95 + (s + 0.95) * 0.3;
      // Hard clip
      if (s > 1.0) s = 1.0;
      else if (s < -1.0) s = -1.0;
      out[i] = s;
    }
    if (output[1]) output[1].set(out);

    // ─── Write SAB ─────────────────────────────────────────────────────
    this.float32View[160] = volume;
    this.float32View[161] = (chordIndex >= 0 && chord) ? chord[0] : 0.0;
    this.int32View[162] = chordIndex;
    this.float32View[163] = majorMinorMix;
    this.float32View[164] = mix;
    this.float32View[165] = param;
    this.float32View[166] = this.envelope;

    // Oscilloscope
    const oscOff = 167;
    const step = Math.max(1, Math.floor(N / 25));
    for (let k = 0; k < 25; k++) {
      this.float32View[oscOff + k] = this.wetBuf[Math.min(k * step, N - 1)];
    }

    return true;
  }

  // ─── Effects (no clipping, no boosts) ─────────────────────────────────

  fxReverb(sample, param) {
    const idx = this.reverbWritePos;
    this.reverbBuf[idx] = sample + DENORMAL;
    let sum = 0;
    const decay = 0.3 + param * 0.35; // 0.30–0.65: audible tail at all param values
    for (let t = 0; t < this.reverbTaps.length; t++) {
      const tapIdx = (idx - this.reverbTaps[t] + this.reverbBuf.length) % this.reverbBuf.length;
      sum += this.reverbBuf[tapIdx] * Math.pow(decay, t + 1);
    }
    this.reverbWritePos = (idx + 1) % this.reverbBuf.length;
    return this.clamp(sum, -1.0, 1.0); // pass through, no extra scaling
  }

  fxChorus(sample, param) {
    // Vibrato/chorus: audible pitch wobble across full param range
    const depth = 0.02 + param * 0.06; // 2–8% modulation — clearly audible
    const rate = 3 + param * 8;
    // Persistent phase accumulator — sampleIndex * rate would jump when rate changes
    this._chorusPhase += (2 * Math.PI * rate) / this.sampleRate;
    if (this._chorusPhase >= 2 * Math.PI) this._chorusPhase -= 2 * Math.PI;
    return sample * (1 + depth * Math.sin(this._chorusPhase));
  }

  fxBitcrush(sample, param) {
    // Aggressive bit reduction: 12-bit (transparent) down to 3-bit (obvious crush)
    const bits = Math.round(12 - param * 9);
    const levels = Math.pow(2, bits);
    this.crushHold = Math.round(sample * levels) / levels;
    return this.crushHold;
  }

  fxFilter(sample, param) {
    // One-pole low-pass with correct sample-rate coefficient.
    // param sweeps cutoff logarithmically 150 Hz (param=1) → 8000 Hz (param=0),
    // perceptually linear so the sweep sounds continuous, not like a switch.
    const minFreq = 150, maxFreq = 8000;
    const cutoffHz = minFreq * Math.pow(maxFreq / minFreq, 1 - param);
    const a = Math.exp(-2.0 * Math.PI * cutoffHz / this.sampleRate);
    this.filterPrev = this.filterPrev * a + sample * (1 - a) + DENORMAL;
    return this.filterPrev;
  }

  fxDelay(sample, param) {
    // Smooth delay time per-sample to avoid read-position jumps
    const target = (0.1 + param * 0.35) * this.sampleRate;
    this._delayTimeTarget += (target - this._delayTimeTarget) * this.SMOOTH;
    // Fractional interpolation between the two nearest buffer positions —
    // avoids zipper noise when the (smoothed) delay time crosses integer samples
    const delayTimeF = this.clamp(this._delayTimeTarget, 1, this.delayBuf.length - 2);
    const delayTimeInt = Math.floor(delayTimeF);
    const frac = delayTimeF - delayTimeInt;
    const readPos0 = (this.delayWritePos - delayTimeInt + this.delayBuf.length) % this.delayBuf.length;
    const readPos1 = (readPos0 - 1 + this.delayBuf.length) % this.delayBuf.length;
    const delayed = this.delayBuf[readPos0] * (1 - frac) + this.delayBuf[readPos1] * frac;
    const fb = this.clamp(0.15 + param * 0.15, 0, 0.3);
    this.delayBuf[this.delayWritePos] = sample + delayed * fb + DENORMAL;
    this.delayWritePos = (this.delayWritePos + 1) % this.delayBuf.length;
    return sample * 0.7 + delayed * 0.3;
  }

  fxTremolo(sample, param) {
    // Smooth rate per-sample to avoid LFO phase discontinuities at block boundaries
    const targetRate = 2 + param * 6;
    this._tremRate += (targetRate - this._tremRate) * this.SMOOTH;
    const depth = this.clamp(param * 0.6, 0, 0.6);
    // Persistent phase accumulator (see fxChorus)
    this._tremPhase += (2 * Math.PI * this._tremRate) / this.sampleRate;
    if (this._tremPhase >= 2 * Math.PI) this._tremPhase -= 2 * Math.PI;
    const lfo = 1.0 - depth * 0.5 * (1 + Math.sin(this._tremPhase));
    return sample * lfo;
  }
}

registerProcessor('gesture-synthesizer', AudioEngineProcessor);
