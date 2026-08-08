// Tracking Worker (Gesture Computation)
// Runs in a dedicated Web Worker thread.
// Landmark coordinates are written by the main thread into SAB tracking slots;
// postMessage carries only a small slot/sequence token, never the landmark data.

let sab = null;
let int32View = null;
let float32View = null;

// These values mirror TRACKING_INPUT in constants.js. This worker intentionally
// stays classic (not an ES module) because MediaPipe's worker integration has
// that requirement in this project.
const SLOT_COUNT = 3;
const SLOT_SEQUENCE = 0;
const SLOT_RIGHT_PRESENT = 1;
const SLOT_LEFT_PRESENT = 2;
const SLOT_RIGHT_LANDMARKS = 3;
const SLOT_LEFT_LANDMARKS = 45;
const SLOT_STARTS = [198, 285, 372];

// Finger hysteresis tracking states (persist across frames)
const fingerStates = {
  thumb: false,
  index: false,
  middle: false,
  ring: false,
  pinky: false
};

const HYSTERESIS = 0.02;
// Pinch thresholds — NORMALIZED by palmLen for camera-distance invariance
const PINCH_MIN_NORM = 0.15; // fingers touching (normalized by palm size)
const PINCH_MAX_NORM = 0.80; // fully open (normalized by palm size)

self.onmessage = (e) => {
  const data = e.data;
  if (!data) return;

  if (data.type === 'init') {
    sab = data.sab;
    int32View = new Int32Array(sab);
    float32View = new Float32Array(sab);
    self.postMessage({ type: 'ready' });

  } else if (data.type === 'frame') {
    if (Number.isInteger(data.slot) && Number.isInteger(data.sequence)) {
      processFrame(data.slot, data.sequence);
    }
  }
};

function isValidSlot(slot) {
  for (let i = 0; i < SLOT_COUNT; i++) {
    if (SLOT_STARTS[i] === slot) return true;
  }
  return false;
}

