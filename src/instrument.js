// プラグイン音源ホスト。
// Web Audio Modules (WAM2) のインストゥルメントプラグインを URL から動的ロードし、
// MIDI (WebMIDI / PCキーボード) で演奏する。出力はエンジンの captureBus に合流するので
// ライン入力と同じ経路でループ録音できる。

const SDK_URL = 'https://mainline.i3s.unice.fr/wam2/packages/sdk/src/initializeWamHost.js';

// 動作確認済み (2026-07) のプリセットプラグイン
export const PLUGIN_PRESETS = [
  {
    id: 'obxd',
    name: 'OBXD — アナログ風ポリシンセ',
    url: 'https://mainline.i3s.unice.fr/wam2/packages/obxd/index.js',
  },
  {
    id: 'tinysynth',
    name: 'TinySynth — GM音源',
    url: 'https://mainline.i3s.unice.fr/wam2/packages/tinySynth/src/index.js',
  },
  {
    id: 'faustflute',
    name: 'Faust Flute — 笛 (物理モデル)',
    url: 'https://mainline.i3s.unice.fr/wam2/packages/faustFlute/index.js',
  },
];

export class InstrumentHost extends EventTarget {
  constructor(engine) {
    super();
    this.engine = engine;
    this.instance = null;
    this.node = null;
    this.currentUrl = null;
    this.loading = false;
    this._groupId = null;
    this._heldNotes = new Set();
    // 音源の音量（モニターと録音の両方に効く）
    this.gain = engine.ctx.createGain();
    this.gain.gain.value = 0.8;
    this.gain.connect(engine.captureBus); // 録音経路
    this.gain.connect(engine.master); // モニター（自分に聞こえる）
  }

  get active() {
    return !!this.node;
  }

  async load(url) {
    this.loading = true;
    this.dispatchEvent(new CustomEvent('change'));
    try {
      this.unload();
      if (!this._groupId) {
        const { default: initializeWamHost } = await import(SDK_URL);
        [this._groupId] = await initializeWamHost(this.engine.ctx);
      }
      const { default: WAM } = await import(url);
      this.instance = await WAM.createInstance(this._groupId, this.engine.ctx);
      this.node = this.instance.audioNode;
      this.node.connect(this.gain);
      this.currentUrl = url;
    } finally {
      this.loading = false;
      this.dispatchEvent(new CustomEvent('change'));
    }
  }

  unload() {
    this.allNotesOff();
    if (this.node) {
      try { this.node.disconnect(); } catch {}
      try { this.node.destroy?.(); } catch {}
    }
    this.node = null;
    this.instance = null;
    this.currentUrl = null;
    this.dispatchEvent(new CustomEvent('change'));
  }

  async createGui() {
    return this.instance ? this.instance.createGui() : null;
  }

  midi(bytes) {
    if (!this.node) return;
    this.node.scheduleEvents({
      type: 'wam-midi',
      time: this.engine.ctx.currentTime,
      data: { bytes },
    });
  }

  noteOn(note, vel = 100) {
    this._heldNotes.add(note);
    this.midi([0x90, note, vel]);
  }

  noteOff(note) {
    this._heldNotes.delete(note);
    this.midi([0x80, note, 64]);
  }

  allNotesOff() {
    for (const n of this._heldNotes) this.midi([0x80, n, 64]);
    this._heldNotes.clear();
    this.midi([0xb0, 123, 0]); // All Notes Off
  }

  setGain(v) {
    this.gain.gain.value = v;
  }
}

// ── MIDI 入力 (全デバイスを聴取) ─────────────────────────

export async function initMidi(onMessage, onStateChange) {
  if (!navigator.requestMIDIAccess) return null;
  const access = await navigator.requestMIDIAccess();
  const bind = () => {
    let count = 0;
    for (const input of access.inputs.values()) {
      input.onmidimessage = (e) => onMessage(Array.from(e.data));
      count++;
    }
    onStateChange(count);
  };
  access.onstatechange = bind;
  bind();
  return access;
}

// ── PC キーボード演奏 ────────────────────────────────────
// A W S E D F T G Y H U J K O L P で C から1オクターブ超、Z/X でオクターブ移動。

const KEYMAP = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6,
  KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13,
  KeyL: 14, KeyP: 15, Semicolon: 16,
};

export class PcKeyboard {
  constructor(inst) {
    this.inst = inst;
    this.enabled = false;
    this.octave = 4; // C4 = 60
    this._down = new Map(); // code -> note
    window.addEventListener('keydown', (e) => this._onKey(e, true));
    window.addEventListener('keyup', (e) => this._onKey(e, false));
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) {
      for (const note of this._down.values()) this.inst.noteOff(note);
      this._down.clear();
    }
  }

  _onKey(e, down) {
    if (!this.enabled || e.repeat) return;
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
    if (down && e.code === 'KeyZ') { this.octave = Math.max(0, this.octave - 1); return; }
    if (down && e.code === 'KeyX') { this.octave = Math.min(8, this.octave + 1); return; }
    const semitone = KEYMAP[e.code];
    if (semitone === undefined) return;
    e.preventDefault();
    if (down) {
      if (this._down.has(e.code)) return;
      const note = Math.min(127, (this.octave + 1) * 12 + semitone);
      this._down.set(e.code, note);
      this.inst.noteOn(note, 100);
    } else {
      const note = this._down.get(e.code);
      if (note !== undefined) {
        this._down.delete(e.code);
        this.inst.noteOff(note);
      }
    }
  }
}
