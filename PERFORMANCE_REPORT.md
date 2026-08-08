# Informe de performance — Gesture Synthesizer

**Fecha:** 2026-08-08  
**Alcance:** análisis estático del cliente, AudioWorklet, worker de tracking y servidor estático.  
**Estado:** no se modificó el runtime; este documento contiene hallazgos y una propuesta de roadmap.

## Resumen ejecutivo

La arquitectura parte de buenas decisiones para tiempo real: `AudioWorklet`, `SharedArrayBuffer`, un worker para el cálculo de gestos y buffers DSP persistentes. Sin embargo, hay tres riesgos claros antes de buscar optimizaciones DSP más sofisticadas:

1. **El AudioWorklet sí asigna memoria durante `process()`**, a pesar de que el código indica lo contrario. Hay arrays por bloque y, mientras suena una nota, un array por muestra. Esto puede provocar presión de GC y glitches de audio.
2. **El hilo principal hace demasiadas tareas a la vez:** inferencia MediaPipe, serialización de landmarks y composición de un canvas fullscreen a cada `requestAnimationFrame`. En equipos modestos esto puede bajar FPS y aumentar la latencia del gesto.
3. **La carga inicial de MediaPipe es grande y el servidor desactiva una caché eficiente:** con el modelo full y WASM SIMD, los artefactos de MediaPipe suman aproximadamente **16.2 MiB sin compresión**; todas las respuestas llevan `Cache-Control: no-cache`, sin `ETag` ni `Last-Modified` explícitos.

## Metodología y limitaciones

Se revisaron los archivos fuente, el grafo de imports y los tamaños de los assets. También se validó localmente que:

- `node --check` pasa para el servidor, los módulos del cliente y los synths.
- El servidor arranca y entrega COOP/COEP/CORP y los MIME types esperados.
- Los tamaños de assets fueron calculados con los archivos presentes en `public/lib/mediapipe`.

No hay un navegador automatizado ni una cámara disponible en este entorno, por lo que **no se reportan FPS, CPU, memoria o latencia medidos en ejecución**. Las prioridades de abajo son riesgos derivados del código y deben confirmarse con Chrome DevTools/Performance y una prueba con cámara real.

---

## Hallazgos priorizados

### P0 — Asignaciones dentro del AudioWorklet

**Evidencia:** `public/audio-engine.js:68-77`, `:100`, `:180-183`.

- `readChords()` crea un array exterior y seis arrays interiores en cada llamada a `process()`.
- A 48 kHz con bloques de 128 muestras son aproximadamente **375 llamadas por segundo**, es decir, unas **2.625 arrays/segundo** solo para leer los acordes.
- Mientras la envolvente está activa, `const freqs = [chord[0], third, chord[2]]` crea aproximadamente **48.000 arrays/segundo**.
- Esto contradice el comentario `// Pre-allocated buffers (no alloc in process!)` de `:36`.

**Impacto:** presión de garbage collector en el hilo de audio, jitter del callback y posibles clicks/dropouts, especialmente en móviles o al usar FM/efectos.

**Recomendación:**

- Mantener una `Float32Array(18)` para los acordes y copiar/leer los valores por índice, o conservar solo los tres escalares necesarios del acorde activo.
- Mantener una `Float32Array(3)` reutilizable para `renderSample()`; mejor aún, cambiar la interfaz a `renderSample(f0, f1, f2)` para evitar el array por muestra.
- Calcular `third` una vez por bloque, ya que `majorMinorMix` se lee una vez antes del loop de muestras.
- Añadir un test o lint que prohíba `[]`, `{}` y métodos que creen colecciones dentro de `process()` y sus helpers.

### P1 — Se ejecuta el efecto completo aunque no haya audio útil

**Evidencia:** `public/audio-engine.js:191-203`.

El loop de efectos corre en cada bloque incluso cuando no hay mano derecha, la envolvente está en `OFF` o el `mix` está prácticamente en cero. En ese estado se siguen ejecutando, según el efecto seleccionado, `Math.pow`, `Math.exp`, `Math.sin`, accesos circulares a buffers y escrituras de delay/reverb sobre muestras `DENORMAL`.

**Impacto:** consumo de CPU y batería constante en silencio; puede restar presupuesto al tracking y al render sin aportar salida audible.

**Recomendación:** introducir una ruta rápida:

- Si no hay nota ni cola activa y el estado de efectos está silencioso, rellenar la salida con cero y actualizar solo el estado mínimo.
- Si `mix < epsilon`, evitar calcular el efecto, salvo que se quiera conservar explícitamente una cola audible.
- Mantener un indicador de actividad de colas para delay/reverb/filter y apagar el procesamiento cuando su energía caiga por debajo de un umbral.
- Validar que el bypass no cambie el comportamiento al reactivar una nota.

