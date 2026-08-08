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
  Los landmarks entran por slots del SAB; `postMessage` solo transporta un
  token pequeño de slot/secuencia.
- **Audio**: AudioWorkletProcessor (`audio-engine.js`) genera síntesis por
  **5 pads seleccionables** (librería de la intro, interfaz `SynthVoice`
  común) + 6 efectos DSP compartidos.
- **Visualización**: vídeo espejado en una capa del compositor del navegador
  y Canvas2D transparente solo para overlays, landmarks blancos,
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
│  • Loop por frame de vídeo: send() → landmarks → token al worker │
│  • Escribe config en SAB (writeConfigToSAB)                     │
└──────────────┬──────────────────────────────────────────────────┘
               │ postMessage({type:'frame', slot, sequence})
               │
┌──────────────▼──────────────────────────────────────────────────┐
│  TRACKING WORKER (public/tracking-worker.js)  [classic worker]  │
│  • Convierte landmarks crudos → gestos con histéresis           │
│  • ESCRIBE gestos en SAB (mano der. índices 32–95, izq. 96–159) │
└──────────────┬──────────────────────────────────────────────────┘
               │ SAB (SharedArrayBuffer 2048 bytes, lectura/escritura directa)
┌──────────────▼──────────────────────────────────────────────────┐
│  AUDIO WORKLET (public/audio-engine.js)  [AudioWorklet]         │
│  • LEE gestos de SAB cada bloque de 128 muestras @sampleRate     │
│  • Síntesis aditiva de acordes + 6 efectos + envolvente         │
│  • ESCRIBE estado de audio en SAB (índices 160–191)             │
└──────────────┬──────────────────────────────────────────────────┘
               │ SAB
┌──────────────▼──────────────────────────────────────────────────┐
│  GRAPHIC ENGINE (public/graphic-engine.js)  [main thread]       │
│  • Canvas2D overlay transparente sobre el vídeo espejado        │
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
| Reservado | 192–511 | 192–197: séptimas; 198–458: 3 slots de landmarks; 459–464: roles; 465: seventh active; 466–468: métricas de audio; resto libre |

### 4.2 Índices exactos (fuente de verdad: `public/constants.js` → `INDEXES`)

**Config (escrito por main.js):**
| Índice | Tipo | Campo |
|---|---|---|
| 0 | int32 | sampleRate real del `AudioContext` (habitualmente 44100/48000) |
| 1 | int32 | bufferSize (128) |
| 2 | int32 | canvas width |
| 3 | int32 | canvas height |
| 4 | int32 | camera width (640) |
| 5 | int32 | camera height (480) |
| 6 | int32 | maxHands (2) |
| 7 | int32 | modelComplexity (0 Lite / 1 Full) |
| 8 | int32 | minDetectionConf (500 = 0.5×1000) |
| 9 | int32 | minTrackingConf (500) |
| 10 | int32 | selectedEffect (0–5) |
| 11–28 | float32 | 6 acordes × 3 frecuencias de triada |
| 29 | int32 | rootNote (0–11, índice en NOTE_NAMES) |
| 30 | int32 | selectedPad (0–4, posición en PAD_CLASSES / PAD_CATALOG) |
| 192–197 | float32 | frecuencia de séptima para cada acorde |

**Reservado / estado extendido:** `459–464` contiene el role index por acorde;
`465` contiene `seventh active` (0/1), escrito por AudioWorklet; `466–468`
contienen duración muestreada del callback, duración teórica del quantum y
contador de muestras de audio.

**Entrada de tracking (escrita por main.js, leída por tracking-worker):**

Cada slot ocupa 87 índices: `sequence`, `rightPresent`, `leftPresent`,
42 floats de mano derecha y 42 floats de mano izquierda. Los slots empiezan
en 198, 285 y 372. El main escribe una secuencia negativa mientras el slot
está en progreso y publica la secuencia positiva al terminar; el worker
descarta tokens obsoletos o slots incompletos.

**Mano derecha (escrito por tracking-worker):**
| Índice | Tipo | Campo |
|---|---|---|
| 32 | int32 | handDetected (1/0) |
| 33 | float32 | fingerCount (0–5, con histéresis; 0 = puño cerrado → acorde 5) |
| 34 | float32 | signed palmRotation en espacio espejado; derecha >0, izquierda <0 |
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
| 465 | int32 | seventh active (0/1) |

