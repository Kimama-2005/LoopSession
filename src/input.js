// 入力源: PCキーボード (鍵盤代わり) と Web MIDI。
// どちらも onNote(on:boolean, note:number, velocity:number) を呼ぶ。

// C4(60) から始まるピアノ配列
export const KEYMAP = {
  a: 60, w: 61, s: 62, e: 63, d: 64, f: 65,
  t: 66, g: 67, y: 68, h: 69, u: 70, j: 71, k: 72,
};

export function initKeyboard(onNote) {
  const held = new Set();
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    const n = KEYMAP[e.key.toLowerCase()];
    if (n === undefined || held.has(n)) return;
    // 入力欄にフォーカス中は無視
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "TEXTAREA" || tag === "INPUT") return;
    held.add(n);
    onNote(true, n, 100);
  });
  window.addEventListener("keyup", (e) => {
    const n = KEYMAP[e.key.toLowerCase()];
    if (n === undefined) return;
    held.delete(n);
    onNote(false, n, 0);
  });
}

export async function initMidi(onNote, onInputs) {
  if (!("requestMIDIAccess" in navigator)) {
    onInputs(null); // 非対応
    return;
  }
  try {
    const access = await navigator.requestMIDIAccess({ sysex: false });
    const attach = () => {
      const names = [];
      access.inputs.forEach((inp) => {
        names.push(inp.name);
        inp.onmidimessage = (ev) => {
          const [st, d1, d2] = ev.data;
          const cmd = st & 0xf0;
          if (cmd === 0x90 && d2 > 0) onNote(true, d1, d2);
          else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) onNote(false, d1, 0);
        };
      });
      onInputs(names);
    };
    attach();
    access.onstatechange = attach;
  } catch (err) {
    onInputs([]);
  }
}