### P1 — Inferencia, clonación de datos y composición gráfica compiten en el main thread

**Evidencia:** `public/main.js:299-315` y `public/graphic-engine.js:95-145`.

En el mismo hilo se hace `handsInstance.send()`, se procesan los resultados, se envían landmarks por `postMessage` y se dibuja la cámara a pantalla completa. `drawCameraFeed()` escala y copia el vídeo entero al canvas en cada `requestAnimationFrame`, aunque la inferencia está limitada a 30 FPS.

**Impacto:** en pantallas grandes o dispositivos con GPU/CPU limitada, el coste de `drawImage()` fullscreen + overlays puede generar frames perdidos y hacer que el control gestual se sienta tardío.

**Recomendación:**

- Separar el vídeo del overlay: usar el `<video>` como fondo espejado (`object-fit: cover` + `transform: scaleX(-1)`) y dejar un canvas transparente solo para landmarks/HUD.
- Alternativamente, limitar el canvas a una resolución máxima de composición y escalarlo por CSS; si se busca nitidez con DPR, capar `devicePixelRatio` (por ejemplo, 1.5–2) para no multiplicar el coste.
- No redibujar a 60/120 FPS si no llega un frame de cámara nuevo. Preferir `HTMLVideoElement.requestVideoFrameCallback()` o una política explícita de 30/60 FPS.
- Medir por separado el tiempo de `hands.send()`, `render()` y el número de frames saltados.

### P1 — `postMessage` clona objetos de landmarks en cada frame

**Evidencia:** `public/main.js:307-314` y `public/tracking-worker.js:35-39`.

MediaPipe entrega arrays de objetos `{x, y, ...}` y el código los manda directamente al worker. Hasta dos manos implican hasta 42 objetos de landmark por frame, con serialización y structured clone a unos 30 FPS. El worker termina escribiendo esos mismos datos en el SAB.

**Impacto:** asignaciones y copias innecesarias, más GC y mayor latencia entre la inferencia y el gesto que consume el audio.

**Recomendación, en orden de preferencia:**

1. Reservar en el SAB una zona de entrada de landmarks y escribir allí los `x/y` desde el main thread; mandar al worker solo un número de secuencia o un mensaje pequeño para indicar que hay frame nuevo.
2. Usar buffers `Float32Array` reutilizables con un pool y transferirlos, si se decide no ampliar el protocolo del SAB.
3. Implementar política *latest frame wins*: si el worker está ocupado, descartar el frame anterior en vez de acumular una cola de mensajes.

La opción 1 es consistente con la regla del proyecto de que el SAB sea el canal de datos entre hilos. Para evitar lecturas parciales, usar doble buffer o un contador de secuencia publicado al final con `Atomics`.

### P1 — Carga inicial y caché de MediaPipe

**Evidencia:** `public/main.js:266-272`, `public/lib/mediapipe/hands.js` y `server.js:40-46`.

La app fuerza `modelComplexity: 1`, que selecciona `hand_landmark_full.tflite`. En un navegador moderno que use WASM SIMD, el conjunto solicitado ronda:

| Asset | Tamaño aproximado |
|---|---:|
| `hands_solution_simd_wasm_bin.wasm` | 5.75 MiB |
| `hand_landmark_full.tflite` | 5.22 MiB |
| `hands_solution_packed_assets.data` | 4.13 MiB |
| JS/loader/graph restantes | 0.35 MiB |
| **Total aproximado** | **16.2 MiB** |

El modelo lite de 1.98 MiB no se usa con la configuración actual, aunque se entrega en el directorio. El servidor envía `Cache-Control: no-cache` a todos los archivos estáticos, pero no genera `ETag`/`Last-Modified` ni `max-age`/`immutable`.

**Impacto:** cold start lento, consumo de datos repetido al recargar y peor experiencia en redes móviles. El tiempo de descarga no es el único coste: también hay parseo, compilación de WASM y carga del modelo.

**Recomendación:**

- Usar nombres versionados/hash para assets y `Cache-Control: public, max-age=31536000, immutable`.
- Mantener `index.html` con caché corta, pero cachear de forma agresiva JS, WASM, TFLite y `.data` inmutables.
- Añadir `ETag`/`Last-Modified` como mínimo si se mantiene `no-cache` durante desarrollo.
- Servir JS/HTML con Brotli o gzip; medir si comprimir `.wasm`/`.data` reduce el tiempo total sin penalizar el arranque.
- Ofrecer un perfil Lite (`modelComplexity: 0`) para móviles o equipos con presupuesto limitado, idealmente elegido por una opción de calidad/adaptación y no solo por user-agent.
- Evitar desplegar en `public` archivos que no usa la app (`camera_utils.js`, documentación, tipos y el modelo alternativo si no se habilita la opción). No elimina el coste de runtime si el navegador no los pide, pero reduce tamaño de artefacto y superficie de despliegue.