function processFrame(slot, sequence) {
  if (!int32View || !float32View || !isValidSlot(slot)) return;

  // A negative sequence means the producer is still writing the slot. A
  // mismatch means this message was superseded; latest-frame-wins is safer
  // than processing stale gesture data.
  if (Atomics.load(int32View, slot + SLOT_SEQUENCE) !== sequence) return;

  const rightPresent = Atomics.load(int32View, slot + SLOT_RIGHT_PRESENT) === 1;
  const leftPresent = Atomics.load(int32View, slot + SLOT_LEFT_PRESENT) === 1;
  const rightOffset = slot + SLOT_RIGHT_LANDMARKS;
  const leftOffset = slot + SLOT_LEFT_LANDMARKS;

  // ─── RIGHT HAND ─────────────────────────────────────────────────────────
  if (rightPresent) {
    const wristX = float32View[rightOffset];
    const wristY = float32View[rightOffset + 1];

    // Finger Count with hysteresis
    // Thumb: distance-based (orientation-invariant) — compare how far tip(4)
    // is from pinky MCP(17) vs how far IP(3) is from pinky MCP(17).
    const thumbTip = rightOffset + 4 * 2;
    const thumbIP = rightOffset + 3 * 2;
    const pinkyMCP = rightOffset + 17 * 2;
    const tipDX = float32View[thumbTip] - float32View[pinkyMCP];
    const tipDY = float32View[thumbTip + 1] - float32View[pinkyMCP + 1];
    const ipDX = float32View[thumbIP] - float32View[pinkyMCP];
    const ipDY = float32View[thumbIP + 1] - float32View[pinkyMCP + 1];
    const tipDist = Math.hypot(tipDX, tipDY);
    const ipDist = Math.hypot(ipDX, ipDY);
    fingerStates.thumb = applyHysteresis(tipDist - ipDist, fingerStates.thumb);

    // Index: tip(8).y < pip(6).y  (smaller Y = higher on screen)
    fingerStates.index = applyHysteresis(
      float32View[rightOffset + 6 * 2 + 1] - float32View[rightOffset + 8 * 2 + 1],
      fingerStates.index
    );

    // Middle: tip(12).y < pip(10).y
    fingerStates.middle = applyHysteresis(
      float32View[rightOffset + 10 * 2 + 1] - float32View[rightOffset + 12 * 2 + 1],
      fingerStates.middle
    );

    // Ring: tip(16).y < pip(14).y
    fingerStates.ring = applyHysteresis(
      float32View[rightOffset + 14 * 2 + 1] - float32View[rightOffset + 16 * 2 + 1],
      fingerStates.ring
    );

    // Pinky: tip(20).y < pip(18).y
    fingerStates.pinky = applyHysteresis(
      float32View[rightOffset + 18 * 2 + 1] - float32View[rightOffset + 20 * 2 + 1],
      fingerStates.pinky
    );

    let count = 0;
    if (fingerStates.thumb) count++;
    if (fingerStates.index) count++;
    if (fingerStates.middle) count++;
    if (fingerStates.ring) count++;
    if (fingerStates.pinky) count++;

    // Palm Rotation: angle from wrist(0) to middle MCP(9)
    const mcp9 = rightOffset + 9 * 2;
    const dx = float32View[mcp9] - wristX;
    const dy = -(float32View[mcp9 + 1] - wristY);

    // Write computed right-hand data. The detection flag is published only
    // after all coordinates are written, so readers never consume a half frame.
    float32View[33] = count;
    float32View[34] = Math.abs(Math.atan2(dx, dy));
    float32View[35] = wristX;
    float32View[36] = wristY;
    for (let i = 0; i < 42; i++) {
      float32View[37 + i] = float32View[rightOffset + i];
    }
  }

  // ─── LEFT HAND ──────────────────────────────────────────────────────────
  if (leftPresent) {
    const wristX = float32View[leftOffset];
    const wristY = float32View[leftOffset + 1];

    // Pinch Distance (thumb tip 4 ↔ index tip 8) — normalized by palmLen
    // for invariance to camera distance and hand size.
    const thumbTip = leftOffset + 4 * 2;
    const indexTip = leftOffset + 8 * 2;
    const pinchDX = float32View[thumbTip] - float32View[indexTip];
    const pinchDY = float32View[thumbTip + 1] - float32View[indexTip + 1];
    const pinchDist = Math.sqrt(pinchDX * pinchDX + pinchDY * pinchDY);
    const mcp9 = leftOffset + 9 * 2;
    const palmDX = float32View[mcp9] - wristX;
    const palmDY = float32View[mcp9 + 1] - wristY;
    const palmLen = Math.hypot(palmDX, palmDY) || 1e-6;
    const pinchDistNorm = pinchDist / palmLen;

    // Pitch: angle of the wrist→MCP(9) vector from vertical.
    const pitchAngle = Math.atan2(palmDX, -palmDY);

    float32View[97] = clamp01((pinchDistNorm - PINCH_MIN_NORM) / (PINCH_MAX_NORM - PINCH_MIN_NORM));
    float32View[98] = clamp01(pitchAngle / (Math.PI / 4)) * Math.PI;
    float32View[99] = wristX;
    float32View[100] = wristY;
    for (let i = 0; i < 42; i++) {
      float32View[101 + i] = float32View[leftOffset + i];
    }
  }

  // If the main thread began reusing this slot while we were reading it, do
  // not publish the partially computed frame. A newer message will publish the
  // next valid frame.
  if (Atomics.load(int32View, slot + SLOT_SEQUENCE) !== sequence) return;

  Atomics.store(int32View, 32, rightPresent ? 1 : 0);
  Atomics.store(int32View, 96, leftPresent ? 1 : 0);
}

function applyHysteresis(diff, currentState) {
  if (diff > HYSTERESIS) return true;
  if (diff < -HYSTERESIS) return false;
  return currentState;
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