> `constants.js` es la referencia de índices y offsets del SAB. Los índices
> nuevos de entrada de tracking se exportan como `TRACKING_INPUT`; no
> reintroducir offsets en bytes.

---

## 5. Protocolo de mensajes (postMessage)

### main → tracking-worker
```js
{ type: 'init', sab, config: {} }              // al arrancar; worker responde { type:'ready' }
{ type: 'frame', slot, sequence }              // token; coordenadas están en SAB
```

### Notas
- El worker es **classic** (`new Worker('/tracking-worker.js')`), no module.
- `sab` se pasa por referencia en postMessage (los SAB se comparten, NO se
  transfieren — nunca ponerlo en la lista de transfer).
- MediaPipe corre en main thread; el main escribe landmarks en los slots del
  SAB y el worker solo recibe el token de slot/secuencia.

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
- **Rotación de palma** (índice 34): ángulo firmado en espacio de pantalla
  espejado: `atan2(displayDX, displayDY)`, con `displayDX = -(mcp9.x - wrist.x)`
  y `displayDY = -(mcp9.y - wrist.y)`.
- Umbral `PALM_ROTATION_THRESHOLD = 0.35 rad` con retorno/histéresis en
  `PALM_ROTATION_RELEASE_THRESHOLD = 0.25 rad`:
  - `rotation > +0.35` → conserva la **menor**.
  - `rotation < -0.35` → activa la **séptima** del acorde.
  - entre ambos → triada mayor normal, salvo que el gesto anterior siga dentro
    de su banda de histéresis.
- La séptima se escribe como el cuarto intervalo de cada entrada de `SCALES`
  y se mezcla solo cuando el gesto izquierdo está activo; no se altera la raíz
  ni el mapeo 0–5 dedos → acorde.

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
- **Giro derecho** de la palma: tercera menor, como en la versión anterior.
- **Giro izquierdo** de la palma: cuarta frecuencia de la escala activa (la
  séptima), manteniendo la raíz y el acorde seleccionados por los dedos.
- Envolvente ADSR simple: attack 80ms / release 150ms (constantes en
  `constants.js`, importadas por el worklet — fuente única, ver sección 8.3).

---

## 7. Escalas y acordes

Definidas en `main.js` como **6 acordes × intervalos de semitonos desde la raíz**:

```js
const SCALES = {
  'Mayor':       [[0,4,7,11],[5,9,12,16],[7,11,14,17],[9,12,16,19],[4,7,11,14],[2,5,9,12]],
  'Menor':       [[0,3,7,10],[5,8,12,15],[7,10,14,17],[8,12,15,19],[3,7,10,14],[2,5,8,12]],
  'Dorian':      [[0,3,7,10],[2,5,9,12],[3,7,10,14],[5,9,12,16],[7,10,14,17],[9,12,15,19]],
  'Mixolydian':  [[0,4,7,10],[2,5,9,12],[4,7,11,14],[5,9,12,16],[7,10,14,17],[9,12,15,19]],
  'Pentatónica': [[0,4,7,11],[5,9,12,16],[7,11,14,17],[9,12,16,19],[2,5,9,12],[0,4,7,11]],
  'Blues':       [[0,3,6,10],[3,6,9,13],[5,8,11,15],[6,9,12,16],[7,10,13,17],[0,3,7,10]]
};
```

- `generateChordFrequencies(rootIdx, scale)` → `rootFreq * 2^(semitone/12)`.
- Los primeros 3 intervalos son la triada y el cuarto es la séptima.
- Las triadas se escriben en SAB índices float32 11–28 (6×3); las séptimas
  en 192–197.
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
- El loop usa `requestVideoFrameCallback()` cuando está disponible y un
  fallback con `requestAnimationFrame`; no procesa dos veces el mismo
  `video.currentTime` ni permite inferencias concurrentes.
- `handsInstance.send({image: videoElement})` separa landmarks por
  `multiHandedness[i].label === 'Right'` y escribe los `x/y` en el SAB. El
  worker recibe solo `{type:'frame', slot, sequence}`.
- La cámara está limitada a 640×480 y 30 FPS. `?tracking=lite` fuerza el
  modelo Lite; dispositivos de bajo consumo lo seleccionan automáticamente.
- `cleanup()` libera cámara, worker, audio, MediaPipe y listeners gráficos.
- `window.gestureSynthPerformance()` expone un snapshot de diagnóstico con
  FPS, frames duplicados/saltados, p50/p95/p99 de inferencia/render, Long
  Tasks, GC disponible, latencias del AudioContext y duración del callback de
  AudioWorklet.

