// pad-registry.js — registro compartido de las 5 voces (contract.md §8.8).
// Importado por audio-engine.js (instancia las voces en el constructor del
// worklet) y por main.js (preview de sonido en la intro). Puro: no usa APIs
// de browser, solo clases — importable desde el main thread.
// Invariante crítica (contract.md §10): la posición DEBE coincidir con el
// `id` de PAD_CATALOG en pad-catalog.js.
import { SinePad } from './synths/sine-pad.js';
import { SawPad } from './synths/saw-pad.js';
import { SquarePad } from './synths/square-pad.js';
import { FmBellPad } from './synths/fm-bell-pad.js';
import { WavetablePad } from './synths/wavetable-pad.js';

export const PAD_CLASSES = [SinePad, SawPad, SquarePad, FmBellPad, WavetablePad];
