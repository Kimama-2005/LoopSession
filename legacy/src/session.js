import { AudioClock } from "./audioClock.js";
import { Synth } from "./synth.js";
import { AudioLink } from "./audio.js";

// メッセージ (DataChannel 上の JSON):
//   { type:'config', config:{bpm,beatsPerBar,delayBars,sessionStart} }
//   { type:'ping',  c0 }                       参加者→ホスト
//   { type:'pong',  c0, h }                    ホスト→参加者
//   { type:'note',  on, note, velocity, barIndex, posInBar }
export class Session {
  constructor(role, conn, ctx) {
    this.role = role; // 'host' | 'client'
    this.conn = conn;
    this.clock = new AudioClock(ctx);
    this.synth = new Synth(ctx);
    this.config = null;
    this.instrument = "keys"; // 自分の楽器（UI から変更）
    this.running = false;
    this.bestRtt = Infinity;
    this.pingTimer = null;
    this.schedTimer = null;
    this.nextBeat = 0;
    // ルーパー: 録音した音を毎ループ再生し、通常演奏と同じ経路で送出する
    this.loop = {
      bars: 1,
      events: [], // {posInLoop, on, note, velocity, instrument}
      playing: false,
      recState: "idle", // idle | armed | recording
      recStart: 0,
      recEnd: 0,
      fresh: true,
    };
    this.loopSchedUpTo = 0;
    this.onLog = () => {};
    this.onSync = () => {};
    this.onRemoteNote = () => {}; // UI 鍵盤ハイライト用 (on, note)
    this.onLoopNote = () => {}; // ループ再生音のハイライト用 (on, note)
    this.onLoopState = () => {}; // (recState, label, eventCount)
    this.audio = new AudioLink(this); // オーディオI/F音声転送
    conn.onMessage = (m) => this._handle(m);
    conn.onAudio = (buf) => this.audio.onAudioMessage(buf);
  }

  // ホストが設定を確定して配信
  setConfig(cfg) {
    this.config = cfg;
    this.conn.send({ type: "config", config: cfg });
  }

  get barDur() {
    return (60000 / this.config.bpm) * this.config.beatsPerBar;
  }
  get beatDur() {
    return 60000 / this.config.bpm;
  }

  // 共有タイムライン上の時刻 → 小節/位置
  position(hostMs) {
    const rel = hostMs - this.config.sessionStart;
    const bar = Math.floor(rel / this.barDur);
    const pos = rel - bar * this.barDur;
    const beat = Math.floor((rel - bar * this.barDur) / this.beatDur);
    return { bar, pos, beat };
  }

  _handle(m) {
    if (m.type === "config") {
      this.config = m.config;
      this.onLog(
        `config 受信: ${m.config.bpm}BPM ${m.config.beatsPerBar}拍 遅延=${m.config.delayBars}小節`
      );
      this._startPing(); // 参加者側でクロック同期開始
    } else if (m.type === "ping") {
      // ホスト: 自分の時計 (=共有時計) を返す
      this.conn.send({ type: "pong", c0: m.c0, h: performance.now() });
    } else if (m.type === "pong") {
      const c1 = performance.now();
      const rtt = c1 - m.c0;
      if (rtt < this.bestRtt) {
        this.bestRtt = rtt;
        // 往復が対称と仮定: local時刻 (c0+c1)/2 のとき host時刻は m.h
        this.clock.hostOffset = m.h - (m.c0 + c1) / 2;
        this.onSync();
        this.onLog(
          `clock 同期: offset=${this.clock.hostOffset.toFixed(1)}ms rtt=${rtt.toFixed(1)}ms`
        );
      }
      if (!this.running && this.config) this.startTransport();
    } else if (m.type === "note") {
      this._scheduleRemote(m);
    }
  }

  _startPing() {
    if (this.pingTimer) return;
    const ping = () => this.conn.send({ type: "ping", c0: performance.now() });
    ping();
    this.pingTimer = setInterval(ping, 1000);
  }

