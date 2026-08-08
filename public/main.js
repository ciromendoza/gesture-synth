// main.js — Orchestrator
import { GraphicEngine } from './graphic-engine.js';
import { PAD_CATALOG } from './pad-catalog.js';
import { PAD_CLASSES } from './pad-registry.js';
import { INDEXES, ROLE_ENUM, SAB_TOTAL_SIZE, TRACKING_INPUT } from './constants.js';

// ─── DOM ─────────────────────────────────────────────────────────────────────
const startScreen = document.getElementById('start-screen');
const startBtn = document.getElementById('start-btn');
const errorMsg = document.getElementById('error-msg');
const loadingIndicator = document.getElementById('loading-indicator');
const canvas = document.getElementById('main-canvas');

// ─── State ───────────────────────────────────────────────────────────────────
let sab = null, int32View = null, float32View = null;
let trackingWorker = null, audioContext = null, audioNode = null;
let graphicEngine = null, videoStream = null, videoElement = null;
let frameRAFId = null, videoFrameCallbackId = null, isRunning = false;
let handsInstance = null, lastHandResults = null;
let mediaPipeScriptPromise = null;
let trackingFrameSequence = 0, trackingSlotCursor = 0;
let inferenceInFlight = false;

const TRACKING_FPS = 30;
const CAMERA_WIDTH = 640;
const CAMERA_HEIGHT = 480;
const requestedTrackingQuality = new URLSearchParams(window.location.search).get('tracking');
const lowPowerDevice = (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) ||
  (navigator.deviceMemory && navigator.deviceMemory <= 4);
// Full is retained on desktop by default; ?tracking=lite opts into the much
// cheaper model, and low-power devices choose it automatically.
const TRACKING_MODEL_COMPLEXITY = requestedTrackingQuality === 'full' ? 1 :
  (requestedTrackingQuality === 'lite' || lowPowerDevice ? 0 : 1);

// ─── Music Theory Data ───────────────────────────────────────────────────────
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const NOTE_FREQS = [261.63,277.18,293.66,311.13,329.63,349.23,369.99,392.00,415.30,440.00,466.16,493.88];

// Scale definitions: 6 chords × four semitone intervals from root
// (triad + seventh). Chord 5 (index 5, fingerCount=0/fist) = ii for Mayor,
// ii° for Menor, vi° for Dorian, vi for Mixolydian, I repeat for Pentatónica,
// i for Blues.
const SCALES = {
  // Every chord now carries its diatonic seventh as the fourth interval.
  // The first three intervals remain unchanged in triad mode.
  'Mayor':       [[0,4,7,11],[5,9,12,16],[7,11,14,17],[9,12,16,19],[4,7,11,14],[2,5,9,12]],
  'Menor':       [[0,3,7,10],[5,8,12,15],[7,10,14,17],[8,12,15,19],[3,7,10,14],[2,5,8,12]],
  'Dorian':      [[0,3,7,10],[2,5,9,12],[3,7,10,14],[5,9,12,16],[7,10,14,17],[9,12,15,19]],
  'Mixolydian':  [[0,4,7,10],[2,5,9,12],[4,7,11,14],[5,9,12,16],[7,10,14,17],[9,12,15,19]],
  'Pentatónica': [[0,4,7,11],[5,9,12,16],[7,11,14,17],[9,12,16,19],[2,5,9,12],[0,4,7,11]],
  'Blues':       [[0,3,6,10],[3,6,9,13],[5,8,11,15],[6,9,12,16],[7,10,13,17],[0,3,7,10]]
};

const EFFECTS = ['Reverb','Vibrato','Bitcrusher','Filter','Delay','Tremolo'];

// ─── Scale degree derivation (contract §10, §11) ────────────────────────────
// Maps the semitone root of each chord (intervals[c][0]) to its diatonic
// degree name. CHORD_ROLES was removed: it was a duplicate that desynchronized
// from SCALES across rounds. Roles are now DERIVED from the same interval data
// that generates frequencies — one source of truth.
const DEGREE_NAMES = { 0:'Tónica', 2:'Segunda', 3:'Tercera', 4:'Tercera',
                       5:'Cuarta', 7:'Quinta', 8:'Sexta', 9:'Sexta',
                       10:'Séptima', 11:'Séptima' };

function rolesForScale(scaleName) {
  return SCALES[scaleName].map(chordIntervals => DEGREE_NAMES[chordIntervals[0]] || '?');
}

