import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);

async function testAudioWorklet() {
  globalThis.sampleRate = 48000;
  globalThis.AudioWorkletProcessor = class {};
  let Processor;
  globalThis.registerProcessor = (_, Ctor) => { Processor = Ctor; };
  await import(new URL(`public/audio-engine.js?smoke=${Date.now()}`, root));
  assert.ok(Processor, 'AudioWorklet processor should register');

  const sab = new SharedArrayBuffer(2048);
  const int32 = new Int32Array(sab);
  const float32 = new Float32Array(sab);
  int32[10] = 0;
  int32[30] = 0;
  float32[11] = 261.63;
  float32[12] = 329.63;
  float32[13] = 392.00;

  const processor = new Processor({ processorOptions: { sab } });
  const output = [new Float32Array(128), new Float32Array(128)];
  processor.process([], [output]);
  assert.ok(output[0].every(sample => sample === 0), 'silent audio should use the fast path');

  Atomics.store(int32, 32, 1);
  float32[33] = 1;
  float32[34] = 0;
  Atomics.store(int32, 96, 1);
  float32[97] = 1;
  float32[98] = Math.PI;
  for (let i = 0; i < 20; i++) processor.process([], [output]);
  assert.ok(output[0].some(sample => Math.abs(sample) > 0), 'active chord should produce audio');
}

async function testTrackingWorker() {
  const source = await readFile(new URL('public/tracking-worker.js', root), 'utf8');
  const messages = [];
  const context = {
    SharedArrayBuffer,
    Int32Array,
    Float32Array,
    Atomics,
    Math,
    Number,
    self: { postMessage: message => messages.push(message) }
  };
  vm.runInNewContext(source, context, { filename: 'tracking-worker.js' });

  const sab = new SharedArrayBuffer(2048);
  const int32 = new Int32Array(sab);
  const float32 = new Float32Array(sab);
  context.self.onmessage({ data: { type: 'init', sab } });

  const slot = 198;
  const sequence = 1;
  Atomics.store(int32, slot, -sequence);
  Atomics.store(int32, slot + 1, 1);
  Atomics.store(int32, slot + 2, 1);
  for (let i = 0; i < 42; i++) {
    float32[slot + 3 + i] = i / 100;
    float32[slot + 45 + i] = i / 100;
  }
  Atomics.store(int32, slot, sequence);
  context.self.onmessage({ data: { type: 'frame', slot, sequence } });

  assert.equal(messages[0].type, 'ready');
  assert.equal(int32[32], 1);
  assert.equal(int32[96], 1);
  assert.equal(float32[37], float32[slot + 3]);
  assert.equal(float32[101], float32[slot + 45]);
}

async function testStaticInvariants() {
  const [audio, main, server] = await Promise.all([
    readFile(new URL('public/audio-engine.js', root), 'utf8'),
    readFile(new URL('public/main.js', root), 'utf8'),
    readFile(new URL('server.js', root), 'utf8')
  ]);
  assert.doesNotMatch(audio, /const\s+freqs\s*=\s*\[/, 'audio process must not allocate per sample');
  assert.match(main, /TRACKING_INPUT/);
  assert.match(server, /createReadStream/);
  assert.match(server, /ETag/);
  assert.doesNotMatch(server, /readFileSync|existsSync|statSync/);
}

await testAudioWorklet();
await testTrackingWorker();
await testStaticInvariants();
console.log('performance smoke tests: PASS');
