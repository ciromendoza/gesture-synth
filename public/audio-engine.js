// Audio Engine — reads chords from SAB config zone, left hand pinch=volume, rotation=effect amount

import { PAD_CLASSES } from './pad-registry.js';
import {
  INDEXES,
  PALM_ROTATION_RELEASE_THRESHOLD,
  PALM_ROTATION_THRESHOLD
} from './constants.js';

const DENORMAL = 1e-18; // prevent denormal floats
const TWO_PI = 2 * Math.PI;
const MINOR_THIRD_RATIO = Math.pow(2, -1 / 12);
const AUDIO_SILENCE_EPS = 0.0005;
const EFFECT_TAIL_EPS = 1e-6;
const MAX_RENDER_QUANTUM = 128;

class AudioEngineProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const sab = options.processorOptions?.sab;
    if (sab) {
      this.int32View = new Int32Array(sab);
      this.float32View = new Float32Array(sab);
    }

    this.sampleRate = globalThis.sampleRate || 48000;

    // Envelope (steps are calculated from the active voice below)
    this.envelope = 0.0;
    this.envelopeState = 'OFF';
    this.fastReleaseStep = 1.0 / (0.008 * this.sampleRate); // 8 ms — hot-swap de pad
    this.currentChordIndex = -1;
    this.noteHeld = false;
    this.majorMinorMix = 0.0;
    this.seventhActive = false;
    this.seventhMix = 0.0;
    this.rotationGesture = 0; // -1 seventh, 0 major, +1 minor

    // Synth voices are instantiated once. The current project ships five
    // catalog entries; adding a voice only requires extending the registry.
    this.voices = PAD_CLASSES.map(Cls => new Cls(this.sampleRate));
    this.voice = this.voices[0];
    this.currentPad = -1;
    this.attackStep = 1.0 / (this.voice.attackTime * this.sampleRate);
    this.releaseStep = 1.0 / (this.voice.releaseTime * this.sampleRate);

    // Pre-allocated buffers. Nothing in process() creates arrays or objects.
    this.dryBuf = new Float32Array(MAX_RENDER_QUANTUM);
    this.wetBuf = new Float32Array(MAX_RENDER_QUANTUM);
    this.renderFreqs = new Float32Array(4);

    // Effect state
    this.delayBuf = new Float32Array(Math.ceil(this.sampleRate));
    this.delayWritePos = 0;
    this.reverbBuf = new Float32Array(Math.ceil(this.sampleRate * 1.2));
    this.reverbWritePos = 0;
    this.reverbTaps = [0, Math.round(0.023 * this.sampleRate), Math.round(0.053 * this.sampleRate),
                       Math.round(0.091 * this.sampleRate), Math.round(0.137 * this.sampleRate)];
    this.reverbGains = new Float32Array(this.reverbTaps.length);
    this.filterPrev = 0.0;
    this.crushHold = 0.0;
    this.effectTailActive = false;
    this.effectsBypassed = true;

    // Per-block effect coefficients. Parameters are read once per audio
    // quantum; keeping these out of the sample loop removes expensive pow/exp
    // calls without changing the smoothing behavior between blocks.
    this.reverbDecay = 0.3;
    this.bitLevels = 4096;
    this.filterA = 0.0;
    this.chorusDepth = 0.02;
    this.chorusPhaseStep = 0.0;
    this.delayTargetSamples = 0.1 * this.sampleRate;
    this.delayFeedback = 0.15;
    this.tremTargetRate = 2;
    this.tremDepth = 0;

    // Smoothed params
    this.smoothVol = 0.0;
    this.smoothMix = 0.0;
    this.smoothParam = 0.5;
    this.SMOOTH = 0.12; // faster response, still no clicks

    // LFO phase accumulators — persistent, incremented per-sample.
    this._chorusPhase = 0;
    this._tremPhase = 0;
    this._tremRate = 2; // smoothed per-sample in fxTremolo
    this._delayTimeTarget = Math.round(0.1 * this.sampleRate); // initial delay 100ms
  }

  clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  updateRotationGesture(rotation) {
    if (this.rotationGesture === 1) {
      if (rotation < PALM_ROTATION_RELEASE_THRESHOLD) this.rotationGesture = 0;
    } else if (this.rotationGesture === -1) {
      if (rotation > -PALM_ROTATION_RELEASE_THRESHOLD) this.rotationGesture = 0;
    } else if (rotation > PALM_ROTATION_THRESHOLD) {
      this.rotationGesture = 1;
    } else if (rotation < -PALM_ROTATION_THRESHOLD) {
      this.rotationGesture = -1;
    }
    return this.rotationGesture;
  }

  prepareEffectParams(param) {
    this.reverbDecay = 0.3 + param * 0.35;
    let gain = this.reverbDecay;
    for (let t = 0; t < this.reverbGains.length; t++) {
      this.reverbGains[t] = gain;
      gain *= this.reverbDecay;
    }

    const bits = Math.round(12 - param * 9);
    this.bitLevels = Math.pow(2, bits);

    const minFreq = 150;
    const maxFreq = 8000;
    const cutoffHz = minFreq * Math.pow(maxFreq / minFreq, 1 - param);
    this.filterA = Math.exp(-2.0 * Math.PI * cutoffHz / this.sampleRate);

    const chorusRate = 3 + param * 8;
    this.chorusDepth = 0.02 + param * 0.06;
    this.chorusPhaseStep = (TWO_PI * chorusRate) / this.sampleRate;

    this.delayTargetSamples = (0.1 + param * 0.35) * this.sampleRate;
    this.delayFeedback = this.clamp(0.15 + param * 0.15, 0, 0.3);

    this.tremTargetRate = 2 + param * 6;
    this.tremDepth = this.clamp(param * 0.6, 0, 0.6);
  }

  resetEffects() {
    this.delayBuf.fill(0);
    this.reverbBuf.fill(0);
    this.delayWritePos = 0;
    this.reverbWritePos = 0;
    this.filterPrev = 0.0;
    this.crushHold = 0.0;
    this._chorusPhase = 0;
    this._tremPhase = 0;
    this._tremRate = 2;
    this._delayTimeTarget = Math.round(0.1 * this.sampleRate);
    this.effectTailActive = false;
  }

  writeSilentState(volume, mix, param) {
    this.float32View[160] = volume;
    this.float32View[161] = 0.0;
    this.int32View[162] = -1;
    this.float32View[163] = 0.0;
    this.float32View[164] = mix;
    this.float32View[165] = param;
    this.float32View[166] = 0.0;
    Atomics.store(this.int32View, INDEXES.AUDIO_SEVENTH_ACTIVE, 0);
    for (let k = 0; k < 25; k++) this.float32View[167 + k] = 0.0;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output?.[0]) return true;
    const out = output[0];
    const N = out.length;

    if (!this.int32View || !this.float32View || N > MAX_RENDER_QUANTUM) {
      out.fill(0);
      if (output[1]) output[1].fill(0);
      return true;
    }

    // ─── Read SAB ──────────────────────────────────────────────────────
    const rightDetected = Atomics.load(this.int32View, 32);
    const fingerCount = this.float32View[33];
    const rightPalmRot = this.float32View[34];
    const leftDetected = Atomics.load(this.int32View, 96);
    const pinchDist = this.float32View[97];
    const leftPalmRot = this.float32View[98];
    const selectedEffect = this.int32View[10];
    const selectedPad = this.int32View[30];

    // ─── Params ────────────────────────────────────────────────────────
    const rawVol = leftDetected ? pinchDist : 0.7; // pinchDist is normalized 0–1
    this.smoothVol += (rawVol - this.smoothVol) * this.SMOOTH;

    let chordIndex = -1;
    if (rightDetected === 1 && fingerCount >= -0.5 && fingerCount <= 5.5) {
      const rc = Math.round(fingerCount);
      if (rc === 0) chordIndex = 5;       // fist → 6th chord
      else if (rc >= 1 && rc <= 5) chordIndex = rc - 1; // 1–5 fingers → chords 0–4
    }

    const rotationGesture = rightDetected === 1
      ? this.updateRotationGesture(rightPalmRot)
      : (this.rotationGesture = 0);
    const requestedMinor = rotationGesture === 1;
    const requestedSeventh = rotationGesture === -1;

    // Smoothed effect params from the left hand rotation

    const rawMix = leftDetected ? this.clamp(leftPalmRot / Math.PI, 0, 1) : 0.0;
    const rawParam = leftDetected ? this.clamp(leftPalmRot / Math.PI, 0, 1) : 0.5;
    this.smoothMix += (rawMix - this.smoothMix) * this.SMOOTH;
    this.smoothParam += (rawParam - this.smoothParam) * this.SMOOTH;

    const volume = this.smoothVol;
    const mix = this.smoothMix;
    const param = this.smoothParam;
    this.prepareEffectParams(param);

    // ─── Pad switch (hot-swap sin click) ─────────────────────────────────
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
      // Positive display-space rotation keeps the existing minor gesture;
      // negative rotation adds the seventh without changing the triad root.
      this.majorMinorMix = requestedMinor ? 1.0 : 0.0;
      this.seventhActive = requestedSeventh;
      if (this.envelopeState === 'OFF' || this.envelopeState === 'RELEASE') {
        this.voice.noteOn(); // retrigger específico de la voz (fases, ruido KS)
        this.envelopeState = 'ATTACK';
      }
      this.currentChordIndex = chordIndex;
    } else if (this.envelopeState === 'ATTACK' || this.envelopeState === 'SUSTAIN') {
      this.envelopeState = 'RELEASE';
    } else if (this.envelopeState === 'OFF' && this.envelope <= 0) {
      this.majorMinorMix = 0.0;
      this.seventhActive = false;
      this.rotationGesture = 0;
    }

    const majorMinorMix = this.majorMinorMix;
    const targetSeventhMix = this.seventhActive ? 1.0 : 0.0;
    this.seventhMix += (targetSeventhMix - this.seventhMix) * this.SMOOTH;
    const toneCount = this.seventhActive || this.seventhMix > AUDIO_SILENCE_EPS ? 4 : 3;
    const voiceWasActive = chordIndex >= 0 || this.envelopeState !== 'OFF' || this.envelope > 0;
    const effectHasTail = selectedEffect === 0 || selectedEffect === 4;

    // A silent block with no delay/reverb tail does not need to run the DSP
    // graph. Resetting once prevents stale echoes when the effect is re-enabled.
    if (!voiceWasActive && (!effectHasTail || !this.effectTailActive || mix <= AUDIO_SILENCE_EPS)) {
      if (!this.effectsBypassed) {
        this.resetEffects();
        this.effectsBypassed = true;
      }
      out.fill(0);
      if (output[1]) output[1].fill(0);
      this.writeSilentState(volume, mix, param);
      return true;
    }

    // Read the active chord once per block. The reusable typed array contains
    // triad + seventh and is passed for every sample instead of allocating an
    // array of frequencies.
    const currentChordIndex = this.currentChordIndex;
    const hasChord = currentChordIndex >= 0 && currentChordIndex < 6;
    let chord0 = 0;
    let chord1 = 0;
    let chord2 = 0;
    let chordSeventh = 0;
    if (hasChord) {
      const chordBase = 11 + currentChordIndex * 3;
      chord0 = this.float32View[chordBase];
      chord1 = this.float32View[chordBase + 1];
      chord2 = this.float32View[chordBase + 2];
      chordSeventh = this.float32View[INDEXES.CONFIG_CHORD_SEVENTHS + currentChordIndex];
      const minorThird = chord1 * MINOR_THIRD_RATIO;
      this.renderFreqs[0] = chord0;
      this.renderFreqs[1] = chord1 * (1 - majorMinorMix) + minorThird * majorMinorMix;
      this.renderFreqs[2] = chord2;
      this.renderFreqs[3] = chordSeventh;
    }

    // ─── Dry generation ────────────────────────────────────────────────
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
            this.majorMinorMix = 0.0;
            this.seventhActive = false;
            this.rotationGesture = 0;
          }
        }
      } else if (this.envelopeState === 'RELEASE') {
        this.envelope -= this.releaseStep;
        if (this.envelope <= 0.0) {
          this.envelope = 0.0;
          this.envelopeState = 'OFF';
          this.currentChordIndex = -1;
          this.majorMinorMix = 0.0;
          this.seventhActive = false;
          this.rotationGesture = 0;
        }
      }

      let sample = DENORMAL;
      if (this.envelope > 0 && hasChord) {
        sample = this.voice.renderSample(this.renderFreqs, toneCount, this.seventhMix);
        sample *= this.envelope;
        sample *= volume;
      }
      this.dryBuf[i] = sample;
    }

    // ─── Effect ────────────────────────────────────────────────────────
    let effectPeak = 0;
    if (mix <= AUDIO_SILENCE_EPS) {
      if (!this.effectsBypassed) {
        this.resetEffects();
        this.effectsBypassed = true;
      }
      for (let i = 0; i < N; i++) this.wetBuf[i] = this.dryBuf[i];
    } else {
      this.effectsBypassed = false;
      for (let i = 0; i < N; i++) {
        let p = this.dryBuf[i];
        switch (selectedEffect) {
          case 0: p = this.fxReverb(this.dryBuf[i]); break;
          case 1: p = this.fxChorus(this.dryBuf[i]); break;
          case 2: p = this.fxBitcrush(this.dryBuf[i]); break;
          case 3: p = this.fxFilter(this.dryBuf[i]); break;
          case 4: p = this.fxDelay(this.dryBuf[i]); break;
          case 5: p = this.fxTremolo(this.dryBuf[i]); break;
        }
        const absEffect = Math.abs(p);
        if (absEffect > effectPeak) effectPeak = absEffect;
        this.wetBuf[i] = this.dryBuf[i] * (1 - mix) + p * mix;
      }
    }

    if (mix <= AUDIO_SILENCE_EPS || !effectHasTail) {
      this.effectTailActive = false;
    } else if (voiceWasActive) {
      this.effectTailActive = true;
    } else if (effectPeak < EFFECT_TAIL_EPS) {
      this.effectTailActive = false;
    }

    // ─── Output soft-clip ──────────────────────────────────────────────
    for (let i = 0; i < N; i++) {
      let s = this.wetBuf[i];
      if (s > 0.95) s = 0.95 + (s - 0.95) * 0.3;
      else if (s < -0.95) s = -0.95 + (s + 0.95) * 0.3;
      if (s > 1.0) s = 1.0;
      else if (s < -1.0) s = -1.0;
      out[i] = s;
    }
    if (output[1]) output[1].set(out);

    // ─── Write SAB ─────────────────────────────────────────────────────
    this.float32View[160] = volume;
    this.float32View[161] = (chordIndex >= 0 && hasChord) ? chord0 : 0.0;
    this.int32View[162] = chordIndex;
    this.float32View[163] = majorMinorMix;
    this.float32View[164] = mix;
    this.float32View[165] = param;
    this.float32View[166] = this.envelope;
    Atomics.store(this.int32View, INDEXES.AUDIO_SEVENTH_ACTIVE, this.seventhActive ? 1 : 0);

    // Oscilloscope
    const oscOff = 167;
    const step = Math.max(1, Math.floor(N / 25));
    for (let k = 0; k < 25; k++) {
      this.float32View[oscOff + k] = this.wetBuf[Math.min(k * step, N - 1)];
    }

    return true;
  }

  // ─── Effects (no clipping, no boosts) ─────────────────────────────────

  fxReverb(sample) {
    const idx = this.reverbWritePos;
    this.reverbBuf[idx] = sample + DENORMAL;
    let sum = 0;
    for (let t = 0; t < this.reverbTaps.length; t++) {
      const tapIdx = (idx - this.reverbTaps[t] + this.reverbBuf.length) % this.reverbBuf.length;
      sum += this.reverbBuf[tapIdx] * this.reverbGains[t];
    }
    this.reverbWritePos = (idx + 1) % this.reverbBuf.length;
    return this.clamp(sum, -1.0, 1.0);
  }

  fxChorus(sample) {
    this._chorusPhase += this.chorusPhaseStep;
    if (this._chorusPhase >= TWO_PI) this._chorusPhase -= TWO_PI;
    return sample * (1 + this.chorusDepth * Math.sin(this._chorusPhase));
  }

  fxBitcrush(sample) {
    this.crushHold = Math.round(sample * this.bitLevels) / this.bitLevels;
    return this.crushHold;
  }

  fxFilter(sample) {
    this.filterPrev = this.filterPrev * this.filterA + sample * (1 - this.filterA) + DENORMAL;
    return this.filterPrev;
  }

  fxDelay(sample) {
    // Delay time is still smoothed per-sample to avoid zipper noise; its target
    // and feedback coefficient are calculated once per block.
    this._delayTimeTarget += (this.delayTargetSamples - this._delayTimeTarget) * this.SMOOTH;
    const delayTimeF = this.clamp(this._delayTimeTarget, 1, this.delayBuf.length - 2);
    const delayTimeInt = Math.floor(delayTimeF);
    const frac = delayTimeF - delayTimeInt;
    const readPos0 = (this.delayWritePos - delayTimeInt + this.delayBuf.length) % this.delayBuf.length;
    const readPos1 = (readPos0 - 1 + this.delayBuf.length) % this.delayBuf.length;
    const delayed = this.delayBuf[readPos0] * (1 - frac) + this.delayBuf[readPos1] * frac;
    this.delayBuf[this.delayWritePos] = sample + delayed * this.delayFeedback + DENORMAL;
    this.delayWritePos = (this.delayWritePos + 1) % this.delayBuf.length;
    return sample * 0.7 + delayed * 0.3;
  }

  fxTremolo(sample) {
    this._tremRate += (this.tremTargetRate - this._tremRate) * this.SMOOTH;
    this._tremPhase += (TWO_PI * this._tremRate) / this.sampleRate;
    if (this._tremPhase >= TWO_PI) this._tremPhase -= TWO_PI;
    const lfo = 1.0 - this.tremDepth * 0.5 * (1 + Math.sin(this._tremPhase));
    return sample * lfo;
  }
}

registerProcessor('gesture-synthesizer', AudioEngineProcessor);