### 8.2 `public/tracking-worker.js` — gestos
- Classic worker. Lee la entrada de landmarks desde los slots del SAB y
  escribe TODO lo de la sección 4.2. No recibe arrays de objetos por mensaje.
- Histéresis por dedo (estados persistentes entre frames).
- `applyHysteresis(diff, state)`: si `diff > 0.02` → true; `< -0.02` → false.
- Pulgar: detección por distancias (tip→pinkyMCP vs IP→pinkyMCP), no por eje x.
- Pinch: normalizado por palmLen a 0–1 con rango [PINCH_MIN_NORM=0.15, PINCH_MAX_NORM=0.80].
- Pitch: ángulo del vector wrist→MCP(9) respecto a vertical, limitado a 45°.
- Rotación derecha/izquierda: escribe un ángulo firmado en el índice 34,
  invirtiendo X para coincidir con el vídeo espejado.
- fingerCount=0 (puño cerrado) → audio-engine mapea a chordIndex=5 (6º acorde).
- No importa nada (clamp01 y applyHysteresis son funciones locales).

### 8.3 `public/audio-engine.js` — AudioWorkletProcessor
- Registrado como `'gesture-synthesizer'`.
- **Prohibido asignar memoria dentro de `process()`** — todos los buffers,
  frecuencias y coeficientes persistentes se pre-alocan en el constructor.
  No se crean arrays por bloque/muestra.
- Guardas anti-denormal (`DENORMAL = 1e-18`) en feedback de filter y delay.
- Sintetiza los acordes con la **voz activa** (`this.voice`), seleccionada por
  `selectedPad` (SAB índice 30) entre 5 voces instanciadas UNA vez en el
  constructor: `this.voices = PAD_CLASSES.map(Cls => new Cls(sampleRate))`
  (`PAD_CLASSES` importado de `pad-registry.js` — módulo compartido con el
  main thread). En `process()` NO hay switch por pad — solo
  `voice.renderSample(renderFreqs, toneCount)` con un `Float32Array` reutilizable.
- Tercer grado ajustable mayor↔menor ANTES de renderizar:
  `third = chord[1] * 2^(-1/12)` si menor. En modo séptima se pasa además
  la cuarta frecuencia escrita en SAB 192–197; la interfaz de voz recibe un
  `Float32Array(4)` reutilizable y un `toneCount` de 3 o 4.
- Envolvente por voz: cada `SynthVoice` expone `attackTime`/`releaseTime`
  (defaults importados de `constants.js` — fuente única desde la ronda de
  limpieza). Los pasos se recalculan al cambiar de pad.
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
- Rotación derecha `> +0.35` conserva `majorMinorMix=1`; rotación izquierda
  `< -0.35` usa `toneCount=4` y publica `AUDIO_SEVENTH_ACTIVE=1`. La cuarta
  voz entra/sale con `seventhMix` suavizado. Ambos estados tienen retorno a
  0.25 rad para evitar parpadeo en el umbral.
- Durante el release se conserva la calidad activa hasta que la envolvente
  llega a cero, evitando que la séptima desaparezca a mitad de la cola.
- Efectos (switch por `selectedEffect`): 0 Reverb (tap multi-deley,
  decay 0.30–0.65), 1 Vibrato/Chorus (depth 2–8%, LFO con **acumulador de
  fase persistente**), 2 Bitcrusher (3–12 bits), 3 Filter (LP 1-polo con
  coeficiente correcto por sampleRate, cutoff **logarítmico 150–8000 Hz**),
  4 Delay (feedback max 0.3, lectura con **interpolación fraccional**),
  5 Tremolo (rate suavizado per-sample, LFO con **acumulador de fase
  persistente**).
- **LFO (Chorus/Tremolo)**: fase por acumulador incrementado por muestra;
  los pasos de fase y coeficientes constantes se preparan por bloque.
- Cuando no hay voz ni cola de delay/reverb, el worklet usa una ruta rápida de
  silencio y no ejecuta el grafo DSP.
- Salida: saturación suave ±0.95 + clip duro ±1.0.
- Volumen: recibe pinchDist ya normalizado por palmLen 0–1 del tracking-worker.
- Escribe osciloscopio: 25 muestras de `wetBuf` con step.