// ─── User selections ─────────────────────────────────────────────────────────
const userConfig = {
  rootNote: 0,       // index into NOTE_NAMES
  scale: 'Mayor',
  effect: 0,
  pad: 0             // index into PAD_CATALOG / PAD_CLASSES
};

// ─── Build UI buttons ────────────────────────────────────────────────────────
function buildButtonGroup(containerId, items, selectedIdx, onSelect) {
  const container = document.getElementById(containerId);
  items.forEach((item, i) => {
    const btn = document.createElement('button');
    btn.className = 'sel-btn' + (i === selectedIdx ? ' selected' : '');
    btn.textContent = item;
    btn.addEventListener('click', () => {
      container.querySelectorAll('.sel-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      onSelect(i, item);
    });
    container.appendChild(btn);
  });
}

buildButtonGroup('root-grid', NOTE_NAMES, 0, (i) => { userConfig.rootNote = i; });
buildButtonGroup('scale-grid', Object.keys(SCALES), 0, (i, name) => { userConfig.scale = name; });
buildButtonGroup('effect-grid', EFFECTS, 0, (i) => { userConfig.effect = i; });
buildButtonGroup('pad-grid', PAD_CATALOG.map(p => p.name), 0, (i) => { userConfig.pad = i; });

// ─── Preview de sonido en la intro (roadmap §12, nice-to-have) ──────────────
// Reusa las MISMAS clases que el worklet (pad-registry.js): renderiza ~1 s
// de la tríada C4 en un AudioBuffer y lo reproduce. Sin drift entre lo que
// se escucha en la intro y lo que suena al iniciar.
const PREVIEW_FREQS = [261.63, 329.63, 392.00]; // C4 mayor — tríada de prueba
let previewCtx = null, previewNode = null;
const previewBuffers = [];

function playPadPreview(padIdx) {
  const Cls = PAD_CLASSES[padIdx];
  if (!Cls) return;
  if (!previewCtx) previewCtx = new AudioContext();
  if (previewCtx.state === 'suspended') previewCtx.resume().catch(() => {}); // hover no activa; el primer click sí

  let buf = previewBuffers[padIdx];
  if (!buf) {
    const sr = previewCtx.sampleRate;
    const voice = new Cls(sr);
    voice.noteOn();

    const DUR = 1.0;
    const N = Math.floor(DUR * sr);
    // Fade-in siguiendo el ataque propio de la voz (hasta 50 ms) +
    // fade-out de 150 ms — sin clicks al cortar.
    const fadeIn = Math.min(Math.floor(0.05 * sr), Math.max(1, Math.floor(voice.attackTime * 2 * sr)));
    const fadeOut = Math.floor(0.15 * sr);
    buf = previewCtx.createBuffer(1, N, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < N; i++) {
      let s = voice.renderSample(PREVIEW_FREQS);
      const env = i < fadeIn ? i / fadeIn : i > N - fadeOut ? Math.max(0, (N - i) / fadeOut) : 1;
      s = Math.max(-1, Math.min(1, s * env)) * 0.5;
      data[i] = s;
    }
    previewBuffers[padIdx] = buf;
  }

  if (previewNode) { try { previewNode.stop(); } catch (e) {} previewNode = null; }
  const src = previewCtx.createBufferSource();
  src.buffer = buf;
  src.connect(previewCtx.destination);
  src.onended = () => { if (previewNode === src) previewNode = null; };
  previewNode = src;
  src.start();
}

// Hover (mouseenter, no mousemove) + click sobre cada botón de pad.
document.querySelectorAll('#pad-grid .sel-btn').forEach((btn, i) => {
  btn.addEventListener('mouseenter', () => playPadPreview(i));
  btn.addEventListener('click', () => playPadPreview(i));
});

function stopPreview() {
  if (previewNode) { try { previewNode.stop(); } catch (e) {} previewNode = null; }
  previewBuffers.length = 0;
  if (previewCtx) { previewCtx.close().catch(() => {}); previewCtx = null; }
}

// ─── Chord frequency generation ──────────────────────────────────────────────
function generateChordFrequencies(rootNoteIdx, scaleName) {
  const rootFreq = NOTE_FREQS[rootNoteIdx];
  const intervals = SCALES[scaleName];
  const chords = [];

  for (let c = 0; c < 6; c++) {
    const chordIntervals = intervals[c] || [0, 4, 7];
    const notes = [];
    for (let n = 0; n < 4; n++) {
      const semitones = chordIntervals[n] || 0;
      notes.push(rootFreq * Math.pow(2, semitones / 12));
    }
    chords.push(notes);
  }
  return chords;
}

// ─── Start ───────────────────────────────────────────────────────────────────
startBtn.addEventListener('click', () => initialize());

async function initialize() {
  stopPreview(); // el app principal arranca su propio AudioContext — no solapar

  if (typeof SharedArrayBuffer === 'undefined') {
    showError('SharedArrayBuffer no disponible. Headers COOP/COEP requeridos.');
    return;
  }

  startBtn.disabled = true;
  errorMsg.style.display = 'none';
  loadingIndicator.style.display = 'flex';

  try {
    // Camera
    loadingIndicator.querySelector('span').textContent = 'Solicitando cámara...';
    videoStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: CAMERA_WIDTH, max: CAMERA_WIDTH },
        height: { ideal: CAMERA_HEIGHT, max: CAMERA_HEIGHT },
        frameRate: { ideal: TRACKING_FPS, max: TRACKING_FPS },
        facingMode: 'user'
      },
      audio: false
    });

    // SAB
    sab = new SharedArrayBuffer(SAB_TOTAL_SIZE);
    int32View = new Int32Array(sab);
    float32View = new Float32Array(sab);
    writeConfigToSAB(videoStream.getVideoTracks()[0]?.getSettings());

    // MediaPipe
    loadingIndicator.querySelector('span').textContent = 'Cargando MediaPipe...';
    await loadMediaPipeHands();

    // Tracking worker
    loadingIndicator.querySelector('span').textContent = 'Iniciando worker...';
    trackingWorker = new Worker('/tracking-worker.js');
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Worker timeout')), 10000);
      trackingWorker.onmessage = (e) => {
        if (e.data?.type === 'ready') { clearTimeout(t); resolve(); }
        else if (e.data?.type === 'error') { clearTimeout(t); reject(new Error(e.data.message)); }
      };
      trackingWorker.onerror = (e) => { clearTimeout(t); reject(e); };
      trackingWorker.postMessage({ type: 'init', sab, config: {} });
    });

    // Audio
    loadingIndicator.querySelector('span').textContent = 'Inicializando audio...';
    // Let the browser use the native output rate; the synth reads the actual
    // AudioWorklet sampleRate and avoids an unnecessary resampling stage.
    audioContext = new AudioContext();
    int32View[0] = audioContext.sampleRate;
    await audioContext.audioWorklet.addModule('/audio-engine.js');
    audioNode = new AudioWorkletNode(audioContext, 'gesture-synthesizer', {
      processorOptions: { sab }
    });
    audioNode.connect(audioContext.destination);

    // Video + Graphic
    loadingIndicator.querySelector('span').textContent = 'Iniciando video...';
    setupVideoCapture();
    graphicEngine = new GraphicEngine(canvas, sab, videoElement);
    graphicEngine.start();

    canvas.classList.add('active');
    startScreen.classList.add('hidden');
    isRunning = true;
    startFrameLoop();

  } catch (err) {
    showError(`Error: ${err.message}`);
    startBtn.disabled = false;
    loadingIndicator.style.display = 'none';
    cleanup();
  }
}

