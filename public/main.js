// main.js — Orchestrator
import { GraphicEngine } from './graphic-engine.js';
import { PAD_CATALOG } from './pad-catalog.js';
import { PAD_CLASSES } from './pad-registry.js';
import { ROLE_ENUM } from './constants.js';

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
let frameRAFId = null, isRunning = false;
let handsInstance = null, lastHandResults = null;

// ─── Music Theory Data ───────────────────────────────────────────────────────
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const NOTE_FREQS = [261.63,277.18,293.66,311.13,329.63,349.23,369.99,392.00,415.30,440.00,466.16,493.88];

// Scale definitions: 6 chords × semitone intervals from root
// Chord 5 (index 5, fingerCount=0/fist) = ii for Mayor, ii° for Menor,
// vi° for Dorian, vi for Mixolydian, I repeat for Pentatónica, i for Blues.
const SCALES = {
  'Mayor':       [[0,4,7],[5,9,12],[7,11,14],[9,12,16],[4,7,11],[2,5,9]],
  'Menor':       [[0,3,7],[5,8,12],[7,10,14],[8,12,15],[3,7,10],[2,5,8]],
  'Dorian':      [[0,3,7],[2,5,9],[3,7,10],[5,9,12],[7,10,14],[9,12,15]],
  'Mixolydian':  [[0,4,7],[2,5,9],[4,7,11],[5,9,12],[7,10,14],[9,12,15]],
  'Pentatónica': [[0,4,7],[5,9,12],[7,11,14],[9,12,16],[2,5,9],[0,4,7]],
  'Blues':       [[0,3,6,7],[3,6,9,12],[5,8,11,14],[6,9,12,15],[7,10,13,16],[0,3,7]]
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

function playPadPreview(padIdx) {
  const Cls = PAD_CLASSES[padIdx];
  if (!Cls) return;
  if (!previewCtx) previewCtx = new AudioContext({ sampleRate: 48000 });
  if (previewCtx.state === 'suspended') previewCtx.resume().catch(() => {}); // hover no activa; el primer click sí
  const sr = previewCtx.sampleRate;
  const voice = new Cls(sr);
  voice.noteOn();

  const DUR = 1.0;
  const N = Math.floor(DUR * sr);
  // Fade-in siguiendo el ataque propio de la voz (hasta 50 ms) +
  // fade-out de 150 ms — sin clicks al cortar.
  const fadeIn = Math.min(Math.floor(0.05 * sr), Math.max(1, Math.floor(voice.attackTime * 2 * sr)));
  const fadeOut = Math.floor(0.15 * sr);
  const buf = previewCtx.createBuffer(1, N, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < N; i++) {
    let s = voice.renderSample(PREVIEW_FREQS);
    const env = i < fadeIn ? i / fadeIn : i > N - fadeOut ? Math.max(0, (N - i) / fadeOut) : 1;
    s = Math.max(-1, Math.min(1, s * env)) * 0.5;
    data[i] = s;
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
    for (let n = 0; n < 3; n++) {
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
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false
    });

    // SAB
    sab = new SharedArrayBuffer(2048);
    int32View = new Int32Array(sab);
    float32View = new Float32Array(sab);
    writeConfigToSAB();

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
    audioContext = new AudioContext({ sampleRate: 48000 });
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
function writeConfigToSAB() {
  int32View[0] = 48000;         // sampleRate
  int32View[1] = 128;           // bufferSize
  int32View[2] = window.innerWidth;
  int32View[3] = window.innerHeight;
  int32View[4] = 640;           // cameraWidth
  int32View[5] = 480;           // cameraHeight
  int32View[6] = 2;             // maxHands
  int32View[7] = 1;             // modelComplexity
  int32View[8] = 500;           // minDetectionConf
  int32View[9] = 500;           // minTrackingConf
  int32View[10] = userConfig.effect; // selectedEffect
  int32View[30] = userConfig.pad;    // selectedPad (0–5, posición en PAD_CLASSES)

  // Write 6 chord frequencies to SAB config zone (float32 index 11–28)
  // Root note moved to index 29 (after 6×3=18 floats)
  const chords = generateChordFrequencies(userConfig.rootNote, userConfig.scale);
  for (let c = 0; c < 6; c++) {
    for (let n = 0; n < 3; n++) {
      float32View[11 + c * 3 + n] = chords[c][n];
    }
  }
  int32View[29] = userConfig.rootNote; // root note index (0–11)

  // Write scale degree roles to reserved zone (int32 192–197).
  // Indices into ROLE_ENUM — derived from the same intervals as frequencies.
  const roles = rolesForScale(userConfig.scale);
  for (let c = 0; c < 6; c++) {
    int32View[192 + c] = ROLE_ENUM.indexOf(roles[c]);
  }

  int32View[32] = 0;  // RIGHT_HAND_DETECTED
  int32View[96] = 0;  // LEFT_HAND_DETECTED
  int32View[162] = -1; // AUDIO_ACTIVE_CHORD_INDEX
}

// ─── MediaPipe ───────────────────────────────────────────────────────────────
function loadMediaPipeHands() {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/lib/mediapipe/hands.js';
    s.onload = async () => {
      try {
        handsInstance = new self.Hands({ locateFile: (f) => `/lib/mediapipe/${f}` });
        handsInstance.setOptions({ maxNumHands: 2, modelComplexity: 1, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
        handsInstance.onResults((r) => { lastHandResults = r; });
        await handsInstance.initialize();
        resolve();
      } catch (e) { reject(e); }
    };
    s.onerror = () => reject(new Error('Failed to load MediaPipe'));
    document.head.appendChild(s);
  });
}

// ─── Video ───────────────────────────────────────────────────────────────────
function setupVideoCapture() {
  videoElement = document.createElement('video');
  videoElement.srcObject = videoStream;
  videoElement.playsInline = true;
  videoElement.muted = true;
  videoElement.style.display = 'none';
  document.body.appendChild(videoElement);
  videoElement.play().catch(() => {});
}

// ─── Frame loop ──────────────────────────────────────────────────────────────
function startFrameLoop() {
  let lastT = 0;
  const INTERVAL = 1000 / 30;
  let camFrameCount = 0;
  let camFpsTimer = performance.now();

  async function tick(ts) {
    if (!isRunning) return;
    if (ts - lastT >= INTERVAL && videoElement?.readyState >= 2 && handsInstance) {
      lastT = ts;
      try {
        await handsInstance.send({ image: videoElement });
        camFrameCount++;
        const r = lastHandResults;
        let rh = null, lh = null;
        if (r?.multiHandLandmarks && r?.multiHandedness) {
          for (let i = 0; i < r.multiHandLandmarks.length; i++) {
            if (r.multiHandedness[i].label === 'Right') rh = r.multiHandLandmarks[i];
            else lh = r.multiHandLandmarks[i];
          }
        }
        trackingWorker?.postMessage({ type: 'landmarks', rightHand: rh, leftHand: lh });
      } catch (e) {}
    }
    // Camera FPS, once per second — feeds the HUD panel in graphic-engine
    if (ts - camFpsTimer >= 1000) {
      const camFps = Math.round((camFrameCount * 1000) / (ts - camFpsTimer));
      camFrameCount = 0;
      camFpsTimer = ts;
      graphicEngine?.setCameraFps(camFps);
    }
    frameRAFId = requestAnimationFrame(tick);
  }
  frameRAFId = requestAnimationFrame(tick);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function showError(msg) { errorMsg.textContent = msg; errorMsg.style.display = 'block'; }

function cleanup() {
  if (frameRAFId) { cancelAnimationFrame(frameRAFId); frameRAFId = null; }
  if (videoStream) { videoStream.getTracks().forEach(t => t.stop()); videoStream = null; }
  if (videoElement) { videoElement.remove(); videoElement = null; }
  if (trackingWorker) { trackingWorker.terminate(); trackingWorker = null; }
  if (audioNode) { audioNode.disconnect(); audioNode = null; }
  if (audioContext?.state !== 'closed') { audioContext?.close(); audioContext = null; }
  if (graphicEngine) { graphicEngine.stop(); graphicEngine = null; }
  handsInstance = null;
}

window.addEventListener('beforeunload', () => { isRunning = false; cleanup(); });