### 8.4 `public/graphic-engine.js` — Canvas2D overlay
- Render loop con `requestAnimationFrame`, limitado a 30 FPS efectivos para
  coincidir con el tracking. El callback está preasignado y `stop()` cancela
  su id. Cada render registra su duración en `PerformanceMonitor`.
- La cámara se muestra en un `<video>` espejado por el compositor; el canvas
  es transparente y no vuelve a copiar el frame de vídeo con `drawImage()`.
- Contexto 2D creado con `{ alpha: true, desynchronized: true }` como hint de
  baja latencia (el navegador puede ignorar la segunda opción).
- Landmarks: `x = (1.0 - sabX) * w` (inversión X por espejo), usando un
  `Float32Array(42)` reutilizable para no crear objetos por render.
- El tag de acorde añade `7` cuando `AUDIO_SEVENTH_ACTIVE` está publicado y
  lee los roles desde 459–464 (las séptimas ocupan 192–197).
- **Osciloscopio**: franja izquierda proporcional (`max(48, min(96, w*0.08))`);
  cada una de las 25 muestras se dibuja como una elipse "chata".
- **Círculo de pinch**: radio `pow(volume, 0.55) * maxR * 1.4` con
  `maxR = max(60, min(120, h*0.15))`.
- **Tag de acorde**: tooltip anclado a la muñeca derecha cuadro a cuadro,
  con opacidad controlada por el envelope de la voz activa.
- **Panel HUD top-right**: panel semitransparente con pad, efecto, volumen,
  FX Amount, FPS de render y FPS de cámara.
- `resize` usa un listener guardado y `destroy()` lo remueve para evitar
  fugas si se reinicia el pipeline.

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
- El `<video class="camera-feed">` está debajo del canvas transparente y se
  limita a la resolución/frame rate negociados por main.js.

### 8.7 `server.js` / `mime-types.js`
- Servidor estático con COOP/COEP/CORP (sección 2), streaming con
  `createReadStream()` y sin operaciones síncronas de filesystem por request.
- ETag/Last-Modified + `304` para código; assets vendorizados de MediaPipe
  usan caché inmutable.
- Brotli/gzip para HTML/JS/CSS/JSON/SVG.
- MIME types: `.js` → `application/javascript`, `.wasm` → `application/wasm`,
  `.tflite`/`.data`/`.bin` → `application/octet-stream`. Crítico para el
  AudioWorklet y la carga de MediaPipe.

### 8.8 `public/synths/` — librería de 5 pads + `pad-catalog.js`
- **`synth-voice.js`**: interfaz común `SynthVoice` (`constructor(sampleRate)`,
  `renderSample(freqs, toneCount, seventhMix)` → muestra en [-1,1], `noteOn()`).
  `freqs` tiene cuatro tonos, `toneCount` selecciona triada o séptima y
  `seventhMix` suaviza la entrada/salida de la cuarta voz. Expone además
  `attackTime`/`releaseTime` (defaults de `constants.js`) para la envolvente
  por voz. audio-engine maneja compartidos: envolvente, volumen, mix dry/wet
  y soft-clip — NO se duplican por synth.
- **`polyblep.js`**: `polyBLEP(t, dt)` — corrección band-limited step que se
  RESTA de la onda naive (anti-aliasing de sierra y pulso).
- Los 5 pads actuales (registry `PAD_CLASSES`; **el orden es sagrado**, ver
  gotcha sección 10):
  1. **Sine Pad** (`sine-pad.js`) — hasta 4 osciladores seno.
  2. **Saw Pad** (`saw-pad.js`) — sierra PolyBLEP (`2t-1 - polyBLEP`).
  3. **Square Pad** (`square-pad.js`) — pulso duty 50% con BLEP.
  4. **FM Bell** (`fm-bell-pad.js`) — FM de 2 operadores por tono, ratio 2.4
     e índice 3.5, con parciales inarmónicos de campana.
  5. **Wavetable** (`wavetable-pad.js`) — tabla de 2048 samples con armónicos
     1..8, pre-calculada en el constructor y leída con interpolación lineal;
     procesa la cuarta lectura solo en modo séptima.
- **`pad-registry.js`**: registro compartido `PAD_CLASSES` (las 5 clases, sin
  APIs de browser) — lo importa audio-engine.js para instanciar las voces y
  main.js para el preview de la intro.
