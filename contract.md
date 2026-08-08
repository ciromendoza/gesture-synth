# Gesture Synthesizer — Contrato Técnico

Documento de referencia para que cualquier agente continúe el trabajo.
Describe la arquitectura actual, el protocolo de comunicación, el layout de
memoria compartida y las reglas del proyecto.

---

## 1. Resumen

Sintetizador de audio en tiempo real controlado por gestos de las manos,
completamente cliente-servidor sin bundlers ni frameworks.

- **Frontend**: ES modules puros (`<script type="module">`), sin CommonJS.
- **Backend**: Node.js nativo (solo `http` y `fs`), sirve archivos estáticos.
- **Cámara**: MediaPipe Hands para detección de manos (2 manos, 21 landmarks cada una).
- **Comunicación entre hilos**: un único `SharedArrayBuffer` de 2048 bytes
  compartido entre el worker de tracking, el AudioWorklet y el main thread.
- **Audio**: AudioWorkletProcessor (`audio-engine.js`) genera síntesis por
  **6 pads seleccionables** (librería de la intro, interfaz `SynthVoice`
  común) + 6 efectos DSP compartidos.
- **Visualización**: Canvas2D espejado de la cámara, landmarks blancos,
  osciloscopio vertical a la izquierda, círculo de pinch, barras de datos.

---

## 2. Cómo ejecutar

```bash
npm install          # ya hecho; dependencias @mediapipe/hands y camera_utils
npm start            # node server.js → http://localhost:3000
```

El servidor usa el puerto 3000. Requiere **cámara** y navegador con soporte
de `SharedArrayBuffer` (Chrome/Edge modernos).

### Headers obligatorios (para SharedArrayBuffer)

El servidor (`server.js`) envía en **todas** las respuestas:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: cross-origin
```

Sin COOP/COEP, `SharedArrayBuffer` no existe y la app muestra error en la
pantalla de inicio. Los archivos de MediaPipe se sirven localmente desde
`public/lib/mediapipe/` precisamente para cumplir COEP (require-corp).

---

## 3. Arquitectura

```
┌─────────────────────────────────────────────────────────────────┐
│  MAIN THREAD (public/main.js)                                   │
│  • Orquestador: crea SAB, cámara, MediaPipe, worker, audio, UI  │
│  • MediaPipe corre AQUÍ (no en worker) — ver sección 8.1        │
│  • Loop @30fps: send() → landmarks → postMessage al worker      │
│  • Escribe config en SAB (writeConfigToSAB)                     │
└──────────────┬──────────────────────────────────────────────────┘
               │ postMessage({type:'landmarks', rightHand, leftHand})
               │
┌──────────────▼──────────────────────────────────────────────────┐
│  TRACKING WORKER (public/tracking-worker.js)  [classic worker]  │
│  • Convierte landmarks crudos → gestos con histéresis           │
│  • ESCRIBE gestos en SAB (mano der. índices 32–95, izq. 96–159) │
└──────────────┬──────────────────────────────────────────────────┘
               │ SAB (SharedArrayBuffer 2048 bytes, lectura/escritura directa)
┌──────────────▼──────────────────────────────────────────────────┐
│  AUDIO WORKLET (public/audio-engine.js)  [AudioWorklet]         │
│  • LEE gestos de SAB cada bloque de 128 muestras @48kHz         │
│  • Síntesis aditiva de acordes + 6 efectos + envolvente         │
│  • ESCRIBE estado de audio en SAB (índices 160–191)             │
└──────────────┬──────────────────────────────────────────────────┘
               │ SAB
