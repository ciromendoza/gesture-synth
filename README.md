# Gesture Synthesizer

Real-time synthesizer controlled entirely by your hands. Use your webcam to play chords, control volume, and shape sound with gestures.

## How it works

- **Right hand** — select chords by extending fingers (1–5 fingers = 6 chords; fist = bonus chord). Tilt your palm to switch between major and minor.
- **Left hand** — pinch thumb and index finger to control volume. Tilt your wrist to apply effects (reverb, chorus, bitcrush, filter, delay, tremolo).
- **6 synth pads** — Sine, Saw, Square, FM Bell, Wavetable, and Pluck (Karplus-Strong). Choose before starting; each has a unique character.

The app shows a mirrored camera feed with real-time visualization: oscilloscope, pinch circle, chord labels, and a data panel.

## Requirements

- [Node.js](https://nodejs.org/) (v18+)
- A webcam
- Chrome or Edge (SharedArrayBuffer support required)

## Run locally

```bash
git clone https://github.com/your-username/gesture-synth.git
cd gesture-synth
npm install
npm start
```

Open **http://localhost:3000** in Chrome or Edge, allow camera access, pick your settings, and hit **Iniciar**.

> **Note:** The app must be served over `localhost` with specific security headers (COOP/COEP) for SharedArrayBuffer to work. The included `server.js` handles this automatically.

## Tech stack

Pure vanilla — no frameworks, no bundlers.

- **MediaPipe Hands** — hand landmark detection
- **Web Audio API** — AudioWorklet for real-time synthesis
- **SharedArrayBuffer** — zero-copy communication between threads
- **Canvas2D** — visualization
- **Node.js** — simple static file server
