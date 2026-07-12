// 入力音声(モノラル)をまとめて main スレッドへ渡すだけの最小 AudioWorklet。
// バー分割や送信は main 側(audio.js)で行う。各バッチには先頭サンプルの
// audioContext 時刻(time)を添えるので、共有時計へ変換して1小節遅延を計算できる。
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = 2048; // まとめて送るサンプル数(~43ms @48k)
    this.buf = new Float32Array(this.batch);
    this.fill = 0;
    this.startTime = null; // buf[0] に対応する audioContext 時刻(秒)
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0]; // channel 0 のみ(モノラル)
    if (this.startTime === null) this.startTime = currentTime;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.fill++] = ch[i];
      if (this.fill === this.batch) {
        const chunk = this.buf; // 転送するので新しいバッファに差し替え
        this.port.postMessage({ time: this.startTime, samples: chunk }, [chunk.buffer]);
        this.buf = new Float32Array(this.batch);
        this.fill = 0;
        this.startTime += this.batch / sampleRate;
      }
    }
    return true;
  }
}

registerProcessor("capture", CaptureProcessor);