┌──────────────▼──────────────────────────────────────────────────┐
│  GRAPHIC ENGINE (public/graphic-engine.js)  [main thread]       │
│  • Canvas2D fullscreen, cámara espejada de fondo                │
│  • LEE SAB para dibujar landmarks, osciloscopio, círculo, etc.  │
└─────────────────────────────────────────────────────────────────┘
```

**Regla de oro**: el SAB es el único canal de datos entre hilos.
El worker NO recibe datos de audio; el worklet NO recibe landmarks.

---

## 4. Layout del SharedArrayBuffer (2048 bytes)

Dos vistas se crean sobre el mismo buffer en cada hilo:

```js
const int32View   = new Int32Array(sab);   // índice = byteOffset / 4
const float32View = new Float32Array(sab); // índice = byteOffset / 4
```

**IMPORTANTE**: `int32View[N]` y `float32View[N]` apuntan a los MISMOS 4
bytes. Nunca uses el mismo índice con dos tipos distintos a la vez.

### 4.1 Zonas (índices de TypedArray, no bytes)

| Zona | Índices int32/float32 | Contenido |
|---|---|---|
| Config | 0–31 | sampleRate, bufferSize, canvas, cámara, efecto, raíz, frecuencias de acordes |
| Mano derecha | 32–95 | detección, dedos, rotación, wrist, 42 floats de landmarks |
| Mano izquierda | 96–159 | detección, pinch normalizado, rotación, wrist, 42 floats de landmarks |
| Audio state | 160–191 | volumen, frecuencia, acorde activo, osciloscopio (25 floats) |
| Reservado | 192–511 | 192–197: role index por acorde (int32 × 6); resto libre |

### 4.2 Índices exactos (fuente de verdad: `public/constants.js` → `INDEXES`)

**Config (escrito por main.js):**
| Índice | Tipo | Campo |
|---|---|---|
| 0 | int32 | sampleRate (48000) |
| 1 | int32 | bufferSize (128) |
| 2 | int32 | canvas width |
| 3 | int32 | canvas height |
| 4 | int32 | camera width (640) |
| 5 | int32 | camera height (480) |
| 6 | int32 | maxHands (2) |
| 7 | int32 | modelComplexity (1) |
| 8 | int32 | minDetectionConf (500 = 0.5×1000) |
| 9 | int32 | minTrackingConf (500) |
| 10 | int32 | selectedEffect (0–5) |
| 11–28 | float32 | 6 acordes × 3 frecuencias (generadas por escala+tónica) |
| 29 | int32 | rootNote (0–11, índice en NOTE_NAMES) |
| 30 | int32 | selectedPad (0–5, posición en PAD_CLASSES / PAD_CATALOG) |

**Mano derecha (escrito por tracking-worker):**
| Índice | Tipo | Campo |
|---|---|---|
| 32 | int32 | handDetected (1/0) |
| 33 | float32 | fingerCount (0–5, con histéresis; 0 = puño cerrado → acorde 5) |
| 34 | float32 | palmRotation = abs(atan2(dx, dy)) desde muñeca→MCP medio (0–π) |
| 35 | float32 | wrist.x |
| 36 | float32 | wrist.y |
| 37–78 | float32 | 21 landmarks × (x, y) |

**Mano izquierda (escrito por tracking-worker):**
| Índice | Tipo | Campo |
|---|---|---|
| 96 | int32 | handDetected (1/0) |
| 97 | float32 | pinchDist (normalizado 0–1 por palmLen: 0=cerrado, 1=abierto, invariante a distancia/mano) |
| 98 | float32 | pitchRotation (0–π, ver sección 6.2) |
| 99 | float32 | wrist.x |
| 100 | float32 | wrist.y |
| 101–142 | float32 | 21 landmarks × (x, y) |

**Audio state (escrito por audio-engine):**
| Índice | Tipo | Campo |
|---|---|---|
| 160 | float32 | volume suavizado (0–1) |
| 161 | float32 | frecuencia fundamental del acorde activo (Hz) — la que suena |
| 162 | int32 | chordIndex activo (0–5, -1 = silencio) |
| 163 | float32 | majorMinorMix (0 = mayor, 1 = menor) |
| 164 | float32 | effect mix (0–1, suavizado) |
| 165 | float32 | effect param (0–1, suavizado) |
| 166 | float32 | envelope (0–1) |
| 167–191 | float32 | osciloscopio (25 muestras) |

> El código usa **exclusivamente** `INDEXES` (índices de TypedArray). Los
> offsets en bytes fueron eliminados de constants.js — no reintroducirlos.

---

## 5. Protocolo de mensajes (postMessage)

### main → tracking-worker
```js
{ type: 'init', sab, config: {} }              // al arrancar; worker responde { type:'ready' }
{ type: 'landmarks', rightHand: arr21|null, leftHand: arr21|null }  // @30fps
```

### Notas
- El worker es **classic** (`new Worker('/tracking-worker.js')`), no module.
- `sab` se pasa por referencia en postMessage (los SAB se comparten, NO se
  transfieren — nunca ponerlo en la lista de transfer).
- MediaPipe corre en main thread; el worker solo recibe landmarks ya
  extraídos y escribe en el SAB.

---

## 6. Gestos y mapeo

### 6.1 Mano derecha → acordes (6)

| fingerCount (histéresis) | Acorde |
|---|---|
| 0 dedos (puño) | acorde 5 (6º acorde de la escala) |
| 1 dedo | acorde 0 |
| 2 dedos | acorde 1 |
| 3 dedos | acorde 2 |
| 4 dedos | acorde 3 |
| 5 dedos | acorde 4 |

- Detección de dedos extendidos: comparación tip vs pip con histéresis
  (±0.02 en coordenadas normalizadas) para evitar parpadeo.
- Pulgar: distancia(tip(4), MCP meñique(17)) vs distancia(IP(3), MCP meñique(17)).
  Si tip está más lejos, el pulgar está extendido — invariante a orientación/rotación.
  Otros dedos: `tip.y < pip.y`.
- **Rotación de palma** (índice 34): `abs(atan2(dx, dy))` con
  `dx = mcp9.x - wrist.x`, `dy = -(mcp9.y - wrist.y)`.
  Sirve como **switch binario mayor/menor**: `> 0.35 rad → menor`, si no mayor.

### 6.2 Mano izquierda → volumen y efecto

| Gesto | Control | Cálculo |
|---|---|---|
| Pinch (distancia pulgar↔índice) | **Volumen** | `pinchDistNorm = pinchDist / palmLen`; `clamp((pinchDistNorm - PINCH_MIN_NORM) / (PINCH_MAX_NORM - PINCH_MIN_NORM), 0, 1)` → 0–100%. PINCH_MIN_NORM≈0.15, PINCH_MAX_NORM≈0.80. Normalizado por palmLen en tracking-worker para invariancia a distancia a cámara y tamaño de mano. |
| Pitch (inclinación) | **Efecto** (mix y param) | 0–π radianes (mapeado desde 0–45° reales), ver abajo |

**Cálculo del pitch (índice 98)** — usa ángulo del vector wrist→MCP(9) (estructura rígida de palma, no se mueve al flexionar dedos):

```js
// Ángulo del vector wrist→MCP(9) respecto a la vertical.
// MCP(9) es el dedo medio de la palma — no se mueve al cerrar dedos.
const mcp9 = leftLandmarks[9];
const dx = mcp9.x - wrist.x;
const dy = mcp9.y - wrist.y;
const pitchAngle = Math.atan2(dx, -dy); // ángulo desde vertical
// Mapear 0–45° reales a 0–π en SAB (audio-engine aún ve 0–1 via leftPalmRot/π)
float32View[98] = clamp01(pitchAngle / (Math.PI / 4)) * Math.PI;
```

- **Rango limitado a 45°** (π/4 rad) en vez de 90° anteriores — el 100% del
  control corresponde a 45° de inclinación real de muñeca.
- **Invariante a flexión de dedos**: usa MCP(9) (estructura de palma) en vez
  de puntas de dedos (12, 16, 20) que se mueven al cerrar la mano.
- En audio-engine: `mix = clamp(leftPalmRot/π, 0, 1)` y
  `param = clamp(leftPalmRot/π, 0, 1)` (param default 0.5 sin mano).

### 6.3 Reglas de comportamiento

- **Sin mano izquierda**: volumen forzado a 0.7, mix a 0.0, param a 0.5.
- **Sin mano derecha**: silencio (chordIndex = -1).
- Envolvente ADSR simple: attack 80ms / release 150ms (constantes en
  `constants.js`, importadas por el worklet — fuente única, ver sección 8.3).

---

## 7. Escalas y acordes

Definidas en `main.js` como **6 acordes × intervalos de semitonos desde la raíz**:

```js
const SCALES = {
  'Mayor':       [[0,4,7],[5,9,12],[7,11,14],[9,12,16],[4,7,11],[2,5,9]],
  'Menor':       [[0,3,7],[5,8,12],[7,10,14],[8,12,15],[3,7,10],[2,5,8]],
  'Dorian':      [[0,3,7],[2,5,9],[3,7,10],[5,9,12],[7,10,14],[9,12,15]],
  'Mixolydian':  [[0,4,7],[2,5,9],[4,7,11],[5,9,12],[7,10,14],[9,12,15]],
  'Pentatónica': [[0,4,7],[5,9,12],[7,11,14],[9,12,16],[2,5,9],[0,4,7]],
  'Blues':       [[0,3,6,7],[3,6,9,12],[5,8,11,14],[6,9,12,15],[7,10,13,16],[0,3,7]]
};
```

- `generateChordFrequencies(rootIdx, scale)` → `rootFreq * 2^(semitone/12)`.
- Solo se usan los primeros 3 intervalos de cada acorde (triada).
- Se escriben en SAB índices float32 11–28 (6×3).
- **6º acorde (índice 5)**: activado por puño cerrado (fingerCount=0).
  - Mayor: ii (Dm, [2,5,9]) — el grado diatónico ii que faltaba.
  - Menor: ii° (Ddim, [2,5,8]) — el grado ii° natural de la escala menor.
  - Dorian: vi° (Adim, [9,12,15]) — el grado vi° de Dorian.
  - Mixolydian: vi (Am, [9,12,15]) — el grado vi de Mixolydian.
  - Pentatónica: I (C, [0,4,7]) — repetición de la tónica.
  - Blues: i (Cm, [0,3,7]) — tríada menor sobre la raíz.
- Tónica seleccionable (12 notas) + escala (6) + efecto (6) en la pantalla
  de inicio; config se escribe al SAB SOLO al pulsar Iniciar.
- rootNote reubicado a índice 29 (después de los 6×3 floats de acordes).

---

## 8. Detalles por archivo

### 8.1 `public/main.js` — orquestador
- Importa únicamente `GraphicEngine` (ES module).
- `initialize()`: cámara → SAB → `writeConfigToSAB()` → MediaPipe → worker →
  audio → video+gráficos → frame loop.
- **MediaPipe corre en el main thread** (no en worker) porque
  `@mediapipe/hands` usa `importScripts` internamente para sus `.wasm`/`.tflite`,
  lo cual falla dentro de workers. Es una restricción conocida.
- Frame loop @30fps: `handsInstance.send({image: videoElement})` →
  separa landmarks por `multiHandedness[i].label === 'Right'` →
  postMessage al worker. En espejo, la mano derecha del usuario aparece como
  "Left" según MediaPipe según la convención de imagen — se usa el label tal cual.
- `cleanup()` libera cámara, worker, audio y gráficos.

### 8.2 `public/tracking-worker.js` — gestos
- Classic worker. Escribe TODO lo de la sección 4.2.
- Histéresis por dedo (estados persistentes entre frames).
- `applyHysteresis(diff, state)`: si `diff > 0.02` → true; `< -0.02` → false.
- Pulgar: detección por distancias (tip→pinkyMCP vs IP→pinkyMCP), no por eje x.
- Pinch: normalizado por palmLen a 0–1 con rango [PINCH_MIN_NORM=0.15, PINCH_MAX_NORM=0.80].
- Pitch: ángulo del vector wrist→MCP(9) respecto a vertical, limitado a 45°.
- fingerCount=0 (puño cerrado) → audio-engine mapea a chordIndex=5 (6º acorde).
- No importa nada (clamp01 y applyHysteresis son funciones locales).

### 8.3 `public/audio-engine.js` — AudioWorkletProcessor
- Registrado como `'gesture-synthesizer'`.
- **Prohibido asignar memoria dentro de `process()`** — todos los buffers se
  pre-allocan en el constructor (`dryBuf`, `wetBuf`, `delayBuf`, `reverbBuf`).
- Guardas anti-denormal (`DENORMAL = 1e-18`) en feedback de filter y delay.
- Sintetiza los acordes con la **voz activa** (`this.voice`), seleccionada por
  `selectedPad` (SAB índice 30) entre 6 voces instanciadas UNA vez en el
  constructor: `this.voices = PAD_CLASSES.map(Cls => new Cls(sampleRate))`
  (`PAD_CLASSES` importado de `pad-registry.js` — módulo compartido con el
  main thread). En `process()` NO hay switch por pad — solo
  `voice.renderSample(freqs)`.
- Tercer grado ajustable mayor↔menor ANTES de renderizar:
  `third = chord[1] * 2^(-1/12)` si menor; las 3 frecuencias se pasan a la voz.
- Envolvente por voz: cada `SynthVoice` expone `attackTime`/`releaseTime`
  (defaults importados de `constants.js` — fuente única desde la ronda de
  limpieza). Pluck acorta `attackTime` a 2 ms (percusivo, su propia síntesis
  ya decae). Los pasos se recalculan al cambiar de pad.
- **Hot-swap de pad sin click** (sección 9, decisión 12): al detectar cambio
  de `selectedPad` con nota sostenida, estado `QUICK_RELEASE` (release de
  8 ms) seguido de re-trigger (`noteOn()` + ATTACK con el attack de la voz
  nueva). Evita la discontinuidad de cortar un synth y arrancar otro a mitad
  de ciclo de onda. Si no hay nota sostenida, el cambio es directo.
- `noteOn()` de la voz se llama al arrancar nota desde OFF/RELEASE y al
  completar un QUICK_RELEASE con nota aún sostenida (retrigger de fases /
  recarga de ruido de Karplus-Strong).
- Parámetros suavizados con EMA (coef 0.12) para evitar clics.
- **6 acordes** (índices 0–5); fingerCount=0 → chordIndex=5 (puño).
- Efectos (switch por `selectedEffect`): 0 Reverb (tap multi-deley,
  decay 0.30–0.65), 1 Vibrato/Chorus (depth 2–8%, LFO con **acumulador de
  fase persistente**), 2 Bitcrusher (3–12 bits), 3 Filter (LP 1-polo con
  coeficiente correcto por sampleRate, cutoff **logarítmico 150–8000 Hz**),
  4 Delay (feedback max 0.3, lectura con **interpolación fraccional**),
  5 Tremolo (rate suavizado per-sample, LFO con **acumulador de fase
  persistente**).
- **LFO (Chorus/Tremolo)**: fase por acumulador incrementado por muestra
  (`phase += 2π·rate/sampleRate`), NO derivada de `sampleIndex·rate` — la
  derivada saltaba de fase cada vez que `rate` cambiaba, y el salto crecía
  con el tiempo de sesión.
- Salida: saturación suave ±0.95 + clip duro ±1.0.
- Volumen: recibe pinchDist ya normalizado por palmLen 0–1 del tracking-worker.
- Escribe osciloscopio: 25 muestras de `wetBuf` con step.

### 8.4 `public/graphic-engine.js` — Canvas2D
- Render loop con requestAnimationFrame.
- **Cámara espejada**: `ctx.translate(w,0); ctx.scale(-1,1)`.
- **Tipografía**: stack sans-serif elegante (`-apple-system, BlinkMacSystemFont,
  "SF Pro Display", "Helvetica Neue", Arial, sans-serif`), pesos livianos
  300–400, `letter-spacing` vía `ctx.letterSpacing` con fallback silencioso.
- **Osciloscopio**: franja izquierda proporcional (`max(48, min(96, w*0.08))`);
  cada una de las 25 muestras se dibuja como una elipse "chata" (ancha > alta)
  cuyo tamaño y opacidad siguen la amplitud de la muestra — ecualizador de
  puntos, sin línea que las conecte. Las muestras se reparten entre un margen
  superior e inferior (`margin = max(12, w*0.02)`, mismo ritmo que el panel
  HUD) — no van de punta a punta de la pantalla.
- Landmarks: `x = (1.0 - sabX) * w` (inversión X por espejo).
- **Círculo de pinch**: radio `pow(volume, 0.55) * maxR * 1.4` con `maxR = max(60, min(120, h*0.15))`.
  Curva exponencial: círculo crece rápido con poco movimiento de dedos y se
  amplía más allá del rango físico entre pulgar e índice. Opacidad dinámica
  `1 - volume*0.7` (sólido cuando pequeño, se desvanece al crecer). Borde
  blanco siempre visible (`0.9`, 1.5 px).
- **Tag de acorde**: tooltip anclado a la muñeca **derecha** cuadro a cuadro
  (`float32View[35]/[36]`, invertido por espejo, offset +24px debajo de la
  muñeca). Nombre derivado de la frecuencia real que suena (`float32View[161]`
  vía `freqToNoteName()`) + modo maj/min + rol (lee `int32View[192+chord]` →
  `ROLE_ENUM[index]`). Opacidad controlada por el envelope de la voz activa
  (`float32View[166]`), se desvanece gradualmente durante el release tail.
  `_lastChordIndex` se preserva con envelope > 0 para que el tag persista
  mientras el sonido aún suena. Fondo `rgba(0,0,0,0.55)` con borde fino.
  **Se dibuja siempre que `envelope > 0`, sin depender de `rightDetected`.**
- **Panel HUD top-right**: panel semitransparente (`rgba(255,255,255,0.06)` +
  borde `0.25`, esquinas radius 8, padding ~14px) anclado a `w - panelW - margin`
  con `panelW = max(180, min(240, w*0.22))`. Contenido:
  - `Efecto seleccionado: {nombre}` (título, peso 400; `titleH = 26` para que
    no se pise con el label de la barra 1).
  - Barra **Volumen** (pinch izquierdo normalizado, valor en %).
  - Barra **FX Amount** (rotación izquierda `palmRot/π` → 0–1, valor en %).
  - **FPS renderizado** (loop de rAF del GraphicEngine) y debajo
    **FPS cámara** (lo mide `main.js` contando los `handsInstance.send()`
    efectivos y lo pasa vía `setCameraFps()` — no hay overlay de status suelto).
- **Resize reactivo**: `resizeCanvas()` en `window.resize` recalcula
  `canvas.width/height` y mantiene sincronizados los índices 2–3 del SAB.
  Todos los offsets visuales son proporcionales al tamaño real del canvas
  (franja del osciloscopio, panel HUD, radio del círculo).

### 8.5 `public/constants.js` — constantes
- Exporta `INDEXES` (índices de TypedArray, usado en todo el código),
  `ROLE_ENUM` (vocabulario fijo de grados musicales: Tónica→Sexta),
  umbrales, constantes de envolvente
  (ATTACK/RELEASE, fuente única) y `HAND_CONNECTIONS`.
- `CHORD_ROLES` fue eliminado — los roles ahora se derivan de `SCALES`
  vía `DEGREE_NAMES` map en `main.js` (single source of truth).
- `OFFSETS` (bytes) y `CHORDS` (frecuencias fijas) fueron eliminados —
  el runtime genera frecuencias por escala en main.js.

### 8.6 `public/index.html`
- Pantalla de inicio: selector de nota raíz (12), escala (6), efecto (6),
  **librería de pads (6, desde `PAD_CATALOG`)**,
  botón Iniciar, indicador de carga, mensaje de error.
- `<canvas id="main-canvas">` + `<script type="module" src="/main.js">`.
- Estilos: fondo oscuro, botones minimalistas, sin glow.

### 8.7 `server.js` / `mime-types.js`
- Servidor estático con COOP/COEP/CORP (sección 2).
- MIME types: `.js` → `application/javascript`, `.wasm` → `application/wasm`,
  `.tflite`/`.data`/`.bin` → `application/octet-stream`. Crítico para el
  AudioWorklet y la carga de MediaPipe.

### 8.8 `public/synths/` — librería de 6 pads + `pad-catalog.js`
- **`synth-voice.js`**: interfaz común `SynthVoice` (`constructor(sampleRate)`,
  `renderSample(freqs)` → muestra en [-1,1], `noteOn()`). Expone además
  `attackTime`/`releaseTime` (defaults de `constants.js`) para la envolvente
  por voz. audio-engine maneja compartidos: envolvente, volumen, mix dry/wet
  y soft-clip — NO se duplican por synth.
- **`polyblep.js`**: `polyBLEP(t, dt)` — corrección band-limited step que se
  RESTA de la onda naive (anti-aliasing de sierra y pulso).
- Los 6 pads (registry `PAD_CLASSES` en audio-engine.js; **el orden es
  sagrado**, ver gotcha sección 10):
  1. **Sine Pad** (`sine-pad.js`) — 3 osciladores seno, el código original
     migrado a la interfaz (comportamiento idéntico).
  2. **Saw Pad** (`saw-pad.js`) — sierra PolyBLEP (`2t-1 - polyBLEP`).
  3. **Square Pad** (`square-pad.js`) — pulso duty 50%:
     `square(t) = saw(t) − saw(t+0.5)`, ambos lados BLEP.
  4. **FM Bell** (`fm-bell-pad.js`) — FM de 2 operadores: portador a la
     frecuencia del acorde, modulador ratio fijo 2.4, índice 3.5. Parciales
     inarmónicos de campana. ADSR global lo sostiene (solo Pluck es percusivo).
  5. **Wavetable** (`wavetable-pad.js`) — tabla de 2048 samples con armónicos
     1..8 (amplitud 1/h, normalizada) pre-calculada EN el constructor; lectura
     con interpolación lineal.
  6. **Pluck** (`pluck-pad.js`) — Karplus-Strong: 3 delay-lines pre-alocadas
     (longitud para ~20 Hz, la nota más grave esperada), ruido en `noteOn()`,
     lectura fraccional (`sampleRate/freq`) para pitch exacto, feedback
     `0.5·(read + next)·decay` con `decay = 0.9997` (cola ~0.5 s). Ataque
     propio percusivo: `attackTime = 2 ms` (el ADSR global de 80 ms aplastaría
     el ataque); el RELEASE global sigue cortando la nota al abrir la mano.
- **`pad-registry.js`**: registro compartido `PAD_CLASSES` (las 6 clases, sin
  APIs de browser) — lo importa audio-engine.js para instanciar las voces y
  main.js para el preview de la intro. Mismo invariante de orden que el
  catálogo (sección 10).
- **`pad-catalog.js`**: SOLO metadata (`{id, name, description}`) sin lógica
  de audio — importable desde el main thread. `PAD_CATALOG[i].id === i` DEBE
  coincidir con la posición en `PAD_CLASSES` (gotcha sección 10).
- **Librería en la intro** (index.html + main.js): sección "Librería de pads"
  con el mismo patrón UI que escala/tónica (`buildButtonGroup` + `.sel-btn`);
  la selección se escribe al SAB índice 30 (`CONFIG_SELECTED_PAD`) en
  `writeConfigToSAB()`. El HUD (graphic-engine `drawDataBars`) muestra la
  línea "Pad: {nombre}" arriba de "Efecto: {nombre}" (título de 2 líneas,
  `titleH = 44`).
- **Preview de sonido en la intro** (main.js `playPadPreview`): al pasar el
  mouse o hacer click sobre un pad, renderiza ~1 s de la tríada C4 con la
  MISMA clase del registry (`PAD_CLASSES[padIdx]` — sin drift con el worklet)
  en un `AudioBuffer` y lo reproduce con `AudioBufferSourceNode`. Fade-in
  sigue el ataque propio de la voz (Pluck 4 ms, sostenidos hasta 50 ms) +
  fade-out 150 ms — sin clicks. El primer click reanuda el AudioContext
  (hover solo suena después de una activación). `stopPreview()` cierra el
  contexto al pulsar Iniciar (el app principal usa su propio AudioContext).

---

## 9. Decisiones de diseño (no revertir sin consultar)

1. **MediaPipe en main thread** — no se puede mover a worker (restricción de
   la librería, `importScripts` interno).
2. **Un solo SAB de 2048 bytes** compartido por los 3 hilos.
3. **SAB es el único canal de datos** entre hilos (sin postMessage de datos
   de audio ni landmarks al worklet).
4. **Pulgar cuenta como dedo** en la detección de la mano derecha
   (distancia tip(4)→pinkyMCP(17) vs IP(3)→pinkyMCP(17), invariante
   a orientación), por lo que 0–5 dedos es posible.
5. **Mayor/menor es binario** (umbral 0.35 rad en rotación de palma derecha),
   no interpolado.
6. **Pitch izquierdo**: 0% = erguido, 100% = inclinación de 45° (π/4 rad),
   con ángulo del vector wrist→MCP(9) (invariante a flexión de dedos).
   Rango [0, π] rad en el SAB (mapeado desde 0–45° reales).
7. **Etiqueta de acorde desde frecuencia real sonada** (índice 161), no por
   offset teórico.
8. Sin bundlers, sin frameworks, sin CommonJS en el cliente.
9. Volumen por defecto 0.7 cuando la mano izquierda no está presente.
10. `index.html` NO importa módulos de MediaPipe como ES modules — carga
    `hands.js` con `<script>` clásico (define `self.Hands` global).
11. **6º acorde (fingerCount=0/puño)**: usa el grado diatónico ii para Mayor,
    ii° para Menor, y equivalentes para las demás escalas. rootNote reubicado
    a índice 29 para dejar espacio para 6×3 floats de acordes.
12. **Hot-swap de pad con nota sostenida** = RELEASE corto (8 ms) + ATTACK
    con el attack de la voz nueva, NO el ADSR completo 80/150 ms — cambia de
    timbre sin discontinuidad audible. Sin nota sostenida, el switch es
    directo (silencioso).
13. **Solo Pluck es percusivo** (attack 2 ms): Sine/Saw/Square/FM/Wavetable
    usan el ADSR global. No se asume "una talla sirve para todos" — cada voz
    expone su propia envolvente y el resto usa el default de constants.js.

---

## 10. Gotchas conocidos

- **`int32View[N]` y `float32View[N]` comparten memoria**: rootNote (int32)
  reubicado a índice 29 para dejar espacio para 6×3=18 floats de acordes
  (11–28). No traslapar acordes más allá del índice 28.
- **No transferir el SAB** en postMessage (es compartido, no transferible).
- El cálculo de pitch usa MCP(9) (estructura rígida de palma) en vez de
  puntas de dedos — las puntas se mueven al flexionar y contaminan la medición
  de orientación de muñeca.
- El conteo de pulgar usa comparación de distancias (tip→pinkyMCP vs
  IP→pinkyMCP) en vez de coordenada x — la comparación por eje es sensible
  a la orientación de la mano y al espejo de imagen.
- El pinch se normaliza por palmLen (distancia wrist→MCP(9)) con rango
  [PINCH_MIN_NORM, PINCH_MAX_NORM] — invariante a distancia a cámara y
  tamaño de mano.
- **`mix ≈ 0` con muñeca izquierda en reposo**: `mix` se controla con la
  inclinación de la muñeca izquierda (`leftPalmRot/π`). Con la mano en reposo,
  cualquier efecto suena 100% seco sin importar si el algoritmo funciona —
  no confundir con un efecto roto; subir `mix` antes de juzgar al oído.
- **`id` de `PAD_CATALOG` ↔ posición en `PAD_CLASSES`**: el orden de las 6
  clases en el registry de audio-engine.js ES el contrato. El `id` de cada
  entrada del catálogo debe coincidir exactamente (0-5 en orden). Editar un
  lado sin el otro desincroniza la UI de la intro con el motor de audio —
  mismo tipo de invariante manual que ya causó bugs con los índices del SAB.
- **`selectedPad` comparte bytes con `float32View[30]`** (vistas int32/float32
  del mismo SAB): escribir el pad como int32 y nunca leerlo como float.

---

## 11. Estado y verificación

### Verificado (nivel código, sin cámara)

- Servidor arranca y sirve con headers COOP/COEP correctos (HTTP 200).
- Todos los archivos pasan `node --check` (sintaxis válida) y los módulos ES
  importan limpiamente.
- MIME types correctos para JS/WASM/TFLite (probados con Invoke-WebRequest).
- **Delay**: interpolación fraccional verificada empíricamente con test de
  impulso unitario en Node (réplica exacta de `fxDelay()`):
  - frac=0.5 → eco repartido 0.5/0.5 entre las dos muestras enteras.
  - frac=0 → eco de muestra completa única en la posición esperada.
  - frac=0.25 → energía 0.75/0.25 entre muestras adyacentes (dirección correcta).
- DSP de Chorus/Tremolo (acumulador de fase) y Filter (coeficiente one-pole +
  cutoff logarítmico) verificados línea por línea; matemática correcta.
- **6 pads de synth** verificados con test de render en Node (réplica exacta
  del uso real, `tmp/synth-render-test.js`):
  - Los 6 implementan `SynthVoice` y exponen envolvente > 0.
  - Salida acotada |x| < 1.2 y con energía (rms > 0.05) en los 6.
  - **Pitch 440 Hz por autocorrelación**: Sine/Saw/Square/Wavetable/Pluck
    → ~440.4 Hz; FM Bell → autocorrelación con pico fuerte (parciales
    inarmónicos, no se mide con cruces por cero).
  - **Anti-aliasing**: max diff muestra a muestra < 1.5 en todos (sierra/pulso
    naive saltarían ~2.0; con PolyBLEP la transición se reparte en 2 muestras).
  - **Pluck**: ataque propio 2 ms; decae solo (rms final < 85% del inicial en
    1 s — Karplus-Strong decae por PERIODO, ~0.5 s de cola es lo correcto);
    arranca con energía inmediata.
  - `node --check` en los 13 archivos JS tocados + imports ES OK en Node +
    servidor sirviendo `/synths/*.js` y `/pad-catalog.js` como
    `application/javascript` (verificado en vivo).
  - **Preview de la intro** verificado con test de buffer en Node
    (`tmp/preview-test.js`, réplica exacta de `playPadPreview`): los 6 pads
    → buffer acotado ≤ 0.5, con energía (el Pluck es más bajo en RMS por ser
    percusivo: pico fuerte + cola), sin clicks al inicio (env=0) ni al final
    (fade-out).

### Pendiente de prueba manual (requiere cámara)

Checklist final, con todos los fixes de rondas anteriores ya aplicados:

- [ ] 0–5 dedos → 6 acordes (incluye puño cerrado → acorde 5).
- [ ] Mayor/menor con rotación de palma derecha (umbral 0.35 rad).
- [ ] Volumen con pinch izquierdo en ≥2 distancias a la cámara
      (confirma la normalización por palmLen).
- [ ] Efecto (mix + param) con inclinación de muñeca izquierda.
      Subir `mix` (inclinar muñeca) antes de juzgar — en reposo mix≈0 y
      cualquier efecto suena 100% seco.
- [ ] Los 6 efectos individualmente: Reverb, Chorus, Bitcrush, Filter,
      Delay, Tremolo — sin clicks, sin comportamiento de interruptor,
      cambios de parámetro percibidos como continuos.
- [ ] Las 6 escalas × 12 tónicas — al menos una pasada rápida, sin
      frecuencias erróneas.
- [ ] Los 6 pads individualmente (Sine, Saw, Square, FM Bell, Wavetable,
      Pluck) — timbres claramente distintos, sin clicks ni aliasing áspero
      (especialmente Saw/Square, por BLEP).
- [ ] Hot-swap de pad con nota sostenida — cambio sin click ni
      discontinuidad audible (re-trigger rápido de 8 ms).
- [ ] Pluck: ataque percusivo natural y cola que decae sola (~0.5 s), no un
      pad sostenido; FM Bell suena metálico, no un seno con chorus.

> El historial detallado de bugs por ronda se conserva en `CHANGELOG.md`.

### Comandos útiles
```bash
node --check public/*.js server.js mime-types.js   # sintaxis
node --input-type=module -e "import('./public/graphic-engine.js').then(()=>console.log('OK'))"
node server.js                                     # servir en :3000
```

---

## 12. Mapa de rutas futuras (ideas, no acordadas)

- Persistir la configuración del usuario (localStorage).
- Controles de volumen maestro / mutear.
- Cambio de pad en caliente desde el gesto (p. ej. cerrar puño + rotación).
