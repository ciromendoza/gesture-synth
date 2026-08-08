# Changelog

Historial de bugs y limpieza de deuda técnica del Gesture Synthesizer.
La sección 11 de `contract.md` describe el estado actual; este archivo
conserva la trazabilidad de las correcciones.

## Ronda 8 — Fix chord roles desync + UI cleanup (2026-08-08)

Corrige el bug de `CHORD_ROLES` hardcodeado que se desincronizó de `SCALES`
y limpia el tag de acorde con fade-out y eliminación del debug tag.

- **`constants.js`**: `CHORD_ROLES` eliminado (array duplicado de SCALES,
  causaba roles erróneos). Reemplazado por `ROLE_ENUM` (vocabulario fijo de
  grados musicales: Tónica→Sexta). Nuevo index `RESERVED_CHORD_ROLES: 192`
  en zona Reservada del SAB.
- **`main.js`**: `DEGREE_NAMES` map (semitone→degree name) derive from
  `SCALES` intervals. `rolesForScale()` genera roles por cada acorde de la
  escala activa. Roles escritos como índices al `int32View[192..197]` en
  `writeConfigToSAB()`.
- **`graphic-engine.js`**: `drawLeftHandTag()` eliminada (debug tag con
  valores crudos duplicados — pinch % en círculo + barra "Volumen" ya están
  en el HUD). `drawChordTag()` reescrita con fade-out por envelope:
  `_lastChordIndex` se preserva durante release tail, `globalAlpha` se
  controla con `Math.min(1, envelope)` para desvanecer el tag gradualmente.
  El tag se dibuja siempre que `envelope > 0`, sin depender de `rightDetected`.
  Importa `ROLE_ENUM` de constants.
- Verificación: `tmp/chord-roles-test.js` — 45 asserts PASS (36 combinaciones
  de roles × 6 escalas + 9 checks de integridad de archivos).
- Contract: §4.1 (zona Reservada 192–197), §8.4 (fade tag por envelope,
  sin `drawLeftHandTag`), §8.5 (`ROLE_ENUM` reemplaza `CHORD_ROLES`).

## Ronda 7b — Preview de sonido en la intro (2026-08-08)

Nice-to-have de la ronda de pads, ahora implementado — sin drift entre lo
que se escucha en la intro y lo que suena al iniciar.

- **`pad-registry.js`**: `PAD_CLASSES` movido de audio-engine.js a un módulo
  compartido (solo clases, sin APIs de browser) — lo importan el worklet
  (instancia las voces) y main.js (preview). El invariante de orden con
  `PAD_CATALOG` se mantiene (contract §10).
- **`playPadPreview()`** en main.js: hover (`mouseenter`) o click sobre un
  pad de la intro → renderiza ~1 s de la tríada C4 con la MISMA clase del
  registry en un `AudioBuffer` (ganancia 0.5, fade-in según el ataque propio
  de la voz — Pluck 4 ms, sostenidos ≤ 50 ms — + fade-out 150 ms) y lo
  reproduce con `AudioBufferSourceNode`.
- **Política de activación**: el primer click reanuda el AudioContext (hover
  solo suena después de una activación de usuario — restricción del browser).
- **Fix race**: `onended` del nodo anterior ya no puede anular la referencia
  del nodo actual (guard `previewNode === src`) — no se solapan previews.
- **`stopPreview()`** al pulsar Iniciar: cierra el contexto de preview para
  que no se solape con el AudioContext del app principal.
- Verificación: `tmp/preview-test.js` (réplica exacta del render) — 6 pads
  con buffer acotado, con energía y sin clicks al inicio/fin.
- Contract: §8.3 (registry compartido), §8.8 (pad-registry + preview),
  §11 (tests), §12 (roadmap sin el ítem de preview).

## Ronda 7 — Sistema modular de 6 synth pads (2026-08-08)

Sustituye los 3 osciladores seno hardcodeados de `process()` por una
librería de 6 timbres seleccionables, sin caer en un pastiche.

- **Interfaz `SynthVoice`** (`public/synths/synth-voice.js`):
  `constructor(sampleRate)` / `renderSample(freqs)` / `noteOn()`, más
  `attackTime`/`releaseTime` por voz (defaults de `constants.js`, fuente
  única). La envolvente, el suavizado de parámetros, el mix dry/wet y el
  soft-clip siguen siendo compartidos por audio-engine.js — no se duplican.