// ─── Write config to SAB ────────────────────────────────────────────────────
function writeConfigToSAB(cameraSettings = {}) {
  int32View[0] = 48000;         // sampleRate (replaced with the actual AudioContext rate)
  int32View[1] = 128;           // bufferSize
  int32View[2] = window.innerWidth;
  int32View[3] = window.innerHeight;
  int32View[4] = cameraSettings.width || CAMERA_WIDTH;
  int32View[5] = cameraSettings.height || CAMERA_HEIGHT;
  int32View[6] = 2;             // maxHands
  int32View[7] = TRACKING_MODEL_COMPLEXITY;
  int32View[8] = 500;           // minDetectionConf
  int32View[9] = 500;           // minTrackingConf
  int32View[10] = userConfig.effect; // selectedEffect
  int32View[30] = userConfig.pad;    // selectedPad (0–4, posición en PAD_CLASSES)

  // Write 6 chord triads to SAB config zone (float32 index 11–28).
  // The fourth/seventh tone lives in reserved float32 indices 192–197 so the
  // hand state zones remain stable.
  const chords = generateChordFrequencies(userConfig.rootNote, userConfig.scale);
  for (let c = 0; c < 6; c++) {
    for (let n = 0; n < 3; n++) {
      float32View[11 + c * 3 + n] = chords[c][n];
    }
    float32View[INDEXES.CONFIG_CHORD_SEVENTHS + c] = chords[c][3];
  }
  int32View[INDEXES.CONFIG_ROOT_NOTE] = userConfig.rootNote; // root note index (0–11)

  // Write scale degree roles to the tail of the reserved zone. The seventh
  // frequencies occupy 192–197 and therefore cannot share those bytes.
  const roles = rolesForScale(userConfig.scale);
  for (let c = 0; c < 6; c++) {
    int32View[INDEXES.RESERVED_CHORD_ROLES + c] = ROLE_ENUM.indexOf(roles[c]);
  }

  for (const slot of TRACKING_INPUT.SLOTS) {
    Atomics.store(int32View, slot + TRACKING_INPUT.SEQUENCE, 0);
    Atomics.store(int32View, slot + TRACKING_INPUT.RIGHT_PRESENT, 0);
    Atomics.store(int32View, slot + TRACKING_INPUT.LEFT_PRESENT, 0);
  }
  trackingFrameSequence = 0;
  trackingSlotCursor = 0;

  Atomics.store(int32View, 32, 0);  // RIGHT_HAND_DETECTED
  Atomics.store(int32View, 96, 0);  // LEFT_HAND_DETECTED
  int32View[INDEXES.AUDIO_ACTIVE_CHORD_INDEX] = -1;
  Atomics.store(int32View, INDEXES.AUDIO_SEVENTH_ACTIVE, 0);
}