### P1 — Restricciones de cámara demasiado permisivas y scheduling no ligado al vídeo

**Evidencia:** `public/main.js:168-170`, `:294-305`.

`width` y `height` son solo `ideal`; no hay límite de `frameRate`. El dispositivo puede entregar una resolución/frame rate superiores al presupuesto que el pipeline espera. Además, el loop temporizado con `requestAnimationFrame` puede procesar el mismo frame de vídeo más de una vez si la cámara entrega menos de 30 FPS, o trabajar con una cola/latencia poco controlada si `hands.send()` tarda más de lo previsto.

**Impacto:** trabajo de captura e inferencia innecesario y variabilidad de latencia entre dispositivos.

**Recomendación:**

- Solicitar `width/height` con límites (`max` o una configuración negociada) y `frameRate: { ideal: 30, max: 30 }`.
- Leer `videoTrack.getSettings()` y mostrar/registrar la resolución real.
- Usar `requestVideoFrameCallback()` o comparar `video.currentTime` para no inferir dos veces el mismo frame.
- Mantener una sola inferencia en vuelo y aplicar *latest frame wins*.
- Si la inferencia excede el presupuesto, degradar progresivamente: primero Lite, después 20/15 FPS, y solo al final reducir resolución.

### P2 — Coste y asignaciones del Canvas2D por frame

**Evidencia:** `public/graphic-engine.js:163-188`, `:198-226`, `:316-355`.

- El osciloscopio abre y rellena 25 paths por frame.
- `drawHandLandmarks()` crea un array y 21 objetos `{x, y}` por mano en cada render. Con dos manos y 60 FPS son hasta 2.520 objetos de puntos por segundo, además de arrays y strings del HUD.
- Se recalculan tipografías, `measureText`, valores formateados y paths aunque la geometría estática no cambie.
- Se ejecutan varios `save()/restore()` y `beginPath()` por frame.

**Impacto:** GC y coste de Canvas que se suman al trabajo de MediaPipe en el mismo hilo.

**Recomendación:**

- Usar dos `Float32Array(42)` preasignados o dibujar directamente desde el SAB sin crear objetos.
- Cachear fuentes, etiquetas y anchos de texto; regenerar el fondo/HUD estático solo cuando cambie tamaño, pad o efecto.
- Considerar `Path2D` para conexiones fijas si el coste medido lo justifica, o un overlay WebGL/OffscreenCanvas en dispositivos de gama baja.
- Crear el contexto con opciones como `{ alpha: false, desynchronized: true }` solo tras medir compatibilidad/beneficio.
- Reducir el número de elementos visuales en modo bajo consumo.

### P2 — Coste DSP que puede salir del loop por muestra

**Evidencia:** `public/audio-engine.js:239-309`.

Hay operaciones cuyo parámetro permanece constante durante todo el bloque, pero se recalculan por muestra:

- Reverb: `Math.pow(decay, t + 1)` para cada tap y muestra.
- Filter: `Math.pow()` y `Math.exp()` por muestra aunque `param` se actualiza una vez por bloque.
- Bitcrusher: `Math.pow(2, bits)` por muestra.
- Parte de los cálculos constantes de chorus/tremolo también puede salir del loop; la fase y el seno deben seguir siendo por muestra.

**Recomendación:** calcular coeficientes/potencias una vez por bloque y usar multiplicaciones acumuladas o tablas pequeñas. Mantener por muestra únicamente lo que necesita continuidad temporal: fase, lectura de delay, estado del filtro y feedback.

Esta mejora debe hacerse después de eliminar las asignaciones, porque un profiling de AudioWorklet con GC activo puede ocultar el coste real del DSP.

### P2 — Pausa/visibilidad y liberación de recursos incompletas

**Evidencia:** `public/main.js:332-340` y `public/graphic-engine.js:62-63`.

- No hay listener de `visibilitychange`. En una pestaña oculta el `requestAnimationFrame` puede ralentizarse, pero el `AudioContext`/AudioWorklet puede seguir consumiendo CPU y la última mano puede quedar sostenida en el SAB.
- `cleanup()` pone `handsInstance = null`, pero no llama a `handsInstance.close()`, aunque la librería expone ciclo de vida propio.
- `GraphicEngine` añade un listener anónimo de `resize` que `stop()` nunca elimina. Si en el futuro se permite iniciar/detener varias veces, se acumulan listeners y referencias.

