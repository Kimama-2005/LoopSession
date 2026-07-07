import { PeerConnection } from "./connection.js";
import { Session } from "./session.js";
import { Synth } from "./synth.js";
import { initKeyboard, initMidi, KEYMAP } from "./input.js";
import { DRUM_MAP } from "./drums.js";

const $ = (id) => document.getElementById(id);
function log(s) {
  const el = $("log");
  el.textContent = `[${new Date().toLocaleTimeString()}] ${s}\n` + el.textContent;
}

let ctx = null;
let conn = null;
let session = null;
let previewSynth = null; // 接続前の試聴用
let currentInstrument = "keys";
let loopBarsPref = 1;

function ensureAudio() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

function wireSession() {
  session.instrument = currentInstrument;
  session.loop.bars = loopBarsPref;
  session.onLog = log;
  session.onSync = () => {
    $("syncInfo").textContent = `同期: offset ${session.clock.hostOffset.toFixed(0)}ms / rtt ${session.bestRtt.toFixed(0)}ms`;
  };
  session.onRemoteNote = (on, note) => highlight(note, on);
  session.onLoopNote = (on, note) => highlight(note, on);
  session.onLoopState = (state, label) => {
    $("loopState").textContent = "ループ: " + label;
    const rec = state === "recording" || state === "armed";
    $("btnRec").classList.toggle("recording", rec);
  };
  session.audio.onLevel = (peak) => {
    $("levelBar").style.width = Math.min(100, peak * 140).toFixed(0) + "%";
  };
}

// 相手なしでメトロノーム＋ルーパーを動かすソロモード
function startSolo() {
  if (session) return;
  const audio = ensureAudio();
  const stub = {
    send() {}, sendAudio() {}, onMessage() {}, onAudio() {}, onOpen() {}, onState() {},
  };
  session = new Session("host", stub, audio);
  wireSession();
  session.setConfig({
    bpm: Number($("bpm").value) || 120,
    beatsPerBar: Number($("beats").value) || 4,
    delayBars: Number($("delay").value) || 1,
    sessionStart: performance.now(),
  });
  session.startTransport();
  $("status").textContent = "ソロ (メトロノーム動作中)";
  log("ソロ開始");
}

// ---- ホスト ----
async function startHost() {
  const audio = ensureAudio();
  conn = new PeerConnection();
  session = new Session("host", conn, audio);
  wireSession();
  conn.onState = (s) => log("connection: " + s);
  conn.onOpen = () => {
    log("data channel open");
    const cfg = {
      bpm: Number($("bpm").value) || 120,
      beatsPerBar: Number($("beats").value) || 4,
      delayBars: Number($("delay").value) || 1,
      sessionStart: performance.now(),
    };
    session.setConfig(cfg);
    session.startTransport();
    $("status").textContent = "接続済み (ホスト)";
  };
  const offer = await conn.createOffer();
  $("offerOut").value = offer;
  log("オファー生成 — 相手に送ってください");
}

async function acceptAnswer() {
  if (!conn) return alert("先にオファーを作成してください");
  const code = $("answerIn").value.trim();
  if (!code) return alert("相手のアンサーを貼ってください");
  await conn.acceptAnswer(code);
  log("アンサー取り込み — 接続中…");
}

// ---- 参加者 ----
async function startClient() {
  const audio = ensureAudio();
  conn = new PeerConnection();
  session = new Session("client", conn, audio);
  wireSession();
  conn.onState = (s) => log("connection: " + s);
  conn.onOpen = () => {
    log("data channel open");
    $("status").textContent = "接続済み (参加者) — 同期中…";
  };
  const offer = $("offerIn").value.trim();
  if (!offer) return alert("ホストのオファーを貼ってください");
  const answer = await conn.createAnswer(offer);
  $("answerOut").value = answer;
  log("アンサー生成 — ホストに送り返してください");
}

// ---- 楽器モード ----
function setInstrument(mode) {
  currentInstrument = mode;
  if (session) session.instrument = mode;
  document.querySelectorAll("#modes .mode").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === mode)
  );
  relabelKeyboard(mode);
}

// ---- オーディオ ----
async function refreshAudioDevices() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const sel = $("audioDevice");
    const cur = sel.value;
    sel.innerHTML = "";
    devs
      .filter((d) => d.kind === "audioinput")
      .forEach((d, i) => {
        const o = document.createElement("option");
        o.value = d.deviceId;
        o.textContent = d.label || "入力 " + (i + 1);
        sel.appendChild(o);
      });
    if (cur) sel.value = cur;
  } catch (e) {
    /* enumerateDevices 非対応/不許可時は無視 */
  }
}

