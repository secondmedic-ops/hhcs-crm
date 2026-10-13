import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('microphone worklet emits PCM16 little-endian chunks and flushes the final partial chunk', () => {
  const messages: any[] = [];
  let Processor: any;
  runInNewContext(readFileSync(new URL('../../src/lib/pcm-worklet.js', import.meta.url), 'utf8'), {
    sampleRate: 16000,
    AudioWorkletProcessor: class { port = { postMessage: (m: any) => messages.push(m), onmessage: null }; },
    registerProcessor: (_name: string, p: any) => { Processor = p; },
  });
  const worklet = new Processor();
  worklet.process([[Float32Array.from([-2, -1, 0, 1, 2, ...Array(1595).fill(0)])]]);
  expect(messages).toHaveLength(1);
  expect(messages[0].audio.byteLength).toBe(3200);
  const bytes = new DataView(messages[0].audio);
  expect([0, 2, 4, 6, 8].map((i) => bytes.getInt16(i, true))).toEqual([-32768, -32768, 0, 32767, 32767]);
  worklet.process([[new Float32Array([0.5])]]);
  worklet.port.onmessage();
  expect(messages[1].audio.byteLength).toBe(2);
  expect(messages[2].flushed).toBe(true);
});