// ─── MediaPipe ───────────────────────────────────────────────────────────────
function loadMediaPipeHands() {
  if (!mediaPipeScriptPromise) {
    mediaPipeScriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/lib/mediapipe/hands.js';
      s.onload = resolve;
      s.onerror = () => {
        mediaPipeScriptPromise = null;
        reject(new Error('Failed to load MediaPipe'));
      };
      document.head.appendChild(s);
    });
  }

  return mediaPipeScriptPromise.then(async () => {
    handsInstance = new self.Hands({ locateFile: (f) => `/lib/mediapipe/${f}` });
    handsInstance.setOptions({
      maxNumHands: 2,
      modelComplexity: TRACKING_MODEL_COMPLEXITY,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });
    handsInstance.onResults((r) => { lastHandResults = r; });
    await handsInstance.initialize();
  });
}

// ─── Video ───────────────────────────────────────────────────────────────────
function setupVideoCapture() {
  videoElement = document.createElement('video');
  videoElement.srcObject = videoStream;
  videoElement.playsInline = true;
  videoElement.muted = true;
  videoElement.className = 'camera-feed';
  videoElement.setAttribute('aria-hidden', 'true');
  document.body.appendChild(videoElement);
  videoElement.play().catch(() => {});
}

// ─── Tracking frame loop ────────────────────────────────────────────────────
// MediaPipe is driven by real video frames when the browser supports
// requestVideoFrameCallback(). The fallback uses rAF but never sends the same
// video timestamp twice and never allows two inferences in flight.
function startFrameLoop() {
  stopFrameLoop();
  let lastVideoTime = -1;
  let camFrameCount = 0;
  let camFpsTimer = performance.now();

  const publishCameraFps = (now) => {
    if (now - camFpsTimer < 1000) return;
    const camFps = Math.round((camFrameCount * 1000) / (now - camFpsTimer));
    camFrameCount = 0;
    camFpsTimer = now;
    graphicEngine?.setCameraFps(camFps);
  };

  const inferCurrentFrame = async (videoTime) => {
    if (!isRunning || !handsInstance || !videoElement || videoElement.readyState < 2) return;
    if (inferenceInFlight || videoTime === lastVideoTime) return;
    lastVideoTime = videoTime;
    inferenceInFlight = true;
    try {
      await handsInstance.send({ image: videoElement });
      const r = lastHandResults;
      let rh = null;
      let lh = null;
      if (r?.multiHandLandmarks && r?.multiHandedness) {
        for (let i = 0; i < r.multiHandLandmarks.length; i++) {
          if (r.multiHandedness[i].label === 'Right') rh = r.multiHandLandmarks[i];
          else lh = r.multiHandLandmarks[i];
        }
      }
      publishLandmarksToSAB(rh, lh);
      camFrameCount++;
      publishCameraFps(performance.now());
    } catch (e) {
      // A transient camera/model error should not kill the render loop or leave
      // a stale chord held in the audio engine.
      publishLandmarksToSAB(null, null);
    } finally {
      inferenceInFlight = false;
    }
  };

  const scheduleVideoFrame = () => {
    if (!isRunning || !videoElement) return;
    if (typeof videoElement.requestVideoFrameCallback === 'function') {
      videoFrameCallbackId = videoElement.requestVideoFrameCallback((_, metadata) => {
        const mediaTime = metadata?.mediaTime ?? videoElement.currentTime;
        inferCurrentFrame(mediaTime).finally(scheduleVideoFrame);
      });
      return;
    }

    const tick = () => {
      if (!isRunning) return;
      const mediaTime = videoElement.currentTime;
      inferCurrentFrame(mediaTime).finally(() => {
        frameRAFId = requestAnimationFrame(tick);
      });
    };
    frameRAFId = requestAnimationFrame(tick);
  };

  scheduleVideoFrame();
}