- **6 pads en `public/synths/`** (registry + factory, sin switch por caso):
  Sine (el original migrado, idéntico), Saw y Square (con **PolyBLEP**,
  anti-aliasing — una sierra naive saltaba 2.0 por muestra; con BLEP la
  transición se reparte en ~2 muestras, verificado), FM Bell (2 operadores,
  ratio 2.4, índice 3.5), Wavetable (tabla de 2048 con armónicos 1..8
  pre-calculada en el constructor, lectura interpolada), Pluck
  (Karplus-Strong: delay-lines pre-alocadas para ~20 Hz, ruido en
  `noteOn()`, lectura fraccional para pitch exacto, decay 0.9997).
- **`pad-catalog.js`**: metadata pura (id/name/description) importable desde
  el main thread — la UI de la intro y el registry de audio nunca se
  desincronizan. Invariante documentada: `id` == posición en `PAD_CLASSES`.
- **`selectedPad` en SAB índice 30** (`CONFIG_SELECTED_PAD`): mismo patrón
  que `selectedEffect` — lo escribe main.js, lo lee el worklet.
- **Hot-swap sin click**: cambio de pad con nota sostenida → `QUICK_RELEASE`
  de 8 ms + re-trigger con el ATTACK de la voz nueva (no el ADSR completo
  80/150 ms). Sin nota, el switch es directo.
- **Envolvente por voz**: solo Pluck es percusivo (`attackTime` 2 ms — el
  ADSR global de 80 ms aplastaría el ataque de la cuerda); las demás usan el
  default. No se asume "una talla sirve para todos".
- **Intro + HUD**: sección "Librería de pads" con el patrón UI existente
  (`.sel-btn`); el panel HUD ahora muestra "Pad: {nombre}" sobre
  "Efecto: {nombre}" (título de 2 líneas, `titleH` 26→44).
- **Verificación**: test de render en Node (`tmp/synth-render-test.js`) —
  36 asserts PASS: interfaz, salida acotada, energía, pitch 440 Hz por
  autocorrelación (los cruces por cero mienten en ondas ricas: FM/Pluck),
  anti-aliasing (maxDiff < 1.5), decay natural del Pluck (Karplus-Strong
  decae por PERIODO, ~0.5 s de cola es lo correcto). `node --check` +
  imports ES + MIME del servidor verificados.
- Contract: 4.2 (índice 30), 8.3 (registry), 8.8 (nueva: synths + catálogo +
  librería), 9 (decisiones 12-13), 10 (gotcha id↔PAD_CLASSES), 11 (tests),
  12 (roadmap: preview de sonido).

## Ronda 6 — Ajustes HUD (2026-08-07)

- **Fix overlap**: el título "Efecto seleccionado:" se pisaba con el label
  "VOLUMEN" de la barra 1 (baselines a 2px). `titleH` subió de 18 a 26.
- **FPS renderizado**: etiqueta explícita (era solo "FPS n").
- **FPS cámara**: nuevo contador debajo — `main.js` mide los
  `handsInstance.send()` efectivos por segundo y lo pasa al GraphicEngine
  vía `setCameraFps()`.

## Ronda 5 — Rediseño estético de la UI (2026-08-07)

100% visual: solo `graphic-engine.js` (y `main.js` sin cambios necesarios).
Lógica de gestos, audio y layout del SAB intactos.

- **Tipografía**: stack sans-serif tipo Apple (`-apple-system, BlinkMacSystemFont,
  "SF Pro Display", "Helvetica Neue", Arial`), pesos livianos 300–400,
  `ctx.letterSpacing` con fallback silencioso.
- **Círculo de pinch**: gradiente radial — centro se vacía al crecer el
  volumen (`centerAlpha = max(0, 0.9 - volume*0.8)`), borde siempre definido.
  Sensación de anillo expansivo, no disco sólido.
- **Osciloscopio**: de polilínea a 25 elipses "chatas" independientes
  (ecualizador de puntos), tamaño/opacidad siguen la amplitud de cada muestra.
