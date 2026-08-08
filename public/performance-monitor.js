// PerformanceMonitor — low-overhead session diagnostics for the main thread.
// Hot paths only write counters/ring-buffer values; sorting and object creation
// happen when the public snapshot() API is called.

import { INDEXES } from './constants.js';

const RING_SIZE = 128;
const EMPTY_FRAME = null;

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

export class PerformanceMonitor {
  constructor() {
    this.inferenceSamples = new Float64Array(RING_SIZE);
    this.renderSamples = new Float64Array(RING_SIZE);
    this.inferenceScratch = new Float64Array(RING_SIZE);
    this.renderScratch = new Float64Array(RING_SIZE);
    this.observers = [];
    this.audioContext = null;
    this.audioSab = null;
    this.observing = false;
    this.reset();
    this.startObservers();
  }

  reset() {
    this.sessionStartedAt = performance.now();
    this.inferenceWrite = 0;
    this.inferenceCount = 0;
    this.renderWrite = 0;
    this.renderCount = 0;
    this.videoCallbacks = 0;
    this.videoFramesSeen = 0;
    this.processedFrames = 0;
    this.skippedFrames = 0;
    this.duplicateFrames = 0;
    this.inferenceErrors = 0;
    this.longTaskCount = 0;
    this.longTaskTotalMs = 0;
    this.longTaskMaxMs = 0;
    this.gcCount = 0;
    this.gcTotalMs = 0;
    this.gcMaxMs = 0;
    this.lastVideoFrame = EMPTY_FRAME;
    this.renderFps = 0;
    this.cameraFps = 0;
    this.inferenceSamples.fill(0);
    this.renderSamples.fill(0);
  }

  startObservers() {
    if (this.observing || typeof PerformanceObserver === 'undefined') return;
    this.observing = true;

    try {
      const longTaskObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        for (let i = 0; i < entries.length; i++) {
          const duration = entries[i].duration;
          this.longTaskCount++;
          this.longTaskTotalMs += duration;
          if (duration > this.longTaskMaxMs) this.longTaskMaxMs = duration;
        }
      });
      longTaskObserver.observe({ type: 'longtask', buffered: true });
      this.observers.push(longTaskObserver);
    } catch (error) {
      // Long Task API is not available in every browser/context.
    }

    try {
      const gcObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        for (let i = 0; i < entries.length; i++) {
          const duration = entries[i].duration;
          this.gcCount++;
          this.gcTotalMs += duration;
          if (duration > this.gcMaxMs) this.gcMaxMs = duration;
        }
      });
      gcObserver.observe({ type: 'gc', buffered: true });
      this.observers.push(gcObserver);
    } catch (error) {
      // GC entries are optional and commonly disabled outside DevTools.
    }
  }

  recordInference(durationMs) {
    if (!Number.isFinite(durationMs)) return;
    this.inferenceSamples[this.inferenceWrite] = durationMs;
    this.inferenceWrite = (this.inferenceWrite + 1) % RING_SIZE;
    this.inferenceCount++;
  }

  recordRender(durationMs) {
    if (!Number.isFinite(durationMs)) return;
    this.renderSamples[this.renderWrite] = durationMs;
    this.renderWrite = (this.renderWrite + 1) % RING_SIZE;
    this.renderCount++;
  }

  setRenderFps(fps) { this.renderFps = fps; }
  setCameraFps(fps) { this.cameraFps = fps; }

  recordVideoFrame(frameId) {
    this.videoCallbacks++;
    if (!Number.isFinite(frameId)) {
      this.videoFramesSeen++;
      return;
    }

    if (this.lastVideoFrame === EMPTY_FRAME) {
      this.lastVideoFrame = frameId;
      this.videoFramesSeen++;
      return;
    }

    if (frameId === this.lastVideoFrame) {
      this.duplicateFrames++;
      return;
    }

    const delta = frameId - this.lastVideoFrame;
    if (Number.isInteger(frameId) && delta > 1) {
      this.skippedFrames += delta - 1;
      this.videoFramesSeen += delta;
    } else {
      this.videoFramesSeen++;
    }
    this.lastVideoFrame = frameId;
  }

  recordProcessedFrame() { this.processedFrames++; }
  recordInferenceError() { this.inferenceErrors++; }

  setAudioContext(audioContext, sab) {
    this.audioContext = audioContext || null;
    this.audioSab = sab || null;
  }

  summarize(samples, total, scratch) {
    const count = Math.min(total, RING_SIZE);
    if (count === 0) return { count: 0, p50: null, p95: null, p99: null, max: null };

    const start = (total - count) % RING_SIZE;
    for (let i = 0; i < count; i++) {
      scratch[i] = samples[(start + i) % RING_SIZE];
    }
    scratch.subarray(0, count).sort();

    const at = (percentile) => scratch[Math.min(count - 1, Math.ceil(count * percentile) - 1)];
    return {
      count: total,
      p50: at(0.50),
      p95: at(0.95),
      p99: at(0.99),
      max: scratch[count - 1]
    };
  }

  snapshot() {
    const now = performance.now();
    const audioInt32 = this.audioSab ? new Int32Array(this.audioSab) : null;
    const audioFloat32 = this.audioSab ? new Float32Array(this.audioSab) : null;

    return {
      generatedAt: new Date().toISOString(),
      sessionMs: Math.round(now - this.sessionStartedAt),
      renderFps: this.renderFps,
      cameraFps: this.cameraFps,
      frames: {
        videoCallbacks: this.videoCallbacks,
        videoFramesSeen: this.videoFramesSeen,
        processed: this.processedFrames,
        skipped: this.skippedFrames,
        duplicates: this.duplicateFrames,
        inferenceErrors: this.inferenceErrors
      },
      inferenceMs: this.summarize(this.inferenceSamples, this.inferenceCount, this.inferenceScratch),
      renderMs: this.summarize(this.renderSamples, this.renderCount, this.renderScratch),
      mainThread: {
        longTasks: this.longTaskCount,
        longTaskTotalMs: this.longTaskTotalMs,
        longTaskMaxMs: this.longTaskMaxMs,
        gcEvents: this.gcCount,
        gcTotalMs: this.gcTotalMs,
        gcMaxMs: this.gcMaxMs
      },
      audio: {
        baseLatencyMs: finiteOrNull(this.audioContext?.baseLatency * 1000),
        outputLatencyMs: finiteOrNull(this.audioContext?.outputLatency * 1000),
        callbackMs: audioFloat32 ? finiteOrNull(audioFloat32[INDEXES.PERF_AUDIO_CALLBACK_MS]) : null,
        callbackBudgetMs: audioFloat32 ? finiteOrNull(audioFloat32[INDEXES.PERF_AUDIO_CALLBACK_BUDGET_MS]) : null,
        measuredCallbacks: audioInt32 ? Atomics.load(audioInt32, INDEXES.PERF_AUDIO_CALLBACK_COUNT) : 0
      }
    };
  }
}
