// プラグイン音源ホスト。
// Web Audio Modules (WAM2) のインストゥルメントプラグインを URL から動的ロードし、
// MIDI (WebMIDI / PCキーボード) で演奏する。出力はエンジンの captureBus に合流するので
// ライン入力と同じ経路でループ録音できる。

// SDK とプリセットプラグインはリポジトリに同梱（vendor/wam/）。
// 以前は mainline.i3s.unice.fr（大学サーバー）から読んでいたが、
// 落ちていることがあるため同一オリジン配信に切り替えた。
// 出所: github.com/webaudiomodules/wam-examples@2179e50 + sdk@d425ee7
const SDK_URL = new URL('../vendor/wam/sdk/src/initializeWamHost.js', import.meta.url).href;

export const PLUGIN_PRESETS = [
  {
    id: 'soundfont',
    name: 'Soundfont — リアル系GM音源（ピアノ/ギター等・音色データは要ネット）',
    url: new URL('../vendor/wam/soundfont/index.js', import.meta.url).href,
  },
  {
    id: 'tinysynth',
    name: 'TinySynth — GM音源（軽量・ドラムあり・オフライン可）',
    url: new URL('../vendor/wam/tinySynth/src/index.js', import.meta.url).href,
  },
  {
    id: 'obxd',
    name: 'OBXD — アナログ風ポリシンセ',
    url: new URL('../vendor/wam/obxd/index.js', import.meta.url).href,
  },
  {
    id: 'faustflute',
    name: 'Faust Flute — 笛 (物理モデル)',
    url: new URL('../vendor/wam/faustFlute/index.js', import.meta.url).href,
  },
];

// GMプログラム番号 → midi-js-soundfonts の音色名（Soundfont プリセット用）
const GM_TO_SF = {
  0: 'acoustic_grand_piano', 1: 'bright_acoustic_piano', 4: 'electric_piano_1',
  5: 'electric_piano_2', 6: 'harpsichord', 7: 'clavinet',
  11: 'vibraphone', 12: 'marimba', 13: 'xylophone',
  16: 'drawbar_organ', 17: 'percussive_organ', 19: 'church_organ', 21: 'accordion',
  24: 'acoustic_guitar_nylon', 25: 'acoustic_guitar_steel', 26: 'electric_guitar_jazz',
  27: 'electric_guitar_clean', 28: 'electric_guitar_muted', 29: 'overdriven_guitar',
  30: 'distortion_guitar',
  32: 'acoustic_bass', 33: 'electric_bass_finger', 34: 'electric_bass_pick',
  35: 'fretless_bass', 36: 'slap_bass_1', 38: 'synth_bass_1',
  40: 'violin', 42: 'cello', 46: 'orchestral_harp',
  48: 'string_ensemble_1', 49: 'string_ensemble_2',
  56: 'trumpet', 57: 'trombone', 61: 'brass_section',
  64: 'soprano_sax', 66: 'tenor_sax', 71: 'clarinet',
  73: 'flute', 75: 'pan_flute', 79: 'ocarina',
  80: 'lead_1_square', 81: 'lead_2_sawtooth', 88: 'pad_1_new_age', 90: 'pad_3_polysynth',
  104: 'sitar', 114: 'steel_drums',
};

