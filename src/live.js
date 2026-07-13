// LIVE モード（レガシー版の後継）: ルーパーを介さず、キャプチャバスの音声
// （ライン入力＋プラグイン音源）を小チャンクで連続送信し、受信側は共有グリッドの
// delayBars 小節後ろに整列して再生する（NINJAM 方式の遅延合奏）。
//
// チャンクは自己記述（専用 DataChannel 'live'、バイナリ）:
//   f64 barPos(送信側の小節位置・レイテンシ補正済) / u32 frames / u32 senderId /
//   u32 sampleRate / u8 channels / u8 delayBars / 2byte pad / Int16 PCM (プレーナ)
// ヘッダだけで再生できるため、ホスト中継・複数送信者・途中参加に耐える。
// live-state 制御メッセージは UI 表示用。

const HEADER_BYTES = 24;

export class LiveSend {
  constructor(engine, p2p, peerId) {
    this.engine = engine;
    this.p2p = p2p;
    this.peerId = peerId;
    this.senderId = parseInt(peerId, 16) >>> 0;
    this.enabled = false;
    this.delayBars = 1;
    engine.onChunk((m) => this._onChunk(m));
  }

  setEnabled(on) {
    this.enabled = on;
    this.sendState();
  }

  setDelay(bars) {
    this.delayBars = bars;
    this.sendState();
  }

  sendState() {
    this.p2p.send({
      t: 'live-state',
      from: this.peerId,
      on: this.enabled,
      delayBars: this.delayBars,
    });
  }

  _onChunk(m) {
    const e = this.engine;
    if (!this.enabled || !e.running || !this.p2p.liveOpen()) return;
    const sr = e.ctx.sampleRate;
    const barPos = (m.frame / sr - e.captureShiftSec() - e.startCtx) / e.barDur();
    if (barPos < 0) return;
    const buf = new ArrayBuffer(HEADER_BYTES + m.frames * m.channels * 2);
    const view = new DataView(buf);
    view.setFloat64(0, barPos);
    view.setUint32(8, m.frames);
    view.setUint32(12, this.senderId);
    view.setUint32(16, sr);
    view.setUint8(20, m.channels);
    view.setUint8(21, this.delayBars);
    const out = new Int16Array(buf, HEADER_BYTES);
    const chs = [m.ch0, m.ch1];
    for (let c = 0; c < m.channels; c++) {
      const d = chs[c];
      for (let i = 0; i < m.frames; i++) {
        const s = Math.max(-1, Math.min(1, d[i]));
        out[c * m.frames + i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
    }
    this.p2p.sendLive(buf);
  }
}

export class LiveReceive extends EventTarget {
  constructor(engine) {
    super();
    this.engine = engine;
    this.gain = engine.ctx.createGain();
    this.gain.gain.value = 0.9;
    this.gain.connect(engine.master);
    // senderId → {ctx, acc}: 連続チャンクをサンプル精度で並べる基準（送信者ごと）
    this._anchors = new Map();
    // senderId(hex) → {on, delayBars}: UI 表示用（live-state から）
    this.states = new Map();
    engine.addEventListener('transport', () => this._anchors.clear());
  }

  setState(m) {
    this.states.set(m.from, { on: !!m.on, delayBars: m.delayBars || 1 });
    this._anchors.delete(parseInt(m.from, 16) >>> 0);
    this.dispatchEvent(new CustomEvent('change'));
  }

  setGain(v) {
    this.gain.gain.value = v;
  }

  onData(buf) {
    const e = this.engine;
    if (!e.running || buf.byteLength < HEADER_BYTES) return;
    const view = new DataView(buf);
    const barPos = view.getFloat64(0);
    const frames = view.getUint32(8);
    const senderId = view.getUint32(12);
    const sr = view.getUint32(16) || 48000;
    const channels = Math.max(1, view.getUint8(20));
    const delayBars = Math.max(1, view.getUint8(21));
    const idealWhen = e.ctxAtBar(barPos + delayBars);
    // アンカーが無い/ずれた（送信再開・クロック補正・テンポ変更）ときは張り直す
    let anchor = this._anchors.get(senderId);
    if (!anchor || Math.abs(anchor.ctx + anchor.acc / sr - idealWhen) > 0.05) {
      anchor = { ctx: idealWhen, acc: 0 };
      this._anchors.set(senderId, anchor);
    }
    const when = anchor.ctx + anchor.acc / sr;
    anchor.acc += frames;
    if (when < e.ctx.currentTime + 0.005) {
      // 手遅れ（ネットワーク遅延 > 遅延小節）。捨てて次で張り直す
      this._anchors.delete(senderId);
      return;
    }
    const audio = e.ctx.createBuffer(channels, frames, sr);
    const int = new Int16Array(buf, HEADER_BYTES);
    for (let c = 0; c < channels; c++) {
      const f = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        const v = int[c * frames + i];
        f[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
      }
      audio.copyToChannel(f, c);
    }
    const src = e.ctx.createBufferSource();
    src.buffer = audio;
    src.connect(this.gain);
    src.start(when);
  }
}