- **Panel HUD top-right**: barras de pinch/rotación dentro de un panel
  semitransparente con borde fino (antes barras sueltas).
- **Tag de acorde**: tooltip anclado a la muñeca derecha cuadro a cuadro
  (antes etiqueta fija arriba); no se dibuja si la mano no está detectada.
- **Responsive**: offsets fijos → proporcionales al canvas (franja del
  osciloscopio `w*0.08`, panel `w*0.2`, radio del círculo `h*0.15`).
  `resizeCanvas()` ya mantenía sincronizados los índices 2–3 del SAB.
- Contract: sección 8.4 reescrita con la nueva descripción visual + nota de resize.

## Ronda 4 — Limpieza final (2026-08-07)

Sin bugs de código: cierre de verificación + deuda técnica.

- **Verificación empírica del Delay**: test de impulso unitario en Node
  (réplica exacta de `fxDelay()`) confirma la interpolación fraccional —
  frac=0.5 reparte 0.5/0.5 entre las dos muestras enteras; frac=0 da muestra
  completa única; frac=0.25 reparte energía 0.75/0.25 en la dirección correcta.
- **Deuda**: `ATTACK_TIME`/`RELEASE_TIME` unificados — `constants.js` es la
  fuente única (0.08/0.15) y `audio-engine.js` los importa.
- **Deuda**: eliminados `pinchExtended` y `PINCH_OPEN`/`PINCH_CLOSE` muertos
  de `tracking-worker.js` (la histéresis del pinch no tiene caso de uso
  planeado; el volumen es clamp continuo normalizado por palmLen).
- **Deuda**: eliminados `CHORDS` (frecuencias fijas obsoletas) y `OFFSETS`
  (offsets en bytes no usados) de `constants.js`.
- Contract: sección 11 reescrita como estado final limpio + checklist manual
  pendiente (requiere cámara).

## Ronda 3 — Bugs DSP (antes de la limpieza)

- **BUG A — Chorus/Tremolo**: LFO con salto de fase al cambiar `rate`
  (derivado de `sampleIndex·rate`). Fix: acumulador de fase persistente
  incrementado por muestra (`phase += 2π·rate/sampleRate`).
- **BUG B — Delay**: zipper noise al barrer el delay time. Fix: interpolación
  fraccional lineal entre las dos muestras enteras más cercanas.
- **BUG C — Filter**: comportamiento de interruptor (coeficiente arbitrario).
  Fix: one-pole correcto `exp(-2π·f/sampleRate)` + cutoff logarítmico
  150–8000 Hz.
- `contract.md`: secciones 8.3, 10 y 11 actualizadas con criterios de
  aceptación por bug.

## Ronda 2 — Bugs funcionales (gestos + efectos)

- **BUG 5 — 4 efectos inaudibles** (Reverb/Chorus/Bitcrusher/Filter):
  eran matemáticamente demasiado sutiles, no regresiones. Parámetros
  reajustados para audibilidad: Reverb decay 0.30–0.65 (sin ×0.8 en salida),
  Chorus depth 2–8%, Bitcrusher 3–12 bits, Filter cutoff por sampleRate.
- **BUG 6 — Delay/Tremolo crackling**: parámetros suavizados per-sample.
- **BUG 7 — Pinch normalizado por palmLen**: invariancia a distancia a cámara
  y tamaño de mano. Rango [PINCH_MIN_NORM=0.15, PINCH_MAX_NORM=0.80].
- **BUG 8 — 6º acorde para fingerCount=0** (puño cerrado): SCALES extendido
  a 6 acordes, rootNote reubicado a índice 29, CHORD_NAMES/ROLES a 6 entradas.

## Ronda 1 — Bugs funcionales (tracking)

- **BUG 1 — Detección de pulgar invertida**: comparación por eje x sensible a
  rotación. Fix: comparación de distancias (tip(4)→pinkyMCP(17) vs
  IP(3)→pinkyMCP(17)).
- **BUG 2 — Pinch nunca llega a 0%**: rango de mapeo PINCH_MIN/PINCH_MAX.
- **BUG 3 — Pitch media dedos en vez de muñeca**: ángulo wrist→MCP(9),
  límite 45°.
- **BUG 4 — DSP crackling**: guards anti-denormal, ganancia de reverb,
  salida de delay.
