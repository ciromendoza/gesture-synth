import {
  PINCH_OPEN_THRESHOLD,
  PINCH_CLOSE_THRESHOLD,
  HYSTERESIS_THRESHOLD,
  VIBRATO_BASE_RATE,
  VIBRATO_MAX_RATE,
  VIBRATO_MAX_DEPTH
} from '../constants.js';

/**
 * Clamps a number between min and max
 */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Linearly interpolates between a and b by t (0..1)
 */
export function lerp(a, b, t) {
  return a + (b - a) * clamp(t, 0, 1);
}

/**
 * Maps a value from input range [inMin, inMax] to output range [outMin, outMax]
 */
export function mapRange(value, inMin, inMax, outMin, outMax) {
  if (inMax === inMin) return outMin;
  const t = (value - inMin) / (inMax - inMin);
  return lerp(outMin, outMax, t);
}

/**
 * Calculates Euclidean distance between two 2D points ({x, y})
 */
export function distance2D(p1, p2) {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Applies hysteresis thresholding to prevent rapid toggling
 * @param {number} diff Difference value (e.g., tip.y - pip.y)
 * @param {boolean} currentExtended Current state of the finger
 * @param {number} threshold Hysteresis threshold
 * @returns {boolean} New state
 */
export function applyHysteresis(diff, currentExtended, threshold = HYSTERESIS_THRESHOLD) {
  if (diff > threshold) {
    return true; // Extended
  } else if (diff < -threshold) {
    return false; // Folded
  }
  return currentExtended; // Keep state
}

/**
 * Maps pinch distance to master volume [0.0, 1.0]
 */
export function mapPinchToVolume(pinchDistance, isDetected) {
  if (!isDetected) return 0.0;
  if (pinchDistance >= PINCH_OPEN_THRESHOLD) return 1.0;
  if (pinchDistance <= PINCH_CLOSE_THRESHOLD) return 0.0;
  return (pinchDistance - PINCH_CLOSE_THRESHOLD) / (PINCH_OPEN_THRESHOLD - PINCH_CLOSE_THRESHOLD);
}

/**
 * Maps right hand palm rotation [0, PI] to major/minor mix [0.0 = major, 1.0 = minor]
 */
export function mapRotationToMix(palmRotation) {
  const absRot = Math.abs(palmRotation);
  return clamp(absRot / Math.PI, 0.0, 1.0);
}

/**
 * Maps left hand palm rotation to vibrato rate (Hz)
 */
export function mapRotationToVibratoRate(palmRotation, isDetected) {
  if (!isDetected) return 0.0;
  const normalized = Math.abs(palmRotation) / Math.PI;
  return VIBRATO_BASE_RATE + clamp(normalized, 0, 1) * (VIBRATO_MAX_RATE - VIBRATO_BASE_RATE);
}

/**
 * Maps left hand palm rotation to vibrato depth [0.0, 0.05]
 */
export function mapRotationToVibratoDepth(palmRotation, isDetected) {
  if (!isDetected) return 0.0;
  const normalized = Math.abs(palmRotation) / Math.PI;
  return clamp(normalized, 0, 1) * VIBRATO_MAX_DEPTH;
}
