// pad-catalog.js — SOLO metadata de los 5 pads, sin lógica de audio.
// Importado por main.js (UI de la intro) y referenciado por el registry de
// audio-engine.js (PAD_CLASSES). Invariante crítica (contract.md sección 10):
// el `id` de cada entrada DEBE coincidir con su posición en PAD_CLASSES.
export const PAD_CATALOG = [
  { id: 0, name: 'Sine Pad',   description: 'Cálido y redondo, el clásico' },
  { id: 1, name: 'Saw Pad',    description: 'Brillante, rico en armónicos' },
  { id: 2, name: 'Square Pad', description: 'Hueco, tipo chiptune suave' },
  { id: 3, name: 'FM Bell',    description: 'Metálico, campana' },
  { id: 4, name: 'Wavetable',  description: 'Denso, tipo supersaw suave' }
];
