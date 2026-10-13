import { api } from '../api.ts';
import workletUrl from './pcm-worklet.js?url';

// Ephemeral auth_tokens credentials require the constrained endpoint (Google's WebSocket guide).
const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** One microphone session, kept outside page components so navigation does not stop a call's capture. */
export function createLiveTranscription(callId, onUpdate, onError) {
  let socket, stream, context, source, worklet, checkpoint, handle = '', transcript = '', interim = '';
  let stopping = false, hasSession = false, ready = false, reconnecting = false, retries = 0, queue = [], saved = '', saving = Promise.resolve();
  let flushDone, stopPromise, tokenRequest;
  const update = (state) => onUpdate({ transcript, interim, state });
  const save = (final) => {
    const text = transcript;
    saving = saving.catch(() => {}).then(async () => {
      if (text === saved && !final) return;
      await api.saveLiveTranscript(callId, text, final);
      saved = text;
    });
    return saving;
  };
  const sendAudio = (audio) => {
    const bytes = new Uint8Array(audio);
    const message = JSON.stringify({ realtimeInput: { audio: { data: btoa(String.fromCharCode(...bytes)), mimeType: `audio/pcm;rate=${context.sampleRate}` } } });
    if (ready && socket?.readyState === WebSocket.OPEN) {
      if (socket.bufferedAmount > 1024 * 1024) { fail('The connection is too slow for live audio.'); return; }
      socket.send(message);
    } else {
      queue.push(message);
      if (queue.length > 50) fail('Live audio was interrupted. The captured transcript is kept; restart after checking the connection.');
    }
  };
  const release = () => {
    clearInterval(checkpoint);
    source?.disconnect(); worklet?.disconnect();
    stream?.getTracks().forEach((t) => t.stop());
    context?.close().catch(() => {});
    socket?.close();
  };
  const fail = (message) => {
    if (stopping) return;
    stopping = true;
    release();
    update(transcript.trim() || interim.trim() ? 'interrupted' : 'idle');
    if (hasSession) save(false).catch(() => onError('Transcript is not saved yet. Use Retry saving before leaving this page.'));
    onError(message);
  };
  const connect = async () => {
    if (stopping) return;
    ready = false;
    tokenRequest = api.liveToken(callId, handle);
    let token;
    try { token = await tokenRequest; } finally { tokenRequest = null; }
    hasSession = true;
    if (!transcript) { transcript = token.transcript; saved = transcript; }
    if (stopping) return;
    const previous = socket;
    const ws = new WebSocket(`${WS_URL}?access_token=${encodeURIComponent(token.token)}`);
    socket = ws;
    previous?.close();
    await new Promise((resolve, reject) => {
      let connected = false;
      const timeout = setTimeout(() => { ws.close(); reject(new Error('Gemini did not start the live session within 15 seconds.')); }, 15000);
      ws.onopen = () => { if (!stopping && socket === ws) ws.send(JSON.stringify({ setup: token.setup })); else ws.close(); };
      ws.onmessage = async (event) => {
        if (socket !== ws) return;
        try {
          const message = JSON.parse(typeof event.data === 'string' ? event.data : await event.data.text());
          if (message.error) throw new Error('Gemini refused the live session. Check Test key and the project quota in Settings.');
          if (message.setupComplete) {
            clearTimeout(timeout);
            if (stopping) { ws.close(); return; }
            connected = true; ready = true; retries = 0; reconnecting = false;
            queue.splice(0).forEach((audio) => ws.send(audio));
            update('listening'); resolve();
          }
          const content = message.serverContent;
          if (content?.interimInputTranscription) { interim = content.interimInputTranscription.text || ''; update(stopping ? 'saving' : 'listening'); }
          if (content?.inputTranscription?.text) {
            if (transcript.length + content.inputTranscription.text.length + 1 > 100000) { fail('The live transcript reached its size limit. Save it and continue with the call recording.'); return; }
            transcript += (transcript ? '\n' : '') + content.inputTranscription.text;
            interim = ''; update(stopping ? 'saving' : 'listening');
          }
          if (message.sessionResumptionUpdate?.resumable) handle = message.sessionResumptionUpdate.newHandle || handle;
          if (message.goAway && !stopping) reconnect();
        } catch {
          clearTimeout(timeout);
          reject(new Error('Gemini could not transcribe the audio. Check the key, model access and quota in Settings.'));
          fail('Gemini could not transcribe the audio. Check the key, model access and quota in Settings.');
        }
      };
      ws.onerror = () => { clearTimeout(timeout); reject(new Error('Could not connect to Gemini live transcription.')); };
      ws.onclose = (event) => {
        clearTimeout(timeout);
        // Surface only a classified explanation and code, never Google's raw reason (it can contain credentials).
        const reason = String(event?.reason || '');
        const code = Number(event?.code) || 1006;
        const rejected = /permission|unauthori[sz]ed|auth.?token|api.?key|invalid|not supported|not found/i.test(reason) || code === 1008;
        const busy = /quota|exhaust|capacity|overload|high demand|rate limit/i.test(reason) || code === 1013;
        const message = rejected ? `Gemini refused live access (${code}). Check the key and live-model access in Settings.`
          : busy ? `Gemini live transcription is busy or over quota (${code}). Try again shortly.` : `Gemini closed the live connection (${code}). Check the connection and try again.`;
        reject(new Error(message));
        if (socket === ws && !stopping && !reconnecting && connected) {
          if (rejected) fail(message); else reconnect();
        }
      };
    });
  };
  const reconnect = async () => {
    if (reconnecting || stopping) return;
    reconnecting = true; ready = false; update('reconnecting');
    for (retries = 0; retries < 3 && !stopping; retries++) {
      try { await connect(); return; } catch { await wait(1000); }
    }
    if (!stopping) fail('Live transcription disconnected. Saved words are kept; restart to continue.');
  };
  const start = async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) throw new Error('Live transcription needs a supported browser on HTTPS and microphone access.');
      update('connecting');
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false }, video: false });
      if (stopping) { release(); return; }
      context = new AudioContext({ sampleRate: 16000 });
      await context.resume();
      await context.audioWorklet.addModule(workletUrl);
      await connect();
      if (stopping) { release(); return; }
      source = context.createMediaStreamSource(stream);
      worklet = new AudioWorkletNode(context, 'pcm-capture', { channelCount: 1 });
      worklet.port.onmessage = ({ data }) => { if (data.audio) sendAudio(data.audio); if (data.flushed) flushDone?.(); };
      source.connect(worklet); worklet.connect(context.destination);
      stream.getAudioTracks()[0].onended = () => fail('Microphone access ended. Save the captured transcript before leaving.');
      checkpoint = setInterval(() => save(false).catch(() => onError('Live words are visible but not saved yet. Check the connection or use Retry saving.')), 30000);
    } catch (e) { fail(e.message); }
  };
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopping = true;
      clearInterval(checkpoint); source?.disconnect(); stream?.getTracks().forEach((t) => t.stop());
      update('saving');
      // A token can finish minting after hang-up. Wait for it so its server-side session is finalised too.
      if (tokenRequest) await tokenRequest.catch(() => {});
      try { if (worklet && ready && socket?.readyState === WebSocket.OPEN) {
        await Promise.race([new Promise((r) => { flushDone = r; worklet.port.postMessage('flush'); }), wait(200)]);
        socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
        // Transcription can arrive after turnComplete and in multiple messages. Drain before saving.
        await wait(3000);
      } } finally { release(); }
      if (hasSession) await save(true);
      update('saved');
      return { unconfirmed: !!interim };
    })();
    return stopPromise;
  };
  const retrySave = async () => {
    if (hasSession) await save(true);
    const result = { unconfirmed: !!interim };
    stopPromise = Promise.resolve(result);
    update('saved');
    return result;
  };
  return { start, stop, hasSpeech: () => !!(transcript.trim() || interim.trim()), retrySave, dispose: () => { stopping = true; release(); if (hasSession) save(false).catch(() => {}); } };
}
