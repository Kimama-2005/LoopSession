// オーディオI/F入力を小チャンクで連続送信し、相手側で delayBars 小節ぶん
// 後ろの同じ位置に並べて再生する（整数小節遅延なので拍が自動で揃う）。
//
// バイナリフレーム: [f64 captureHost(ms)][u32 sampleRate][u32 numSamples][i16 payload...]
const HEAD = 16;

export class AudioLink {
  constructor(session) {
    this.session = session;
    this.ctx = session.clock.ctx;
    this.enabled = false;
    this.stream = null;
    this.node = null;
    this.srcNode = null;
    this.onLevel = () => {};
    this._scheduled = [];
    // 相手の音の出力経路（自分の音は機材側モニター前提でアプリでは鳴らさない）
    this.out = this.ctx.createGain();
    this.out.gain.value = 1.0;
    this.pan = this.ctx.createStereoPanner();
    this.pan.pan.value = 0.0;
    this.out.connect(this.pan).connect(this.ctx.destination);
  }

  async listInputs() {
    const d = await navigator.mediaDevices.enumerateDevices();
    return d.filter((x) => x.kind === "audioinput");
  }

  async enable(deviceId) {
    if (this.enabled) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    await this.ctx.audioWorklet.addModule("./src/capture-worklet.js");
    this.srcNode = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "capture", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
    this.node.port.onmessage = (e) => this._onCapture(e.data);
    this.srcNode.connect(this.node);
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = null;
    }
    if (this.srcNode) {
      this.srcNode.disconnect();
      this.srcNode = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.onLevel(0);
  }

  _onCapture({ time, samples }) {
    if (!this.enabled) return;
    // レベルメーター
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const a = samples[i] < 0 ? -samples[i] : samples[i];
      if (a > peak) peak = a;
    }
    this.onLevel(peak);

    if (!this.session.config) return; // 未接続/未同期なら送らない
    const captureHost = this.session.clock.audioToHost(time);

    // Float32 -> Int16
    const i16 = new Int16Array(samples.length);
    for (let n = 0; n < samples.length; n++) {
      let s = samples[n];
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      i16[n] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    const buf = new ArrayBuffer(HEAD + i16.byteLength);
    const dv = new DataView(buf);
    dv.setFloat64(0, captureHost, true);
    dv.setUint32(8, this.ctx.sampleRate, true);
    dv.setUint32(12, i16.length, true);
    new Int16Array(buf, HEAD).set(i16);
    this.session.conn.sendAudio(buf);
  }

  // 相手からのチャンク受信 → delayBars 小節後ろに正確にスケジュール
  onAudioMessage(buf) {
    if (!this.session.config) return;
    const dv = new DataView(buf);
    const captureHost = dv.getFloat64(0, true);
    const sampleRate = dv.getUint32(8, true);
    const num = dv.getUint32(12, true);
    const i16 = new Int16Array(buf, HEAD, num);
    const f32 = new Float32Array(num);
    for (let n = 0; n < num; n++) f32[n] = i16[n] / 0x8000;

    const abuf = this.ctx.createBuffer(1, num, sampleRate);
    abuf.copyToChannel(f32, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = abuf;
    src.connect(this.out);

    const playHost =
      captureHost + this.session.config.delayBars * this.session.barDur;
    const when = this.session.clock.hostToAudio(playHost);
    const now = this.ctx.currentTime;
    if (when < now + 0.01) return; // 遅すぎたら破棄（重なり防止）
    src.start(when);

    this._scheduled.push(src);
    src.onended = () => {
      const i = this._scheduled.indexOf(src);
      if (i >= 0) this._scheduled.splice(i, 1);
    };
  }
}