  // 手元の演奏。自分はすぐモニターし、相手には小節/位置を付けて送る。
  localNote(on, note, velocity) {
    if (!this.config) return;
    const hostMs = this.clock.hostNow();
    const { bar, pos } = this.position(hostMs);
    const when = this.clock.ctx.currentTime + 0.015;
    const opts = { instrument: this.instrument, pan: -0.25 }; // 自分は左寄り
    if (on) this.synth.noteOn("L" + note, note, velocity, when, opts);
    else this.synth.noteOff("L" + note, when);
    // 録音中なら loop バッファに記録（ループ内の相対位置で保存）
    if (this.loop.recState === "recording") {
      const len = this.loopLen;
      const posInLoop =
        (((hostMs - this.config.sessionStart) % len) + len) % len;
      this.loop.events.push({ posInLoop, on, note, velocity, instrument: this.instrument });
    }
    this.conn.send({
      type: "note",
      on,
      note,
      velocity,
      instrument: this.instrument,
      barIndex: bar,
      posInBar: pos,
    });
  }

  // 相手の音を delayBars 小節ぶん後ろの同じ位置で鳴らす
  _scheduleRemote(m) {
    if (!this.config) return;
    const playHost =
      this.config.sessionStart +
      (m.barIndex + this.config.delayBars) * this.barDur +
      m.posInBar;
    let when = this.clock.hostToAudio(playHost);
    const now = this.clock.ctx.currentTime;
    if (when < now + 0.005) when = now + 0.02; // 間に合わなければ即時
    const inst = m.instrument || "keys";
    const opts = { instrument: inst, pan: 0.25 }; // 相手は右寄り
    const id = "R" + inst + m.note;
    if (m.on) this.synth.noteOn(id, m.note, m.velocity, when, opts);
    else this.synth.noteOff(id, when);
    this.onRemoteNote(m.on, m.note, when - now);
  }

  // メトロノーム (先読みスケジューラ)。両端末とも同じ共有時計で刻むので同期する。
  startTransport() {
    if (this.running || !this.config) return;
    this.running = true;
    this.clock.reanchor();
    const rel = this.clock.hostNow() - this.config.sessionStart;
    this.nextBeat = Math.ceil(rel / this.beatDur);
    this.schedTimer = setInterval(() => this._tick(), 25);
    this.onLog("transport 開始");
  }

  _tick() {
    if (!this.config) return;
    const ctx = this.clock.ctx;
    const lookahead = 0.2;
    for (;;) {
      const beatHost = this.config.sessionStart + this.nextBeat * this.beatDur;
      const when = this.clock.hostToAudio(beatHost);
      if (when > ctx.currentTime + lookahead) break;
      if (when > ctx.currentTime + 0.001) {
        const accent = this.nextBeat % this.config.beatsPerBar === 0;
        this.synth.click(when, accent);
      }
      this.nextBeat++;
    }
    this._updateRecording();
    this._loopTick();
  }

  // ===== ルーパー =====
  get loopLen() {
    return this.loop.bars * this.barDur;
  }

  _emitLoop(label) {
    this.onLoopState(this.loop.recState, label, this.loop.events.length);
  }

  // ループ長を変更（内容があるとズレるためクリア）
  setLoopBars(n) {
    this._stopLoopPlayback();
    this.loop.bars = n;
    this.loop.events = [];
    this.loop.playing = false;
    this.loop.recState = "idle";
    this._emitLoop("空");
  }