- **`pad-catalog.js`**: SOLO metadata (`{id, name, description}`) sin lógica
  de audio — `PAD_CATALOG[i].id === i` DEBE coincidir con la posición en
  `PAD_CLASSES`.
- **Librería en la intro**: la selección se escribe al SAB índice 30
  (`CONFIG_SELECTED_PAD`) en `writeConfigToSAB()`. El HUD muestra pad y efecto.
- **Preview de sonido**: `playPadPreview` renderiza aproximadamente un segundo
  una sola vez por pad y cachea el `AudioBuffer`; `stopPreview()` libera el
  contexto y la caché al iniciar el pipeline principal.

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
13. El AudioWorklet no crea arrays u objetos en `process()`; los buffers,
    frecuencias y coeficientes se preparan fuera del loop de muestras.
14. La página oculta suspende audio, vídeo, tracking y gráficos; `destroy()`
    remueve listeners para que reiniciar no acumule recursos.
15. La rotación derecha/izquierda usa un único ángulo firmado: derecha conserva
    la menor y izquierda activa la séptima. No se agregan gestos paralelos ni
    se cambia el mapeo de dedos/acordes.

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
- **`id` de `PAD_CATALOG` ↔ posición en `PAD_CLASSES`**: el orden de las 5
  clases actuales en el registry de audio-engine.js ES el contrato. El `id`
  de cada entrada del catálogo debe coincidir exactamente (0-4 en orden).
  Editar un lado sin el otro desincroniza la UI de la intro con el motor de
  audio — mismo tipo de invariante manual que ya causó bugs con los índices
  del SAB.
- **`selectedPad` comparte bytes con `float32View[30]`** (vistas int32/float32
  del mismo SAB): escribir el pad como int32 y nunca leerlo como float.
- Las frecuencias de séptima ocupan `float32View[192..197]`; no volver a usar
  esa zona para roles. Los roles están en `int32View[459..464]` y el flag HUD
  en `int32View[465]`.

---

## 11. Estado y verificación

### Verificado (nivel código, sin cámara)

- `npm test` pasa `test/performance-smoke.mjs`: AudioWorklet en silencio y con
  acorde, worker leyendo slots SAB y publicación de flags/landmarks, además
  de invariantes estáticos de zero-allocation y servidor.
- Todos los archivos pasan `node --check`.
- El servidor arranca, conserva COOP/COEP/CORP, entrega `Content-Length` para
  binarios, `Content-Encoding: br` para JS, y responde `304` con ETag.
- El audio mantiene buffers/frecuencias/coeficientes preasignados, bypass de
  efectos con `mix` bajo y ruta rápida cuando no hay voz ni cola.
- El tracking ya no clona arrays de landmarks: los datos viajan por tres
  slots del SAB y el worker descarta tokens obsoletos.

### Diagnóstico de performance (Fase 3)

Después de iniciar una sesión, abrir la consola del navegador y ejecutar:

```js
const metrics = gestureSynthPerformance();
console.table(metrics);
```

El snapshot incluye `renderFps`, `cameraFps`, frames duplicados/saltados,
`inferenceMs.p50/p95/p99`, `renderMs.p50/p95/p99`, Long Tasks, eventos GC si el
navegador los expone, `baseLatency`/`outputLatency` y el tiempo muestreado del
callback de AudioWorklet. Para una sesión nueva:

```js
gestureSynthPerformance.reset();
```

Se recomienda registrar una sesión de 60 segundos, en caché fría y caliente,
y guardar el objeto JSON resultante. Los objetivos iniciales son render estable
a 30 FPS, al menos 25 FPS efectivos de cámara, p95 de inferencia menor a 25 ms
y cero asignaciones por bloque de audio en producción.

### Pendiente de prueba manual (requiere cámara)

Checklist final, con todos los fixes de rondas anteriores ya aplicados:

- [ ] 0–5 dedos → 6 acordes (incluye puño cerrado → acorde 5).
- [ ] Mayor/menor con giro derecho de palma (índice 34 > +0.35 rad).
- [ ] Séptima con giro izquierdo de palma (índice 34 < -0.35 rad), incluida
      la transición y el release sin clicks; el HUD debe mostrar `7`.
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
- [ ] Los 5 pads individualmente (Sine, Saw, Square, FM Bell, Wavetable) —
      timbres claramente distintos, sin clicks ni aliasing áspero.
- [ ] Hot-swap de pad con nota sostenida — cambio sin click ni
      discontinuidad audible (re-trigger rápido de 8 ms).

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