**Impacto:** batería consumida en segundo plano y fugas/duplicación de trabajo después de reintentos o navegación interna.

**Recomendación:**

- En `visibilitychange`, suspender audio, detener o pausar inferencia/cámara y reanudar de forma explícita; al pausar, escribir flags de manos a cero o disparar release.
- Llamar `handsInstance.close()` durante cleanup y esperar su promesa si corresponde.
- Guardar la función de `resize` en una propiedad y removerla en `stop()`/`destroy()`.
- Añadir una prueba de 10 ciclos start/stop comprobando listeners, streams, workers, AudioContexts y memoria retenida.

### P3 — Preview de pads: trabajo síncrono al pasar el ratón

**Evidencia:** `public/main.js:88-118`, activado en `:121-125`.

Cada `mouseenter` sintetiza de forma síncrona un segundo completo de audio (`48.000` muestras), crea un `AudioBuffer` y un `AudioBufferSourceNode`. Pasar rápido por varios pads puede bloquear brevemente el hilo de UI y producir buffers que quedan a la espera de GC.

**Recomendación:** precalcular y cachear un preview por pad al primer uso, usar `OfflineAudioContext`/worker cuando sea viable, y aplicar debounce o cancelar la generación si llega otro hover. El preview ocurre antes del pipeline principal, así que es menor prioridad que los puntos anteriores.

---

## Inconsistencia que conviene corregir antes de benchmarkear

`contract.md` y `CHANGELOG.md` describen seis pads e incluso un `Pluck`, pero el estado actual contiene cinco entradas en `public/pad-catalog.js`, cinco clases en `public/pad-registry.js` y no hay `pluck-pad.js`. Además, varios comentarios de `audio-engine.js` hablan de seis voces.

No es por sí mismo un problema de FPS, pero puede invalidar benchmarks, tests y expectativas de memoria. Conviene decidir si el producto tiene cinco o seis pads y actualizar código/documentación antes de comparar resultados.

---

## Qué conservar

- `AudioWorklet` mantiene el render de audio fuera del main thread.
- El SAB evita enviar estado de audio por `postMessage` y permite compartir el estado de control.
- Delay/reverb tienen buffers persistentes y los LFO mantienen fase entre bloques.
- El worker separa el cálculo de gestos del render de audio.
- Los assets de MediaPipe se sirven localmente, lo que evita una dependencia de red de terceros durante la ejecución y ayuda a cumplir COEP.

La principal deuda es que el protocolo todavía copia landmarks por mensajes y el AudioWorklet no cumple completamente la promesa de zero-allocation.

---

## Roadmap recomendado

### Fase 1 — bajo riesgo / alto retorno

1. Eliminar arrays de `process()` y precomputar `third`, coeficientes de filtro, niveles de bitcrush y pesos de reverb por bloque.
2. Añadir fast path de silencio/bypass de efectos.
3. Fijar el presupuesto de cámara a 640×480 y 30 FPS, y evitar duplicados con `requestVideoFrameCallback`.
4. Configurar caché versionada y compresión para assets estáticos.
5. Añadir `visibilitychange` y cleanup completo.

### Fase 2 — quitar presión del main thread

1. Separar `<video>` y canvas de overlays.
2. Eliminar objetos temporales de `drawHandLandmarks()` y cachear HUD/texto.
3. Pasar landmarks mediante SAB con doble buffer/secuencia y política latest-frame.
4. Ofrecer modo de calidad Lite/adaptativo.

### Fase 3 — medición y validación

Registrar durante una sesión de 60 segundos:

- FPS de render, FPS de cámara, FPS efectivo de MediaPipe y frames duplicados/saltados.
- p50/p95/p99 de `hands.send()` y de `GraphicEngine.render()`.
- long tasks del main thread y pausas de GC.
- `baseLatency`, `outputLatency` y tiempo de callback del AudioWorklet.
- memoria usada después de 10 ciclos de preview y start/stop.
- consumo de red y tiempo hasta `hands.initialize()` en caché fría/caliente.

Criterios iniciales sugeridos: render estable a 30 FPS en modo normal, al menos 25 FPS efectivos de cámara, p95 de inferencia por debajo de 25 ms con el perfil seleccionado y cero asignaciones por bloque de audio en un perfil de producción.

## Veredicto

Antes de optimizar la calidad visual o añadir más pads/efectos, atacaría **las asignaciones del AudioWorklet**, **la copia de landmarks**, **la composición fullscreen del canvas** y **la entrega/caché de MediaPipe**. Son los puntos con mayor probabilidad de producir síntomas visibles: clicks de audio, gestos con retraso, FPS inestables y arranque lento. El resto debe priorizarse con mediciones reales para no sacrificar calidad por una mejora teórica.