  // ループ停止時の後始末。持続音(Keys/Bass)は noteOff がまだ発火していない場合に
  // 鳴り続けるため、ローカルの LP ボイスを解放し、相手にも取り残された音の
  // note-off を送る（送信済み先読み分より後ろに置いて順序逆転を防ぐ）。
  _stopLoopPlayback() {
    this.synth.releaseAll("LP", this.clock.ctx.currentTime);
    if (!this.config) return;
    const distinct = new Map(); // instrument+note -> {note, instrument}
    for (const ev of this.loop.events) {
      if (ev.on && ev.instrument !== "drums")
        distinct.set(ev.instrument + ev.note, ev);
    }
    if (distinct.size === 0) return;
    const cleanupHost = Math.max(this.loopSchedUpTo, this.clock.hostNow()) + 1;
    const { bar, pos } = this.position(cleanupHost);
    for (const ev of distinct.values()) {
      this.conn.send({
        type: "note",
        on: false,
        note: ev.note,
        velocity: 0,
        instrument: ev.instrument,
        barIndex: bar,
        posInBar: pos,
      });
    }
  }

  // 録音を予約。次のループ境界から loopBars 小節ぶん記録する。
  // 既に内容があればオーバーダブ（追記）、無ければ新規。
  armRecord() {
    if (!this.config) return;
    const rel = this.clock.hostNow() - this.config.sessionStart;
    const nextBoundary =
      this.config.sessionStart + Math.ceil(rel / this.loopLen) * this.loopLen;
    this.loop.recStart = nextBoundary;
    this.loop.recEnd = nextBoundary + this.loopLen;
    this.loop.fresh = this.loop.events.length === 0;
    this.loop.recState = "armed";
    this._emitLoop("録音待機（次の小節から）");
  }

  clearLoop() {
    this._stopLoopPlayback();
    this.loop.events = [];
    this.loop.playing = false;
    this.loop.recState = "idle";
    this._emitLoop("空");
  }

  _updateRecording() {
    const L = this.loop;
    if (L.recState === "idle") return;
    const now = this.clock.hostNow();
    if (L.recState === "armed" && now >= L.recStart) {
      if (L.fresh) L.events = [];
      L.recState = "recording";
      L.playing = true;
      this.loopSchedUpTo = L.recStart; // ここから再生スケジュール開始
      this._emitLoop("録音中");
    }
    if (L.recState === "recording" && now >= L.recEnd) {
      L.recState = "idle";
      this._emitLoop("ループ再生中");
    }
  }

  // 先読みでループ内イベントをスケジュール（メトロノームと同じ考え方）
  _loopTick() {
    const L = this.loop;
    if (!L.playing || L.events.length === 0) return;
    const start = this.config.sessionStart;
    const len = this.loopLen;
    const target = this.clock.hostNow() + 200; // 先読み(ms, host時間)
    for (const ev of L.events) {
      let cycle = Math.ceil((this.loopSchedUpTo - start - ev.posInLoop) / len);
      let t = start + cycle * len + ev.posInLoop;
      while (t <= this.loopSchedUpTo) {
        cycle++;
        t = start + cycle * len + ev.posInLoop;
      }
      while (t <= target) {
        this._fireLoopEvent(ev, t);
        cycle++;
        t = start + cycle * len + ev.posInLoop;
      }
    }
    this.loopSchedUpTo = target;
  }

  _fireLoopEvent(ev, hostTime) {
    const now = this.clock.ctx.currentTime;
    let when = this.clock.hostToAudio(hostTime);
    if (when < now + 0.005) when = now + 0.02;
    const id = "LP" + ev.instrument + ev.note;
    if (ev.on)
      this.synth.noteOn(id, ev.note, ev.velocity, when, {
        instrument: ev.instrument,
        pan: -0.25,
      });
    else this.synth.noteOff(id, when);
    // 相手にも通常のノートとして送る（1小節遅れて届く）
    const { bar, pos } = this.position(hostTime);
    this.conn.send({
      type: "note",
      on: ev.on,
      note: ev.note,
      velocity: ev.velocity,
      instrument: ev.instrument,
      barIndex: bar,
      posInBar: pos,
    });
    this.onLoopNote(ev.on, ev.note);
  }

  stop() {
    this.running = false;
    if (this.schedTimer) clearInterval(this.schedTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
  }
}
