// 共有クロックとオーディオエンジン。
// - SharedClock: P2P で同期する共有時刻（オファー側の performance.now() が基準）
// - AudioEngine: AudioContext / 入力キャプチャ / トランスポート / メトロノーム

export class SharedClock {
  constructor() {
    this.offsetMs = 0; // sharedNow = performance.now() + offsetMs
  }
  now() {
    return performance.now() + this.offsetMs;
  }
  toCtxTime(ctx, sharedMs) {
    return ctx.currentTime + (sharedMs - this.now()) / 1000;
  }
}

export class AudioEngine extends EventTarget {
  constructor(clock) {
    super();
    this.clock = clock;
    this.ctx = null;
    this.bpm = 100;
    this.beatsPerBar = 4;
    this.running = false;
    this.startCtx = 0;
    this.metronomeOn = true;
    this.userLatencyMs = 0; // 自動推定に加算する手動補正
    this.inputPeak = 0;
    this.inputChannels = 1;
    this.inputLabel = '';
    this.inputDeviceId = null;
    this.stream = null;
    this._srcNode = null;
    this._captureNode = null;
    this._chunkListeners = new Set();
    this._nextBeat = 0;
  }

  async init() {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule('./src/capture-worklet.js');
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);
    this.metroGain = ctx.createGain();
    this.metroGain.gain.value = 0.5;
    this.metroGain.connect(this.master);
    this.monitorGain = ctx.createGain();
    this.monitorGain.gain.value = 0;
    this.monitorGain.connect(this.master);
    // 録音経路の合流点。ライン入力とプラグイン音源がここに入り、
    // キャプチャワークレットが監視する（master へは繋がない）。
    this.captureBus = ctx.createGain();
    this._captureNode = new AudioWorkletNode(ctx, 'capture', { numberOfOutputs: 0 });
    this._captureNode.port.onmessage = (e) => this._onChunkMsg(e.data);
    this.captureBus.connect(this._captureNode);
    setInterval(() => this._tick(), 25);
    if (ctx.state !== 'running') await ctx.resume();
  }

  // ── 入力 ──────────────────────────────────────────────

  async listInputs() {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === 'audioinput');
  }

  // 入力デバイスを開く。AEC/NS/AGC はライン入力・音源入力を壊すため常時オフ。
  async selectInput(deviceId) {
    this._closeInput();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
        latency: 0,
      },
    });
    this.stream = stream;
    const track = stream.getAudioTracks()[0];
    const settings = track.getSettings();
    this.inputDeviceId = settings.deviceId ?? deviceId ?? null;
    this.inputLabel = track.label;
    this._srcNode = this.ctx.createMediaStreamSource(stream);
    this._srcNode.connect(this.captureBus);
    this._srcNode.connect(this.monitorGain);
    this.dispatchEvent(new CustomEvent('input'));
  }

  _closeInput() {
    if (this._srcNode) {
      this._srcNode.disconnect();
      this._srcNode = null;
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    this.inputPeak = 0;
  }

  hasInput() {
    return !!this.stream;
  }

  setMonitor(on) {
    this.monitorGain.gain.value = on ? 1 : 0;
  }

  onChunk(cb) {
    this._chunkListeners.add(cb);
  }
  offChunk(cb) {
    this._chunkListeners.delete(cb);
  }

  _onChunkMsg(m) {
    this.inputChannels = m.channels;
    let peak = 0;
    const d = m.ch0;
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.abs(d[i]);
      if (v > peak) peak = v;
    }
    this.inputPeak = Math.max(peak, this.inputPeak * 0.9);
    for (const cb of this._chunkListeners) cb(m);
  }

  // ── レイテンシ補正 ─────────────────────────────────────
  // グリッド時刻 T に鳴らした音は 出力遅延+入力遅延 後にキャプチャへ現れるため、
  // 録音窓をその分だけ後ろへずらす。

  autoLatencySec() {
    return (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0);
  }

  captureShiftSec() {
    return this.autoLatencySec() + this.userLatencyMs / 1000;
  }

  // ── トランスポート ─────────────────────────────────────

  secPerBeat() {
    return 60 / this.bpm;
  }
  barDur() {
    return this.beatsPerBar * this.secPerBeat();
  }
  ctxAtBar(n) {
    return this.startCtx + n * this.barDur();
  }
  posBars() {
    return (this.ctx.currentTime - this.startCtx) / this.barDur();
  }
  nextBarIndex(leadSec = 0.06) {
    const pos = (this.ctx.currentTime + leadSec - this.startCtx) / this.barDur();
    return Math.max(0, Math.ceil(pos));
  }

  start(startSharedMs) {
    this.startShared = startSharedMs;
    this.startCtx = this.clock.toCtxTime(this.ctx, startSharedMs);
    this.running = true;
    // 途中参加（開始時刻が過去）の場合は現在拍までスキップ
    this._nextBeat = Math.max(
      0,
      Math.ceil((this.ctx.currentTime - this.startCtx) / this.secPerBeat())
    );
    this.dispatchEvent(new CustomEvent('transport'));
  }

  stop() {
    this.running = false;
    this._cancelClicks(); // 先読み済みのクリックが停止後に鳴り残らないように
    this.dispatchEvent(new CustomEvent('transport'));
  }

  setMetronome(on) {
    this.metronomeOn = on;
    if (on) {
      // 消音中に先読み済みだった拍を巻き戻し、即クリックが鳴るようにする
      if (this.running) {
        this._nextBeat = Math.max(
          0,
          Math.ceil((this.ctx.currentTime - this.startCtx) / this.secPerBeat())
        );
      }
    } else {
      this._cancelClicks();
    }
  }

  _cancelClicks() {
    for (const n of this._clickNodes || []) {
      try { n.osc.stop(); } catch {}
    }
    this._clickNodes = [];
  }

  // バックグラウンドタブでは setInterval が最長1秒に絞られるため、
  // 1.3秒ぶん先読みしてスケジュールする。
  _tick() {
    this.inputPeak *= 0.94; // 入力が止まってもメーターが残留しないよう時間で減衰
    if (!this.running || !this.ctx) return;
    const now = this.ctx.currentTime;
    const horizon = now + 1.3;
    const spb = this.secPerBeat();
    while (this.startCtx + this._nextBeat * spb < horizon) {
      const t = this.startCtx + this._nextBeat * spb;
      if (this.metronomeOn && t >= now - 0.02) {
        this._click(t, this._nextBeat % this.beatsPerBar === 0);
      }
      this._nextBeat++;
    }
    this._clickNodes = (this._clickNodes || []).filter((n) => n.endTime > now);
  }

  _click(time, accent) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = accent ? 1760 : 1175;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(0.35, time + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    osc.connect(g);
    g.connect(this.metroGain);
    osc.start(time);
    osc.stop(time + 0.07);
    (this._clickNodes || (this._clickNodes = [])).push({ osc, endTime: time + 0.07 });
  }
}
