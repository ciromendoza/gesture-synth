// SharedArrayBuffer Total Size
export const SAB_TOTAL_SIZE = 2048;

// Tracking input slots live in the previously reserved SAB area. Each slot
// contains a sequence number, two presence flags and 84 float32 coordinates
// (21 x/y landmarks for each hand). The main thread writes one slot and sends
// only a tiny control message; the worker reads the actual data from SAB.
export const TRACKING_INPUT = {
  SLOT_SIZE: 87,
  SLOT_COUNT: 3,
  SEQUENCE: 0,
  RIGHT_PRESENT: 1,
  LEFT_PRESENT: 2,
  RIGHT_LANDMARKS: 3,
  LEFT_LANDMARKS: 45,
  SLOTS: [198, 285, 372]
};

// TypedArray Index offsets (ByteOffset / 4)
export const INDEXES = {
  CONFIG_SAMPLE_RATE: 0,
  CONFIG_BUFFER_SIZE: 1,
  CONFIG_CANVAS_WIDTH: 2,
  CONFIG_CANVAS_HEIGHT: 3,
  CONFIG_CAMERA_WIDTH: 4,
  CONFIG_CAMERA_HEIGHT: 5,
  CONFIG_MAX_HANDS: 6,
  CONFIG_MODEL_COMPLEXITY: 7,
  CONFIG_MIN_DETECTION_CONF: 8,
  CONFIG_SELECTED_EFFECT: 10,
  CONFIG_CHORD_SEVENTHS: 192, // float32 × 6; reserved SAB area
  CONFIG_ROOT_NOTE: 29,  // after 6 chord triads (float32 11–28)
  CONFIG_SELECTED_PAD: 30, // 0–4, posición en PAD_CLASSES (ver pad-catalog.js)

  RIGHT_HAND_DETECTED: 32,
  RIGHT_FINGER_COUNT: 33,
  RIGHT_PALM_ROTATION: 34,
  RIGHT_WRIST_X: 35,
  RIGHT_WRIST_Y: 36,
  RIGHT_LANDMARKS: 37,

  LEFT_HAND_DETECTED: 96,
  LEFT_PINCH_DISTANCE: 97,
  LEFT_PALM_ROTATION: 98,
  LEFT_WRIST_X: 99,
  LEFT_WRIST_Y: 100,
  LEFT_LANDMARKS: 101,

  AUDIO_MASTER_VOLUME: 160,
  AUDIO_CURRENT_FREQ: 161,
  AUDIO_ACTIVE_CHORD_INDEX: 162,
  AUDIO_MAJOR_MINOR_MIX: 163,
  AUDIO_VIBRATO_RATE: 164,
  AUDIO_VIBRATO_DEPTH: 165,
  AUDIO_ENVELOPE_STATE: 166,
  AUDIO_OSCILLOSCOPE_BUFFER: 167,
  AUDIO_SEVENTH_ACTIVE: 465, // int32; written by AudioWorklet for HUD/tag
  PERF_AUDIO_CALLBACK_MS: 466, // float32; sampled callback duration
  PERF_AUDIO_CALLBACK_BUDGET_MS: 467, // float32; quantum duration
  PERF_AUDIO_CALLBACK_COUNT: 468, // int32; sampled callback count

  RESERVED_CHORD_ROLES: 459  // int32 × 6 (459–464): role index for each chord
};

// Fixed vocabulary of scale degree names — generic, not scale-dependent.
// Roles are DERIVED from SCALES in main.js (DEGREE_NAMES map) and written
// to SAB zone 459–464 as indices into this enum; 192–197 stores seventh Hz.
export const ROLE_ENUM = ['Tónica','Segunda','Tercera','Cuarta','Quinta','Sexta'];

// Gestural thresholds & audio constants
export const HYSTERESIS_THRESHOLD = 0.02;
export const PALM_ROTATION_THRESHOLD = 0.35;
export const PALM_ROTATION_RELEASE_THRESHOLD = 0.25;
export const PINCH_OPEN_THRESHOLD = 0.15;
export const PINCH_CLOSE_THRESHOLD = 0.03;

export const ATTACK_TIME = 0.08;  // 80 ms — fuente única, importado por audio-engine.js
export const RELEASE_TIME = 0.15; // 150 ms

export const VIBRATO_BASE_RATE = 4.0;
export const VIBRATO_MAX_RATE = 12.0;
export const VIBRATO_MAX_DEPTH = 0.05;

export const OSCILLOSCOPE_BUFFER_SIZE = 25;

// MediaPipe Hand Skeleton connections (pairs of landmark indexes)
export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],       // Thumb
  [0, 5], [5, 6], [6, 7], [7, 8],       // Index
  [5, 9], [9, 10], [10, 11], [11, 12],  // Middle
  [9, 13], [13, 14], [14, 15], [15, 16],// Ring
  [13, 17], [17, 18], [18, 19], [19, 20],// Pinky
  [0, 17]                                // Palm base
];
