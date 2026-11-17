// Speech recognition in its own utility process (voice.ts): loads the model given as argument and turns recordings
// into text. Messages: in { type: 'decode', id, samples, sampleRate }, out { type: 'ready' | 'failed' | 'result' | 'error' }.
import os from 'node:os';
import path from 'node:path';

interface Recognizer {
  createStream(): { acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void };
  decode(stream: unknown): void;
  getResult(stream: unknown): { text: string };
}
interface Sherpa { OfflineRecognizer: new (config: unknown) => Recognizer }
interface ParentPort { on(ev: 'message', cb: (e: { data: unknown }) => void): void; postMessage(m: unknown): void }

const port = (process as unknown as { parentPort: ParentPort }).parentPort;
const dir = process.argv[2];

let recognizer: Recognizer | null = null;
if (dir === '--probe') {
  // Trial run (voice.ts probe): does the engine load on this computer? Nothing else
  try {
    // Tests: an engine that does not load, as on a system it was not built for
    if (process.env.SOMA_TEST_VOICE_BROKEN) throw new Error('libsherpa-onnx-c-api: cannot open shared object file (simulated)');
    require('sherpa-onnx-node');
    port.postMessage({ type: 'probe', ok: true });
  } catch (e) {
    port.postMessage({ type: 'probe', ok: false, error: (e as Error).message.split('\n')[0] });
  }
} else try {
  // Loaded here and not imported: a missing or broken engine becomes a message, not a crash of the process
  const sherpa = require('sherpa-onnx-node') as Sherpa;
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(dir, 'encoder.int8.onnx'),
        decoder: path.join(dir, 'decoder.int8.onnx'),
        joiner: path.join(dir, 'joiner.int8.onnx'),
      },
      tokens: path.join(dir, 'tokens.txt'),
      // Half the cores, at most 4: more hardly helps and the viewer keeps running beside it
      numThreads: Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 2))),
      provider: 'cpu',
      debug: 0,
      modelType: 'nemo_transducer',
    },
  });
  port.postMessage({ type: 'ready' });
} catch (e) {
  port.postMessage({ type: 'failed', error: `The speech model could not be loaded: ${(e as Error).message}` });
}

port.on('message', (e) => {
  const m = e.data as { type?: string; id?: number; samples?: Float32Array; sampleRate?: number };
  if (m.type !== 'decode' || typeof m.id !== 'number') return;
  if (!recognizer) { port.postMessage({ type: 'error', id: m.id, error: 'The speech model is not loaded.' }); return; }
  try {
    const stream = recognizer.createStream();
    // The engine resamples to the 16 kHz of the model itself
    stream.acceptWaveform({ samples: m.samples!, sampleRate: m.sampleRate! });
    recognizer.decode(stream);
    port.postMessage({ type: 'result', id: m.id, text: recognizer.getResult(stream).text.trim() });
  } catch (err) {
    port.postMessage({ type: 'error', id: m.id, error: `Recognition failed: ${(err as Error).message}` });
  }
});
