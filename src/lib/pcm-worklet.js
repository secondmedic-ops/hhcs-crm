// Mono PCM16, little-endian, in 100 ms chunks. The browser supplies the actual sample rate.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = Math.round(sampleRate / 10);
    this.buffer = new ArrayBuffer(this.frames * 2);
    this.view = new DataView(this.buffer);
    this.offset = 0;
    this.port.onmessage = () => { this.flush(); this.port.postMessage({ flushed: true }); };
  }
  flush() {
    if (this.offset) this.port.postMessage({ audio: this.buffer.slice(0, this.offset * 2) });
    this.buffer = new ArrayBuffer(this.frames * 2);
    this.view = new DataView(this.buffer);
    this.offset = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) for (const value of channel) {
      const sample = Math.max(-1, Math.min(1, value));
      this.view.setInt16(this.offset++ * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
      if (this.offset === this.frames) this.flush();
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
