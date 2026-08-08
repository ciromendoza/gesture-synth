import {
  ROLE_ENUM,
  HAND_CONNECTIONS
} from './constants.js';
import { PAD_CATALOG } from './pad-catalog.js';

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

// Elegant sans-serif stack (Apple-style), with graceful fallback
const UI_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Arial, sans-serif';

// Set a light-weight font with optional letter-spacing (silent fallback where unsupported)
function setFont(ctx, weight, size, spacing) {
  ctx.font = `${weight} ${size}px ${UI_FONT}`;
  if (typeof ctx.letterSpacing !== 'undefined') {
    try { ctx.letterSpacing = `${spacing || 0}px`; } catch (e) { /* ignore */ }
  }
}

// Rounded rect path with fallback for browsers without native ctx.roundRect
function roundRectPath(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Convert an actual frequency (Hz) to its note name (any octave).
// Mirrors the audio engine: the sounding root freq is written to SAB index 161.
function freqToNoteName(freq) {
  if (!freq || freq <= 0) return '';
  // MIDI note number, A4 = 440 Hz = MIDI 69
  const midi = 69 + 12 * Math.log2(freq / 440);
  const noteIdx = ((Math.round(midi) % 12) + 12) % 12;
  return NOTE_NAMES[noteIdx];
}

const EFFECT_NAMES = ['Reverb', 'Vibrato', 'Bitcrusher', 'Filter', 'Delay', 'Tremolo'];

export class GraphicEngine {
  constructor(canvas, sab, videoElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    this.sab = sab;
    this.video = videoElement;

    this.int32View = new Int32Array(sab);
    this.float32View = new Float32Array(sab);
    this.handPoints = new Float32Array(42); // reused for either hand

    this.isRunning = false;
    this.renderFrameId = null;
    this.lastRenderAt = 0;
    this.renderInterval = 1000 / 30;
    this.fps = 0;
    this.frameCount = 0;
    this.fpsTimer = performance.now();
    this.cameraFps = 0; // set externally by main.js (MediaPipe frame loop)
    this._lastChordIndex = -1; // preserved during release tail for chord tag fade
    this._boundRenderLoop = (now) => this.renderLoop(now);
    this._onResize = () => this.resizeCanvas();

    this.resizeCanvas();
    window.addEventListener('resize', this._onResize);
  }

  // Called by main.js once per second with the measured MediaPipe frame rate.
  setCameraFps(fps) { this.cameraFps = fps; }

  // Keeps SAB config indices 2–3 (canvas width/height) in sync with the real size.
  resizeCanvas() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.int32View[2] = this.canvas.width;
    this.int32View[3] = this.canvas.height;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastRenderAt = 0;
    this.fpsTimer = performance.now();
    this.renderFrameId = requestAnimationFrame(this._boundRenderLoop);
  }

  stop() {
    this.isRunning = false;
    if (this.renderFrameId !== null) {
      cancelAnimationFrame(this.renderFrameId);
      this.renderFrameId = null;
    }
  }

  destroy() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
  }

  renderLoop(now) {
    if (!this.isRunning) return;
    if (this.lastRenderAt === 0 || now - this.lastRenderAt >= this.renderInterval) {
      this.lastRenderAt = now;
      this.frameCount++;
      if (now - this.fpsTimer >= 1000) {
        this.fps = Math.round((this.frameCount * 1000) / (now - this.fpsTimer));
        this.frameCount = 0;
        this.fpsTimer = now;
      }
      this.render();
    }
    this.renderFrameId = requestAnimationFrame(this._boundRenderLoop);
  }

  render() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const ctx = this.ctx;

    // The camera is rendered by the browser's compositor in the video layer;
    // this canvas is an inexpensive transparent overlay.
    ctx.clearRect(0, 0, w, h);

    // 1. Oscilloscope (transparent, left strip)
    this.drawOscilloscope(w, h);

    // 2. SAB state. Atomics.load pairs with the worker's final publication of
    // each hand flag, preventing the overlay from reading half-written points.
    const rightDetected = Atomics.load(this.int32View, 32);
    const leftDetected = Atomics.load(this.int32View, 96);

    // 4. Left hand: pinch circle
    if (leftDetected === 1) {
      this.drawHandLandmarks(101, true);
      this.drawPinchCircle();
    }

    // 5. Right hand: landmarks
    if (rightDetected === 1) {
      this.drawHandLandmarks(37, false);
    }

    // 6. Chord tag anchored to right wrist (drawn only when hand detected)
    this.drawChordTag();

    // 7. Top-right: left hand data bars inside HUD panel (includes FPS)
    this.drawDataBars();
  }

  // ─── Oscilloscope: flat ellipses (equalizer dots), no connecting line ──
  drawOscilloscope(w, h) {
    const ctx = this.ctx;
    // Strip width proportional to canvas (was a fixed 60px)
    const stripW = Math.max(48, Math.min(96, w * 0.08));
    const centerX = stripW / 2;

    // Top/bottom margin, same rhythm as the info panel's edge margin
    const margin = Math.max(12, w * 0.02);
    const top = margin;
    const bottom = h - margin;
    const usableH = Math.max(1, bottom - top);

    const oscOff = 167;
    const spacing = usableH / 24; // 25 samples across the usable strip height

    ctx.save();

    // Faint container for the strip
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(0, 0, stripW, h);

    // Subtle center guide (respects the same margins)
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(centerX, top);
    ctx.lineTo(centerX, bottom);
    ctx.stroke();

    const minR = 2, maxR = 10;
    for (let k = 0; k < 25; k++) {
      const s = this.float32View[oscOff + k] || 0;
      const amp = Math.min(1, Math.abs(s));
      const r = minR + amp * (maxR - minR);
      const y = top + k * spacing;
      ctx.beginPath();
      // "Flat" dot: ellipse wider than tall, size follows the sample amplitude
      ctx.ellipse(centerX, y, r * 1.4, r * 0.7, 0, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${0.3 + amp * 0.6})`;
      ctx.fill();
    }
    ctx.restore();
  }

  // ─── Hand Landmarks (white) ────────────────────────────────────────────
  drawHandLandmarks(offset, isLeft) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const pts = this.handPoints;

    // Reuse one interleaved coordinate buffer for both hands. The old version
    // created 21 point objects per hand on every render.
    for (let i = 0; i < 42; i += 2) {
      pts[i] = (1.0 - this.float32View[offset + i]) * w;
      pts[i + 1] = this.float32View[offset + i + 1] * h;
    }

    ctx.save();
    ctx.strokeStyle = '#FFFFFF';
    ctx.fillStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.shadowBlur = 0;

    ctx.globalAlpha = 0.4;
    for (let c = 0; c < HAND_CONNECTIONS.length; c++) {
      const connection = HAND_CONNECTIONS[c];
      const a = connection[0] * 2;
      const b = connection[1] * 2;
      ctx.beginPath();
      ctx.moveTo(pts[a], pts[a + 1]);
      ctx.lineTo(pts[b], pts[b + 1]);
      ctx.stroke();
    }

    ctx.globalAlpha = 1.0;
    for (let i = 0; i < 42; i += 2) {
      const landmarkIndex = i / 2;
      const r = (landmarkIndex === 4 || landmarkIndex === 8 || landmarkIndex === 12 ||
        landmarkIndex === 16 || landmarkIndex === 20) ? 5 : 3;
      ctx.beginPath();
      ctx.arc(pts[i], pts[i + 1], r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ─── Pinch Circle: solid when small, hollow ring when volume grows ──────
  drawPinchCircle() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    const lmOff = 101;
    const thumbX = (1.0 - this.float32View[lmOff + 4 * 2]) * w;
    const thumbY = this.float32View[lmOff + 4 * 2 + 1] * h;
    const indexX = (1.0 - this.float32View[lmOff + 8 * 2]) * w;
    const indexY = this.float32View[lmOff + 8 * 2 + 1] * h;
    const volume = this.float32View[160];

    const midX = (thumbX + indexX) / 2;
    const midY = (thumbY + indexY) / 2;

    // Max radius proportional to viewport (cap at 120px as before)
    const maxR = Math.max(60, Math.min(120, h * 0.15));
    // Exponential curve: small pinch distances already produce visible circles,
    // and the circle grows beyond the physical thumb↔index gap.
    const r = Math.pow(volume, 0.55) * maxR * 1.4;

    ctx.save();
    ctx.shadowBlur = 0;

    // Thumb↔index connector line
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(thumbX, thumbY);
    ctx.lineTo(indexX, indexY);
    ctx.stroke();

    // Midpoint dot
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(midX, midY, 3, 0, Math.PI * 2);
    ctx.fill();

    // Solid when small, fades as it grows. Border always visible.
    if (r >= 1) {
      const alpha = 1 - volume * 0.7; // 1.0 → 0.3
      ctx.beginPath();
      ctx.arc(midX, midY, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(2)})`;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Volume %
    setFont(ctx, 300, 12, 0.4);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillText(`${Math.round(volume * 100)}%`, midX, midY - r - 10);

    ctx.restore();
  }

  // ─── Top-Right HUD Panel (left hand data bars + FPS) ──────────────────
  drawDataBars() {
    const ctx = this.ctx;
    const w = this.canvas.width;

    const pinchDist = this.float32View[97];
    const palmRot = this.float32View[98];
    const leftDetected = Atomics.load(this.int32View, 96);
    const selectedEffect = this.int32View[10];
    const selectedPad = this.int32View[30];

    // Panel anchored to the right edge with proportional width + margin
    const margin = Math.max(12, w * 0.02);
    const panelW = Math.max(180, Math.min(240, w * 0.22));
    const pad = 14;
    const panelX = w - panelW - margin;
    const panelY = margin;

    const titleH = 44;    // two title lines (pad + effect) without colliding with bar labels
    const rowH = 24;
    const valW = 52;      // value column
    const barMaxW = panelW - pad * 2 - valW - 8;
    const barH = 7;
    const fpsH = 30;      // two lines: rendered fps + camera fps

    ctx.save();
    ctx.shadowBlur = 0;

    // Panel frame (semi-transparent, thin border, HUD style)
    const panelH = pad * 2 + titleH + rowH * 2 + fpsH;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    roundRectPath(ctx, panelX, panelY, panelW, panelH, 8);
    ctx.fill();
    ctx.stroke();

    // Selected pad + effect
    setFont(ctx, 400, 12, 0.4);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    const padName = PAD_CATALOG[selectedPad]?.name || '?';
    ctx.fillText(`Pad: ${padName}`, panelX + pad, panelY + pad + 12);
    ctx.fillText(`Efecto: ${EFFECT_NAMES[selectedEffect] || '?'}`, panelX + pad, panelY + pad + 28);

    // Bar 1: Volume
    const volNorm = leftDetected ? pinchDist : 0;
    this.drawBar(panelX + pad, panelY + pad + titleH, barMaxW, barH, volNorm, 'Volumen',
      leftDetected ? `${Math.round(pinchDist * 100)}%` : '—');

    // Bar 2: Effect amount (0–π rotation mapped to 0–1)
    const fxNorm = leftDetected ? Math.min(palmRot / Math.PI, 1) : 0;
    this.drawBar(panelX + pad, panelY + pad + titleH + rowH, barMaxW, barH, fxNorm, 'FX Amount',
      leftDetected ? `${Math.round(fxNorm * 100)}%` : '—');

    // FPS inside the panel (two lines)
    setFont(ctx, 300, 10, 0.5);
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    const fpsY = panelY + pad + titleH + rowH * 2;
    ctx.fillText(`FPS renderizado: ${this.fps}`, panelX + pad, fpsY + 10);
    ctx.fillText(`FPS cámara: ${this.cameraFps}`, panelX + pad, fpsY + 24);

    ctx.restore();
  }

  drawBar(x, y, maxW, h, norm, label, valueText) {
    const ctx = this.ctx;
    const fillW = Math.max(2, norm * maxW);
    const valW = 52;

    ctx.save();
    // Label above the bar
    setFont(ctx, 300, 9, 0.5);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(label.toUpperCase(), x, y - 4);

    // Track
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    roundRectPath(ctx, x, y, maxW, h, 2);
    ctx.fill();

    // Fill
    if (fillW > 1) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      roundRectPath(ctx, x, y, fillW, h, 2);
      ctx.fill();
    }

    // Value (right of bar, own column)
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(valueText, x + maxW + 8, y + h - 1);

    ctx.restore();
  }

  // ─── Chord Tag: tooltip anchored to the right wrist ────────────────────
  drawChordTag() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    const envelope = this.float32View[166];
    if (envelope <= 0) return; // no tag when audio is silent

    const activeChord = this.int32View[162];

    // During release, the gesture is already gone (chordIndex = -1) but the
    // audio is still fading — keep showing the LAST sounding chord.
    if (activeChord >= 0 && activeChord <= 5) {
      this._lastChordIndex = activeChord;
    }
    const chordIdx = this._lastChordIndex;
    if (chordIdx < 0 || chordIdx > 5) return;

    const rightDetected = Atomics.load(this.int32View, 32);
    if (rightDetected !== 1) return; // no tag when hand is absent

    // Right wrist, converted like the other landmarks (mirror inversion)
    const wristX = (1.0 - this.float32View[35]) * w;
    const wristY = this.float32View[36] * h;

    // Role derived from SCALES intervals (written to SAB zone 192–197 by main.js)
    const roleIdx = this.int32View[192 + chordIdx];
    const role = (roleIdx >= 0 && roleIdx < ROLE_ENUM.length) ? ROLE_ENUM[roleIdx] : '?';

    const isMinor = this.float32View[163] >= 0.5;
    const mode = isMinor ? 'min' : 'maj';
    const soundingFreq = this.float32View[161];
    const name = freqToNoteName(soundingFreq) || NOTE_NAMES[0];
    const mainLabel = `${name} ${mode}`;

    ctx.save();
    ctx.globalAlpha = Math.min(1, envelope); // fade with the audio release

    setFont(ctx, 400, 14, 0.3);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const textW = ctx.measureText(mainLabel).width;
    setFont(ctx, 300, 10, 0.4);
    const roleW = ctx.measureText(role).width;

    const padX = 12, padY = 6;
    const lineH = 16;
    const tagW = Math.max(textW, roleW) + padX * 2;
    const tagX = wristX - tagW / 2;
    const tagY = wristY + 24; // below the wrist
    const tagH = padY * 2 + lineH + (role ? 14 : 0);

    // Tag background + thin border
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1;
    roundRectPath(ctx, tagX, tagY, tagW, tagH, 6);
    ctx.fill();
    ctx.stroke();

    // Chord name (main line)
    setFont(ctx, 400, 14, 0.3);
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillText(mainLabel, tagX + tagW / 2, tagY + padY + lineH / 2);

    // Role (sub line)
    if (role && role !== '?') {
      setFont(ctx, 300, 10, 0.4);
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.fillText(role, tagX + tagW / 2, tagY + padY + lineH + 7);
    }

    ctx.restore();
  }
}