async function toggleAudio() {
  if (!session) startSolo(); // 未接続なら自動でソロ開始
  const link = session.audio;
  if (!link.enabled) {
    try {
      await link.enable($("audioDevice").value || undefined);
      $("btnAudio").textContent = "⏹ 音声オフ";
      $("btnAudio").classList.add("on");
      $("audioStatus").textContent =
        "入力キャプチャ中 — 相手へ1小節遅れで送信（ヘッドホン推奨）";
      refreshAudioDevices(); // 許可後はラベルが取得できる
    } catch (e) {
      $("audioStatus").textContent = "マイク/入力の取得に失敗: " + e.message;
    }
  } else {
    link.disable();
    $("btnAudio").textContent = "🎤 音声オン";
    $("btnAudio").classList.remove("on");
    $("audioStatus").textContent = "停止しました";
    $("levelBar").style.width = "0%";
  }
}

// ---- 鍵盤 UI ----
const noteToEl = new Map();
const BLACKS = new Set([61, 63, 66, 68, 70]);

function buildKeyboard() {
  const kb = $("keyboard");
  const entries = Object.entries(KEYMAP).sort((a, b) => a[1] - b[1]);
  for (const [key, note] of entries) {
    const el = document.createElement("div");
    el.className = "key" + (BLACKS.has(note) ? " black" : "");
    el.textContent = key.toUpperCase();
    el.dataset.note = note;
    el.dataset.key = key;
    el.addEventListener("mousedown", () => play(note, true));
    el.addEventListener("mouseup", () => play(note, false));
    el.addEventListener("mouseleave", () => play(note, false));
    kb.appendChild(el);
    noteToEl.set(note, el);
  }
  relabelKeyboard(currentInstrument);
}

function relabelKeyboard(mode) {
  const drums = mode === "drums";
  noteToEl.forEach((el, note) => {
    if (drums) {
      const p = DRUM_MAP.get(note);
      el.textContent = p ? p.label : "";
      el.classList.remove("black");
      el.classList.add("drum");
    } else {
      el.textContent = el.dataset.key.toUpperCase();
      el.classList.remove("drum");
      el.classList.toggle("black", BLACKS.has(note));
    }
  });
}

function highlight(note, on) {
  const el = noteToEl.get(note);
  if (el) el.classList.toggle("on", on);
}

function play(note, on) {
  highlight(note, on);
  if (session && session.config) {
    session.localNote(on, note, on ? 100 : 0);
  } else {
    // 接続前の試聴（自分だけ鳴らす）
    const audio = ensureAudio();
    if (!previewSynth) previewSynth = new Synth(audio);
    const when = audio.currentTime + 0.01;
    const opts = { instrument: currentInstrument, pan: 0 };
    if (on) previewSynth.noteOn("P" + note, note, 100, when, opts);
    else previewSynth.noteOff("P" + note, when);
  }
}

// ---- 起動 ----
function boot() {
  buildKeyboard();
  $("btnHost").onclick = startHost;
  $("btnClient").onclick = startClient;
  $("btnAccept").onclick = acceptAnswer;
  document.querySelectorAll("#modes .mode").forEach((b) => {
    b.onclick = () => setInstrument(b.dataset.mode);
  });

  // ルーパー
  $("btnSolo").onclick = startSolo;
  $("loopBars").onchange = (e) => {
    loopBarsPref = Number(e.target.value);
    if (session) session.setLoopBars(loopBarsPref);
  };
  $("btnRec").onclick = () => {
    if (!session) startSolo(); // 未接続なら自動でソロ開始
    session.armRecord();
  };
  $("btnClear").onclick = () => {
    if (session) session.clearLoop();
  };

  // オーディオ
  refreshAudioDevices();
  $("btnAudioRefresh").onclick = refreshAudioDevices;
  $("btnAudio").onclick = toggleAudio;

  initKeyboard((on, note) => play(note, on));
  initMidi(
    (on, note, vel) => {
      highlight(note, on);
      if (session && session.config) session.localNote(on, note, vel);
      else {
        const audio = ensureAudio();
        if (!previewSynth) previewSynth = new Synth(audio);
        const when = audio.currentTime + 0.01;
        const opts = { instrument: currentInstrument, pan: 0 };
        if (on) previewSynth.noteOn("P" + note, note, vel, when, opts);
        else previewSynth.noteOff("P" + note, when);
      }
    },
    (names) => {
      if (names === null) $("midiInfo").textContent = "MIDI: 非対応ブラウザ";
      else if (names.length === 0) $("midiInfo").textContent = "MIDI: デバイスなし";
      else $("midiInfo").textContent = "MIDI: " + names.join(", ");
    }
  );

  const raf = () => {
    if (session && session.config) {
      const p = session.position(session.clock.hostNow());
      $("meter").textContent = `bar ${p.bar}  beat ${p.beat + 1}/${session.config.beatsPerBar}`;
    }
    requestAnimationFrame(raf);
  };
  raf();
}

boot();
