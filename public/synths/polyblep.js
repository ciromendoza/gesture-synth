// PolyBLEP — band-limited step correction para sintetizadores naive.
// Evita el aliasing áspero de diente de sierra y pulso generados crudos.
// t: fase normalizada en [0, 1); dt: incremento de fase (freq / sampleRate).
// Devuelve la corrección que RESTAR de una sierra naive (2t - 1).
export function polyBLEP(t, dt) {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1.0;
  } else if (t > 1.0 - dt) {
    const x = (t - 1.0) / dt;
    return x * x + x + x + 1.0;
  }
  return 0.0;
}
