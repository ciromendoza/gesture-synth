// Tracking Worker (Gesture Computation)
// Runs in a dedicated Web Worker thread.
// Receives raw landmarks from the main thread via postMessage,
// computes finger count, palm rotation, pinch distance with hysteresis,
// and writes all gesture data directly to the SharedArrayBuffer.

let sab = null;
let int32View = null;
let float32View = null;

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

  } else if (data.type === 'landmarks') {
    // Receive pre-extracted landmarks from MediaPipe on the main thread
    // data.rightHand = array of 21 {x,y} or null
    // data.leftHand  = array of 21 {x,y} or null
    processFrame(data.rightHand, data.leftHand);
  }
};

function processFrame(rightLandmarks, leftLandmarks) {
  if (!int32View || !float32View) return;

  // ─── RIGHT HAND ─────────────────────────────────────────────────────────
  if (rightLandmarks) {
    int32View[32] = 1; // handDetected

    // Wrist
    const wrist = rightLandmarks[0];
    float32View[35] = wrist.x;
    float32View[36] = wrist.y;

    // Finger Count with hysteresis
    // Thumb: distance-based (orientation-invariant) — compare how far tip(4)
    // is from pinky MCP(17) vs how far IP(3) is from pinky MCP(17).
    // If tip is farther, thumb is extended regardless of hand rotation.
    const thumbTip = rightLandmarks[4];
    const thumbIP = rightLandmarks[3];
    const pinkyMCP = rightLandmarks[17];
    const tipDist = Math.hypot(thumbTip.x - pinkyMCP.x, thumbTip.y - pinkyMCP.y);
    const ipDist = Math.hypot(thumbIP.x - pinkyMCP.x, thumbIP.y - pinkyMCP.y);
    const thumbDiff = tipDist - ipDist; // >0 = extended
    fingerStates.thumb = applyHysteresis(thumbDiff, fingerStates.thumb);

    // Index: tip(8).y < pip(6).y  (smaller Y = higher on screen)
    const indexDiff = rightLandmarks[6].y - rightLandmarks[8].y;
    fingerStates.index = applyHysteresis(indexDiff, fingerStates.index);

    // Middle: tip(12).y < pip(10).y
    const middleDiff = rightLandmarks[10].y - rightLandmarks[12].y;
    fingerStates.middle = applyHysteresis(middleDiff, fingerStates.middle);

    // Ring: tip(16).y < pip(14).y
    const ringDiff = rightLandmarks[14].y - rightLandmarks[16].y;
    fingerStates.ring = applyHysteresis(ringDiff, fingerStates.ring);

    // Pinky: tip(20).y < pip(18).y
    const pinkyDiff = rightLandmarks[18].y - rightLandmarks[20].y;
    fingerStates.pinky = applyHysteresis(pinkyDiff, fingerStates.pinky);

    let count = 0;
    if (fingerStates.thumb) count++;
    if (fingerStates.index) count++;
    if (fingerStates.middle) count++;
    if (fingerStates.ring) count++;
    if (fingerStates.pinky) count++;
    float32View[33] = count;

    // Palm Rotation: angle from wrist(0) to middle MCP(9)
    const mcp9 = rightLandmarks[9];
    const dx = mcp9.x - wrist.x;
    const dy = -(mcp9.y - wrist.y);
    float32View[34] = Math.abs(Math.atan2(dx, dy));

    // Write 21 landmarks (x, y) — 42 floats
    for (let i = 0; i < 21; i++) {
      float32View[37 + i * 2] = rightLandmarks[i].x;
      float32View[37 + i * 2 + 1] = rightLandmarks[i].y;
    }
  } else {
    int32View[32] = 0; // right hand not detected
  }

  // ─── LEFT HAND ──────────────────────────────────────────────────────────
  if (leftLandmarks) {
    int32View[96] = 1; // handDetected

    // Wrist
    const wrist = leftLandmarks[0];
    float32View[99] = wrist.x;
    float32View[100] = wrist.y;

    // Pinch Distance (thumb tip 4 ↔ index tip 8) — normalized by palmLen
    // for invariance to camera distance and hand size.
    // 0 = fingers touching (closed), 1 = fully open
    const thumbTip = leftLandmarks[4];
    const indexTip = leftLandmarks[8];
    const pinchDist = Math.sqrt(
      (thumbTip.x - indexTip.x) ** 2 +
      (thumbTip.y - indexTip.y) ** 2
    );
    const mcp9 = leftLandmarks[9];
    const palmLen = Math.hypot(mcp9.x - wrist.x, mcp9.y - wrist.y) || 1e-6;
    const pinchDistNorm = pinchDist / palmLen;
    float32View[97] = clamp01((pinchDistNorm - PINCH_MIN_NORM) / (PINCH_MAX_NORM - PINCH_MIN_NORM));

    // Pitch: angle of the wrist→MCP(9) vector from vertical.
    // MCP(9) is the middle finger's MCP — rigid palm structure, does not move
    // when fingers flex. Range limited to 45° (π/4).
    // 0° = upright, 45° = tilted forward. Mapped to 0–π in SAB so audio-engine
    // still sees 0–1 via leftPalmRot/π.
    const dx = mcp9.x - wrist.x;
    const dy = mcp9.y - wrist.y;
    const pitchAngle = Math.atan2(dx, -dy); // angle from vertical
    float32View[98] = clamp01(pitchAngle / (Math.PI / 4)) * Math.PI;

    // Write 21 landmarks (x, y)
    for (let i = 0; i < 21; i++) {
      float32View[101 + i * 2] = leftLandmarks[i].x;
      float32View[101 + i * 2 + 1] = leftLandmarks[i].y;
    }
  } else {
    int32View[96] = 0; // left hand not detected
  }
}

function applyHysteresis(diff, currentState) {
  if (diff > HYSTERESIS) return true;
  if (diff < -HYSTERESIS) return false;
  return currentState;
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
