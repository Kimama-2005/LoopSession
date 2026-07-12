// 入力キャプチャ用 AudioWorklet。
// 約1024フレームずつまとめ、コンテキスト全体のフレーム番号付きで
// メインスレッドへ送る（録音とレベルメーター双方の共用ソース）。
const BATCH = 1024;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = 1;
    this.filled = 0;
    this.startFrame = 0;
    this.b0 = new Float32Array(BATCH);
    this.b1 = new Float32Array(BATCH);
  }

  flush() {
    if (this.filled === 0) return;
    const ch0 = this.b0.slice(0, this.filled);
    const ch1 = this.channels > 1 ? this.b1.slice(0, this.filled) : null;
    const transfer = ch1 ? [ch0.buffer, ch1.buffer] : [ch0.buffer];
    this.port.postMessage(
      { frame: this.startFrame, frames: this.filled, channels: this.channels, ch0, ch1 },
      transfer
    );
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      this.flush();
      return true;
    }
    const n = input[0].length;
    const channels = Math.min(input.length, 2);
    if (channels !== this.channels) {
      this.flush();
      this.channels = channels;
    }
    if (this.filled === 0) this.startFrame = currentFrame;
    this.b0.set(input[0], this.filled);
    if (channels > 1) this.b1.set(input[1], this.filled);
    this.filled += n;
    if (this.filled >= BATCH) this.flush();
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