// GM 音色（TinySynth 用の抜粋リスト。value はプログラム番号、'drums' は ch10）
export const GM_VOICES = [
  ['ピアノ・鍵盤', [
    [0, 'グランドピアノ'], [1, 'ブライトピアノ'], [4, 'エレピ 1'], [5, 'エレピ 2'],
    [6, 'ハープシコード'], [7, 'クラビ'],
  ]],
  ['オルガン', [
    [16, 'ドローバーオルガン'], [17, 'パーカッシブオルガン'], [19, 'チャーチオルガン'],
    [21, 'アコーディオン'],
  ]],
  ['ギター', [
    [24, 'ナイロンギター'], [25, 'スチールギター'], [26, 'ジャズギター'],
    [27, 'クリーンギター'], [28, 'ミュートギター'], [29, 'オーバードライブギター'],
    [30, 'ディストーションギター'],
  ]],
  ['ベース', [
    [32, 'アコースティックベース'], [33, 'フィンガーベース'], [34, 'ピックベース'],
    [35, 'フレットレスベース'], [36, 'スラップベース'], [38, 'シンセベース 1'],
  ]],
  ['ストリングス・ブラス', [
    [40, 'バイオリン'], [42, 'チェロ'], [48, 'ストリングス'], [49, 'スロウストリングス'],
    [56, 'トランペット'], [57, 'トロンボーン'], [61, 'ブラスセクション'],
    [64, 'ソプラノサックス'], [66, 'テナーサックス'],
  ]],
  ['笛・リード', [
    [71, 'クラリネット'], [73, 'フルート'], [75, 'パンフルート'], [79, 'オカリナ'],
  ]],
  ['シンセ・その他', [
    [80, 'シンセリード(矩形波)'], [81, 'シンセリード(ノコギリ波)'], [88, 'ニューエイジパッド'],
    [90, 'ポリシンセパッド'], [11, 'ヴィブラフォン'], [12, 'マリンバ'], [13, 'シロフォン'],
    [46, 'ハープ'], [104, 'シタール'], [114, 'スチールドラム'],
  ]],
  ['ドラム', [
    ['drums', 'ドラムキット (ch10)'],
  ]],
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
    this._loadSeq = 0; // 並行ロードの競合防止（最後に要求されたものが勝つ）
    this.drumMode = false; // GM音源用: ノートを ch10(ドラム) に送る
    // 音源の音量（モニターと録音の両方に効く）
    this.gain = engine.ctx.createGain();
    this._sliderGain = 0.8;
    this._makeup = 1; // 音源ごとの基準音量差の補正（Soundfont は素材が小さい）
    this.gain.gain.value = this._sliderGain;
    this.gain.connect(engine.captureBus); // 録音経路
    this.gain.connect(engine.master); // モニター（自分に聞こえる）
  }

  _applyGain() {
    this.gain.gain.value = this._sliderGain * this._makeup;
  }

  get active() {
    return !!this.node;
  }

  async load(url) {
    const seq = ++this._loadSeq;
    this.loading = true;
    this.dispatchEvent(new CustomEvent('change'));
    try {
      this.unload();
      if (!this._groupId) {
        const { default: initializeWamHost } = await import(SDK_URL);
        [this._groupId] = await initializeWamHost(this.engine.ctx);
      }
      const { default: WAM } = await import(url);
      const instance = await WAM.createInstance(this._groupId, this.engine.ctx);
      if (seq !== this._loadSeq) {
        // このロード中に別のロードが始まった。古い方は破棄する
        try { instance.audioNode.destroy?.(); } catch {}
        return;
      }
      this.instance = instance;
      this.node = instance.audioNode;
      this.node.connect(this.gain);
      this.currentUrl = url;
      this._makeup = this.kind === 'soundfont' ? 4 : 1;
      this._applyGain();
    } finally {
      if (seq === this._loadSeq) {
        this.loading = false;
        this.dispatchEvent(new CustomEvent('change'));
      }
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
    // ドラムモード時はノート/CC系を ch10(インデックス9) に付け替える（GM音源用）
    if (this.drumMode && bytes.length && (bytes[0] & 0xf0) >= 0x80 && (bytes[0] & 0xf0) <= 0xb0) {
      bytes = [(bytes[0] & 0xf0) | 9, ...bytes.slice(1)];
    }
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

  // GM プログラムチェンジ（TinySynth 等の GM 音源用）
  programChange(prog) {
    this.midi([0xc0, prog & 0x7f]);
  }

  setDrumMode(on) {
    this.allNotesOff();
    this.drumMode = on;
  }

  // 読み込み中プラグインの種別（音色UIの出し分け用）
  get kind() {
    if (!this.currentUrl) return null;
    if (this.currentUrl.includes('tinySynth')) return 'gm';
    if (this.currentUrl.includes('soundfont')) return 'soundfont';
    return 'plugin';
  }

  // GM音色を切り替える。TinySynth はプログラムチェンジ、
  // Soundfont は state 経由（音色サンプルの取得に数秒かかる）。
  // 対応できない選択（Soundfont にドラムは無い等）は false を返す。
  async setGmVoice(v) {
    if (!this.node) return true;
    if (this.kind === 'soundfont') {
      if (v === 'drums') return false;
      const name = GM_TO_SF[+v];
      if (!name) return false;
      this.setDrumMode(false);
      await this.instance.audioNode.setState({ instrument: name });
      return true;
    }
    if (v === 'drums') {
      this.setDrumMode(true);
      return true;
    }
    this.setDrumMode(false);
    this.programChange(+v);
    return true;
  }

  setGain(v) {
    this._sliderGain = v;
    this._applyGain();
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