function stopFrameLoop() {
  if (frameRAFId !== null) {
    cancelAnimationFrame(frameRAFId);
    frameRAFId = null;
  }
  if (videoFrameCallbackId !== null && videoElement?.cancelVideoFrameCallback) {
    videoElement.cancelVideoFrameCallback(videoFrameCallbackId);
    videoFrameCallbackId = null;
  }
}

function publishLandmarksToSAB(rightHand, leftHand) {
  if (!int32View || !trackingWorker) return;

  const slot = TRACKING_INPUT.SLOTS[trackingSlotCursor];
  trackingSlotCursor = (trackingSlotCursor + 1) % TRACKING_INPUT.SLOT_COUNT;
  const sequence = ++trackingFrameSequence;
  const sequenceIndex = slot + TRACKING_INPUT.SEQUENCE;
  const rightPresentIndex = slot + TRACKING_INPUT.RIGHT_PRESENT;
  const leftPresentIndex = slot + TRACKING_INPUT.LEFT_PRESENT;

  // Negative marks the slot as being written. The worker only accepts the
  // positive sequence after every coordinate and presence flag is published.
  Atomics.store(int32View, sequenceIndex, -sequence);
  Atomics.store(int32View, rightPresentIndex, rightHand ? 1 : 0);
  Atomics.store(int32View, leftPresentIndex, leftHand ? 1 : 0);
  copyLandmarksToSAB(rightHand, slot + TRACKING_INPUT.RIGHT_LANDMARKS);
  copyLandmarksToSAB(leftHand, slot + TRACKING_INPUT.LEFT_LANDMARKS);
  Atomics.store(int32View, sequenceIndex, sequence);

  // Only the slot/sequence token is cloned; the 84 landmark coordinates stay
  // in the shared buffer. A stale token is discarded by the worker.
  trackingWorker.postMessage({ type: 'frame', slot, sequence });
}

function copyLandmarksToSAB(landmarks, offset) {
  for (let i = 0; i < 42; i += 2) {
    const point = landmarks?.[i / 2];
    float32View[offset + i] = point?.x || 0;
    float32View[offset + i + 1] = point?.y || 0;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function showError(msg) { errorMsg.textContent = msg; errorMsg.style.display = 'block'; }

function resetGestureState() {
  if (!int32View) return;
  Atomics.store(int32View, 32, 0);
  Atomics.store(int32View, 96, 0);
  Atomics.store(int32View, INDEXES.AUDIO_SEVENTH_ACTIVE, 0);
  int32View[33] = 0;
  int32View[97] = 0;
}

async function pauseForHiddenPage() {
  if (!isRunning) return;
  stopFrameLoop();
  resetGestureState();
  videoElement?.pause();
  graphicEngine?.stop();
  if (audioContext?.state === 'running') {
    try { await audioContext.suspend(); } catch (e) {}
  }
}

async function resumeVisiblePage() {
  if (!isRunning) return;
  try { await videoElement?.play(); } catch (e) {}
  if (audioContext?.state === 'suspended') {
    try { await audioContext.resume(); } catch (e) {}
  }
  graphicEngine?.start();
  startFrameLoop();
}

function cleanup() {
  stopFrameLoop();
  resetGestureState();
  if (videoStream) { videoStream.getTracks().forEach(t => t.stop()); videoStream = null; }
  if (videoElement) { videoElement.remove(); videoElement = null; }
  if (trackingWorker) { trackingWorker.terminate(); trackingWorker = null; }
  if (audioNode) { audioNode.disconnect(); audioNode = null; }
  if (audioContext?.state !== 'closed') { audioContext?.close(); audioContext = null; }
  if (graphicEngine) { graphicEngine.destroy(); graphicEngine = null; }
  if (handsInstance?.close) { handsInstance.close().catch(() => {}); }
  handsInstance = null;
  lastHandResults = null;
  isRunning = false;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseForHiddenPage();
  else resumeVisiblePage();
});

window.addEventListener('beforeunload', () => { isRunning = false; cleanup(); });
