// トラック＝ひとつのループスロット。
// 録音1回分を「レイヤー」として重ねる（オーバーダブ＝レイヤー追加、UNDO＝末尾削除）。
// 各レイヤーは loop=true の AudioBufferSourceNode としてグリッドに位相整列して回る。

let layerSeq = 0;

// 指定フレーム範囲 [start, start+frames) をワークレットのチャンク列から切り出す
class Capture {
  constructor(startFrame, frames, channels) {
    this.start = startFrame;
    this.frames = frames;
    this.data = [];
    for (let c = 0; c < channels; c++) this.data.push(new Float32Array(frames));
  }

  // 完了したら true
  feed(m) {
    const from = Math.max(m.frame, this.start);
    const to = Math.min(m.frame + m.frames, this.start + this.frames);
    if (to > from) {
      const srcOff = from - m.frame;
      const dstOff = from - this.start;
      const len = to - from;
      const chans = [m.ch0, m.ch1];
      for (let c = 0; c < this.data.length; c++) {
        const src = chans[Math.min(c, m.channels - 1)];
        this.data[c].set(src.subarray(srcOff, srcOff + len), dstOff);
      }
    }
    return m.frame + m.frames >= this.start + this.frames;
  }
}

export class Track extends EventTarget {
  constructor(engine, { id, ownerId, name, lengthBars = 2, remote = false }) {
    super();
    this.engine = engine;
    this.id = id;
    this.ownerId = ownerId;
    this.name = name;
    this.lengthBars = lengthBars;
    this.remote = remote;
    this.layers = []; // {id, buffer, phaseBar, source}
    this.state = 'empty'; // empty | armed | recording | playing
    this.recStartBar = 0;
    this.muted = false;
    this.solo = false;
    this.suppressed = false; // 他トラックのソロにより消音（main.js が一括計算）
    this.gain = 0.9;
    this.gainNode = engine.ctx.createGain();
    this.gainNode.gain.value = this.gain;
    this.gainNode.connect(engine.master);
    this._capture = null;
    this._onChunk = null;
  }

  // ── 録音 ──────────────────────────────────────────────

  // REC ボタン: 空なら録音予約、予約中なら解除、再生中ならオーバーダブ予約
  toggleRecord(minBar = 0) {
    if (this.state === 'armed') {
      this.cancelCapture();
      return;
    }
    if (this.state === 'recording') return; // 固定長録音なので途中停止なし
    this.arm(minBar);
  }

  arm(minBar = 0) {
    const e = this.engine;
    if (!e.running) return;
    this.recStartBar = Math.max(minBar, e.nextBarIndex());
    const sr = e.ctx.sampleRate;
    const startFrame = Math.round(
      (e.ctxAtBar(this.recStartBar) + e.captureShiftSec()) * sr
    );
    const frames = Math.round(this.lengthBars * e.barDur() * sr);
    const cap = new Capture(startFrame, frames, Math.max(1, e.inputChannels));
    this._capture = cap;
    this._onChunk = (m) => {
      if (this.state === 'armed' && m.frame + m.frames > startFrame) {
        this._setState('recording');
      }
      if (cap.feed(m)) this._finishCapture();
    };
    e.onChunk(this._onChunk);
    this._setState('armed');
  }

  cancelCapture() {
    if (!this._capture) return;
    this.engine.offChunk(this._onChunk);
    this._capture = null;
    this._onChunk = null;
    this._setState(this.layers.length ? 'playing' : 'empty');
  }

  _finishCapture() {
    const cap = this._capture;
    this.engine.offChunk(this._onChunk);
    this._capture = null;
    this._onChunk = null;
    const e = this.engine;
    const buf = e.ctx.createBuffer(cap.data.length, cap.frames, e.ctx.sampleRate);
    cap.data.forEach((d, c) => buf.copyToChannel(d, c));
    const layer = this.addLayer({
      id: `${this.ownerId}-L${++layerSeq}`,
      buffer: buf,
      phaseBar: this.recStartBar % this.lengthBars,
    });
    this.dispatchEvent(new CustomEvent('recorded', { detail: { layer } }));
  }

  // ── レイヤー / 再生 ────────────────────────────────────

  addLayer({ id, buffer, phaseBar }) {
    const layer = { id, buffer, phaseBar, source: null };
    this.layers.push(layer);
    if (this.engine.running) this._schedule(layer);
    this._setState('playing');
    this.dispatchEvent(new CustomEvent('layers'));
    return layer;
  }

  // 位相を合わせてループ再生を開始する。
  // buffer 先頭がグリッド上の bar ≡ phaseBar (mod lengthBars) に一致するよう
  // オフセット再生する（途中参加・転送遅延・再開すべて同じ式で吸収）。
  _schedule(layer) {
    const e = this.engine;
    const loopDur = this.lengthBars * e.barDur();
    const when = Math.max(e.ctx.currentTime + 0.03, e.ctxAtBar(0));
    const anchor = e.ctxAtBar(layer.phaseBar);
    let off = (when - anchor) % loopDur;
    if (off < 0) off += loopDur;
    const src = e.ctx.createBufferSource();
    src.buffer = layer.buffer;
    src.loop = true;
    src.connect(this.gainNode);
    src.start(when, off);
    layer.source = src;
  }

  stopPlayback() {
    for (const l of this.layers) {
      if (l.source) {
        try { l.source.stop(); } catch {}
        l.source.disconnect();
        l.source = null;
      }
    }
  }

  onTransportStart() {
    for (const l of this.layers) this._schedule(l);
  }

  onTransportStop() {
    this.cancelCapture();
    this.stopPlayback();
  }

  // ループ内の現在位置 0..1（プレイヘッド表示用）
  playPos() {
    const e = this.engine;
    if (!e.running || !this.layers.length) return null;
    const L = this.lengthBars;
    let p = (e.posBars() - (this.layers[0].phaseBar || 0)) / L;
    p = p % 1;
    if (p < 0) p += 1;
    return p;
  }

  undo() {
    const layer = this.layers.pop();
    if (!layer) return null;
    if (layer.source) {
      try { layer.source.stop(); } catch {}
      layer.source.disconnect();
    }
    if (!this.layers.length && this.state === 'playing') this._setState('empty');
    this.dispatchEvent(new CustomEvent('layers'));
    return layer;
  }

  removeLayer(id) {
    const i = this.layers.findIndex((l) => l.id === id);
    if (i < 0) return;
    const [layer] = this.layers.splice(i, 1);
    if (layer.source) {
      try { layer.source.stop(); } catch {}
      layer.source.disconnect();
    }
    if (!this.layers.length && this.state === 'playing') this._setState('empty');
    this.dispatchEvent(new CustomEvent('layers'));
  }

  clear() {
    this.cancelCapture();
    this.stopPlayback();
    this.layers = [];
    this._setState('empty');
    this.dispatchEvent(new CustomEvent('layers'));
  }

  // ── その他 ────────────────────────────────────────────

  _applyGain() {
    this.gainNode.gain.value = this.muted || this.suppressed ? 0 : this.gain;
  }

  setGain(v) {
    this.gain = v;
    this._applyGain();
  }

  setMuted(b) {
    this.muted = b;
    this._applyGain();
  }

  setSolo(b) {
    this.solo = b;
  }

  setSuppressed(b) {
    this.suppressed = b;
    this._applyGain();
  }

  setLengthBars(n) {
    if (this.layers.length || this.state !== 'empty') return false;
    this.lengthBars = n;
    return true;
  }

  dispose() {
    this.cancelCapture();
    this.stopPlayback();
    this.gainNode.disconnect();
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.dispatchEvent(new CustomEvent('change'));
  }
}
