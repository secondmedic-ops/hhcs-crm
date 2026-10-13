import { afterEach, expect, test, vi } from 'vitest';
import { api } from '../../src/api';
import { createLiveTranscription } from '../../src/lib/live-transcription.js';

vi.mock('../../src/api.ts', () => ({ api: {
  liveToken: vi.fn(async () => ({ token: 'auth_tokens/test', setup: { model: 'models/gemini-3.5-transcribe-live' }, transcript: '' })),
  saveLiveTranscript: vi.fn(async () => ({ saved: true, ended: false })),
} }));
vi.mock('../../src/lib/pcm-worklet.js?url', () => ({ default: 'pcm-worklet.js' }));

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

test('live session keeps interim words out of storage, resumes with a handle, and saves final speech before releasing capture', async () => {
  const sockets: any[] = [];
  const tracks = [{ stop: vi.fn(), onended: null }];
  let node: any;
  class Socket {
    static OPEN = 1;
    readyState = 1; bufferedAmount = 0;
    onopen?: () => void; onclose?: () => void; onmessage?: (e: any) => void;
    constructor(readonly url: string) { sockets.push(this); queueMicrotask(() => this.onopen?.()); }
    emit(data: any) { this.onmessage?.({ data: JSON.stringify(data) }); }
    send(text: string) {
      const message = JSON.parse(text);
      if (message.setup) queueMicrotask(() => this.emit({ setupComplete: {} }));
      if (message.realtimeInput?.audioStreamEnd) queueMicrotask(() => this.emit({ serverContent: { inputTranscription: { text: 'Final words.' } } }));
    }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  class Context {
    sampleRate = 16000; destination = {};
    audioWorklet = { addModule: async () => {} };
    resume = async () => {}; close = async () => {};
    createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
  }
  class Worklet {
    port = { onmessage: (_e: any) => {}, postMessage: () => queueMicrotask(() => this.port.onmessage({ data: { flushed: true } })) };
    constructor() { node = this; }
    connect() {} disconnect() {}
  }
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('AudioContext', Context);
  vi.stubGlobal('AudioWorkletNode', Worklet);
  vi.stubGlobal('window', { AudioWorkletNode: Worklet });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => tracks, getAudioTracks: () => tracks }) } });
  const updates: any[] = [];
  const errors: string[] = [];
  const session = createLiveTranscription('call-1', (u: any) => updates.push(u), (e: string) => errors.push(e));
  await session.start();
  expect(sockets[0].url).toContain('access_token=auth_tokens%2Ftest');
  sockets[0].emit({ serverContent: { interimInputTranscription: { text: 'Unconfirmed preview' } } });
  expect(updates.at(-1).transcript).toBe('');
  sockets[0].emit({ serverContent: { inputTranscription: { text: 'Committed words.' } }, sessionResumptionUpdate: { resumable: true, newHandle: 'resume-1' } });
  sockets[0].emit({ goAway: { timeLeft: '30s' } });
  await new Promise((r) => setTimeout(r, 10));
  expect(api.liveToken).toHaveBeenLastCalledWith('call-1', 'resume-1');
  node.port.onmessage({ data: { audio: new Uint8Array([0, 0]).buffer } });
  await session.stop();
  expect(api.saveLiveTranscript).toHaveBeenLastCalledWith('call-1', 'Committed words.\nFinal words.', true);
  expect(tracks[0].stop).toHaveBeenCalled();
  expect(sockets.at(-1).readyState).toBe(3);
  expect(updates.at(-1).state).toBe('saved');
  expect(errors).toEqual([]);
});

test('stopping while microphone permission is pending releases the late stream and creates no Gemini session', async () => {
  let grant: any;
  const stop = vi.fn();
  vi.stubGlobal('window', { AudioWorkletNode: class {} });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise((r) => { grant = r; }) } });
  const session = createLiveTranscription('call-2', () => {}, () => {});
  const starting = session.start();
  await session.stop();
  grant({ getTracks: () => [{ stop }] });
  await starting;
  expect(stop).toHaveBeenCalled();
  expect(api.liveToken).not.toHaveBeenCalled();
});

test('denied microphone access can be retried without saving a nonexistent session', async () => {
  vi.stubGlobal('window', { AudioWorkletNode: class {} });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => { throw new Error('Microphone access denied'); } } });
  const update = vi.fn();
  const error = vi.fn();
  await createLiveTranscription('call-3', update, error).start();
  expect(update).toHaveBeenLastCalledWith({ transcript: '', interim: '', state: 'idle' });
  expect(error).toHaveBeenCalledWith('Microphone access denied');
  expect(api.liveToken).not.toHaveBeenCalled();
  expect(api.saveLiveTranscript).not.toHaveBeenCalled();
});
