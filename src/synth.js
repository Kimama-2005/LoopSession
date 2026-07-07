import { DRUM_MAP, playDrum } from "./drums.js";

// 音程を持つ楽器の定義。octave はキーボードのノート番号に足す半音（ベースは2オクターブ下げ）。
const PITCHED = {
  keys: { octave: 0, timbre: "triangle", cutoff: 0, gain: 0.3 },
  bass: { octave: -24, timbre: "sawtooth", cutoff: 500, gain: 0.34 },
};

// ノートは id (例 "L60"=自分のC4, "R60"=相手のC4) で管理する簡易ポリシンセ。
// noteOn の opts で楽器(instrument)とパン(pan)を指定。ドラムは1ショット（noteOff不要）。
export class Synth {
  constructor(ctx) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(ctx.destination);
    this.voices = new Map(); // id -> {osc, gain}
  }

  static freq(note) {
    return 440 * Math.pow(2, (note - 69) / 12);
  }

  _panNode(pan) {
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(this.master);
    return p;
  }

  noteOn(id, note, velocity, when, opts = {}) {
    const { instrument = "keys", pan = 0 } = opts;

    if (instrument === "drums") {
      const piece = DRUM_MAP.get(note);
      if (piece) playDrum(this.ctx, this._panNode(pan), piece.name, velocity, when);
      return;
    }

    // 音程楽器（keys / bass）
    this.noteOff(id, when); // 再トリガー時の保険
    const cfg = PITCHED[instrument] || PITCHED.keys;
    const osc = this.ctx.createOscillator();
    osc.type = cfg.timbre;
    osc.frequency.setValueAtTime(Synth.freq(note + cfg.octave), when);

    let tail = osc;
    if (cfg.cutoff) {
      const filter = this.ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = cfg.cutoff;
      osc.connect(filter);
      tail = filter;
    }

    const gain = this.ctx.createGain();
    const peak = cfg.gain * Math.max(0.15, velocity / 127);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak, when + 0.008);
    gain.gain.setTargetAtTime(peak * 0.7, when + 0.02, 0.35);
    tail.connect(gain).connect(this._panNode(pan));

    osc.start(when);
    this.voices.set(id, { osc, gain });
  }

  noteOff(id, when) {
    const v = this.voices.get(id);
    if (!v) return; // ドラム等（未保存）は何もしない
    this.voices.delete(id);
    v.gain.gain.cancelScheduledValues(when);
    v.gain.gain.setTargetAtTime(0.0001, when, 0.08);
    v.osc.stop(when + 0.6);
  }

  // メトロノーム
  click(when, accent) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.frequency.value = accent ? 1200 : 800;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(accent ? 0.35 : 0.18, when + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    osc.connect(gain).connect(this.master);
    osc.start(when);
    osc.stop(when + 0.06);
  }
}
