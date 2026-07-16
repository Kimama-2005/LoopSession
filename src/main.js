// LoopSession — P2P オンラインルーパー
// アプリ全体の配線: UI・トラック管理・P2P プロトコル。
//
// 同期の考え方: リアルタイム送信はせず、録音が完了したループ(PCM)を
// DataChannel で転送し、受信側が共有クロックのグリッドへ位相整列して再生する。
// これによりネットワーク遅延はループ到着の遅れ（次の周回で吸収）にしかならない。

import { SharedClock, AudioEngine, encodeWav } from './engine.js';
import { Track } from './track.js';
import { P2P, encodePcm16, decodePcm16 } from './p2p.js';
import { InstrumentHost, PLUGIN_PRESETS, initMidi, PcKeyboard } from './instrument.js';
import { LiveSend, LiveReceive } from './live.js';
import { Signal, genRoomCode } from './signal.js';

const $ = (id) => document.getElementById(id);

const TRACK_COLORS = ['#ff5e5b', '#ffb400', '#37d67a', '#4bb8ff', '#b98cff', '#ff7ad9'];
const START_LEAD_MS = 300; // トランスポート開始の先読み（相手への伝搬猶予）

const clock = new SharedClock();
const engine = new AudioEngine(clock);
const p2p = new P2P(clock);

const myPeerId = Math.random().toString(16).slice(2, 6);
let myName = localStorage.getItem('ls-name') || `Player-${myPeerId}`;
const peerNames = new Map(); // peerId → 名前（自分以外の全参加者）
let trackSeq = 0;
let colorSeq = 0;

// ホストが他のゲストへ中継する制御メッセージ
const RELAY_TYPES = new Set([
  'transport', 'bpm', 'track-add', 'track-len', 'track-clear',
  'track-remove', 'layer-remove', 'live-state', 'peer-name', 'track-rename',
]);

function ownerLabel(ownerId) {
  return peerNames.get(ownerId) || 'PEER';
}

// ホストのミックス（音量/ミュート）に従うか（設定で切替・保存）
let mixFollow = localStorage.getItem('ls-mix-follow') !== '0';

// ホストの音量/ミュート操作を全員へ配信する
function sendMix(track) {
  if (p2p.role !== 'host' || !p2p.isOpen()) return;
  p2p.send({ t: 'mix', trackId: track.id, gain: track.gain, muted: track.muted });
}

function setTrackNameEl(el, track) {
  const nameEl = el.querySelector('.tname');
  if (nameEl.tagName === 'INPUT') nameEl.value = track.name;
  else nameEl.textContent = track.name;
}

// trackId -> { track, el, canvas, playhead, recShade, emptyLabel, ... }
const tracks = new Map();

// ───────────────────────── 起動 ─────────────────────────

$('startBtn').addEventListener('click', async () => {
  $('startBtn').disabled = true;
  try {
    await engine.init();
  } catch (err) {
    alert('オーディオの初期化に失敗しました: ' + err.message);
    return;
  }
  $('startOverlay').remove();
  initTransportUI();
  initConnUI();
  initSettingsUI();
  initSynthUI();
  initModeTabs();
  initLiveUI();
  await initInput();
  addLocalTrack();
  requestAnimationFrame(rafLoop);
});

// ───────────────────────── モード切替 ─────────────────────────

function initModeTabs() {
  for (const b of $('modeTabs').querySelectorAll('button')) {
    b.addEventListener('click', () => setMode(b.dataset.mode));
  }
}

function setMode(mode) {
  for (const b of $('modeTabs').querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.mode === mode);
  }
  const looper = mode === 'looper';
  $('tracks').hidden = !looper;
  $('addTrackBtn').hidden = !looper;
  $('liveSec').hidden = looper;
}

// ───────────────────────── LIVE モード ─────────────────────────

let liveSend = null;
let liveRecv = null;

function initLiveUI() {
  liveSend = new LiveSend(engine, p2p, myPeerId);
  liveRecv = new LiveReceive(engine);

  $('liveBtn').addEventListener('click', () => {
    if (!liveSend.enabled) {
      if (!p2p.isOpen()) {
        $('liveStatus').textContent = 'P2P接続してからLIVE送信を開始してください。';
        return;
      }
      if (!engine.hasInput() && !(instrument && instrument.active)) {
        $('liveStatus').textContent = 'LIVE送信にはライン入力かプラグイン音源が必要です。';
        return;
      }
      if (!engine.running) startTransport(true);
    }
    liveSend.setEnabled(!liveSend.enabled);
    updateLiveUI();
  });
  $('liveDelaySel').addEventListener('change', () => liveSend.setDelay(+$('liveDelaySel').value));
  $('liveRecvVol').addEventListener('input', () => liveRecv.setGain(+$('liveRecvVol').value));
  liveRecv.addEventListener('change', updateLiveUI);
  updateLiveUI();
}

function updateLiveUI() {
  const btn = $('liveBtn');
  btn.textContent = liveSend.enabled ? 'LIVE送信 ON' : 'LIVE送信 OFF';
  btn.classList.toggle('on', liveSend.enabled);
  $('modeTabs').querySelector('[data-mode="live"]').classList.toggle('live-on', liveSend.enabled);
  const senders = [...liveRecv.states.entries()].filter(([, s]) => s.on);
  $('liveStatus').textContent = senders.length
    ? `受信中のLIVE: ${senders.map(([id, s]) => `${ownerLabel(id)}（${s.delayBars}小節遅れ）`).join(', ')}`
    : '相手からのLIVE送信: OFF';
}

// ───────────────────────── 入力 ─────────────────────────

async function initInput() {
  // 入力ゲイン（環境ごとの音量差の調整。localStorage に保存）
  const savedGain = parseFloat(localStorage.getItem('ls-input-gain'));
  if (!isNaN(savedGain)) {
    engine.setInputGain(savedGain);
    $('inputGainSlider').value = savedGain;
  }
  const showGain = () => {
    $('inputGainVal').textContent = `${Math.round(engine.inputGain.gain.value * 100)}%`;
  };
  $('inputGainSlider').addEventListener('input', () => {
    const v = +$('inputGainSlider').value;
    engine.setInputGain(v);
    localStorage.setItem('ls-input-gain', v);
    showGain();
  });
  showGain();

  try {
    await engine.selectInput(null);
    warnInput('');
  } catch (err) {
    warnInput('入力デバイスを開けませんでした（権限拒否 or 未接続）。受信・再生のみ可能です。');
  }
  await refreshDevices();
  navigator.mediaDevices.addEventListener('devicechange', refreshDevices);

  // 前回の出力先を復元
  const savedOut = localStorage.getItem('ls-output');
  if (savedOut && engine.canSetOutput()) {
    const outSel = $('outputSel');
    if ([...outSel.options].some((o) => o.value === savedOut)) {
      outSel.value = savedOut;
      engine.setOutput(savedOut).catch(() => {});
    }
  }

  $('deviceSel').addEventListener('change', async () => {
    try {
      await engine.selectInput($('deviceSel').value);
      warnInput('');
    } catch (err) {
      warnInput('このデバイスを開けませんでした: ' + err.message);
    }
    updateLatencyLabel();
  });

  $('monitorBtn').addEventListener('click', () => {
    const on = $('monitorBtn').classList.toggle('on');
    engine.setMonitor(on);
  });
}

async function refreshDevices() {
  const sel = $('deviceSel');
  const devices = await engine.listInputs();
  sel.innerHTML = '';
  devices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `入力デバイス ${i + 1}`;
    sel.appendChild(opt);
  });
  if (engine.inputDeviceId) sel.value = engine.inputDeviceId;

  // Master の出力先（設定パネル）
  const outSel = $('outputSel');
  outSel.innerHTML = '';
  if (!engine.canSetOutput()) {
    outSel.appendChild(new Option('このブラウザは未対応 (Chrome/Edge 110+)', ''));
    outSel.disabled = true;
  } else {
    outSel.appendChild(new Option('既定の出力', 'default'));
    const outs = await engine.listOutputs();
    outs.forEach((d, i) => {
      if (d.deviceId && d.deviceId !== 'default') {
        outSel.appendChild(new Option(d.label || `出力デバイス ${i + 1}`, d.deviceId));
      }
    });
    outSel.value = engine.outputDeviceId || 'default';
    if (outSel.selectedIndex < 0) outSel.value = 'default';
  }
}

function warnInput(text) {
  const el = $('inputWarn');
  el.textContent = text;
  el.hidden = !text;
}

// ─────────────────────── トランスポート ───────────────────────

function initTransportUI() {
  $('playBtn').addEventListener('click', () => startTransport(true));
  $('stopBtn').addEventListener('click', () => stopTransport(true));

  $('bpmInput').addEventListener('change', () => {
    const v = Math.min(240, Math.max(40, Math.round(+$('bpmInput').value) || 100));
    if (!tryChangeTempo(v, engine.beatsPerBar)) $('bpmInput').value = engine.bpm;
  });
  $('meterSel').addEventListener('change', () => {
    if (!tryChangeTempo(engine.bpm, +$('meterSel').value)) $('meterSel').value = engine.beatsPerBar;
  });

  $('metroBtn').addEventListener('click', () => {
    engine.setMetronome($('metroBtn').classList.toggle('on'));
  });

  engine.addEventListener('transport', onTransportChange);

  $('bounceBtn').addEventListener('click', toggleBounce);

  $('bpmInput').value = engine.bpm;
  rebuildLeds();
}

// ── バウンス（Master → WAV ダウンロード）──

const BOUNCE_MAX_SEC = 600; // 念のための上限（約10分 ≒ 100MB）

function toggleBounce() {
  if (engine.bounceActive()) {
    finishBounce();
  } else {
    engine.startBounce();
    $('bounceBtn').classList.add('rec');
  }
}

function finishBounce() {
  const data = engine.stopBounce();
  const btn = $('bounceBtn');
  btn.classList.remove('rec');
  btn.textContent = 'WAV';
  if (!data || data.frames === 0) return;
  const wav = encodeWav(data);
  const blob = new Blob([wav], { type: 'audio/wav' });
  const ts = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `loopsession-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.wav`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function startTransport(broadcast) {
  if (engine.running) return;
  engine.start(clock.now() + START_LEAD_MS);
  if (broadcast) p2p.send({ t: 'transport', running: true, startShared: engine.startShared });
}

function stopTransport(broadcast) {
  if (!engine.running) return;
  engine.stop();
  if (broadcast) p2p.send({ t: 'transport', running: false });
}

function onTransportChange() {
  $('playBtn').classList.toggle('active', engine.running);
  $('posDisplay').classList.toggle('stopped', !engine.running);
  for (const { track } of tracks.values()) {
    if (engine.running) track.onTransportStart();
    else track.onTransportStop();
  }
  if (!engine.running) {
    $('posDisplay').textContent = '--.-';
    for (const led of $('beatLeds').children) led.className = '';
  }
}

// テンポ変更は停止中のみ。既存ループは無効になるため確認して全消去する。
function tryChangeTempo(bpm, beatsPerBar) {
  if (engine.running) return false;
  if (bpm === engine.bpm && beatsPerBar === engine.beatsPerBar) return true;
  const hasLoops = [...tracks.values()].some((e) => e.track.layers.length);
  if (hasLoops && !confirm('テンポ/拍子を変えると全ループを消去します。よろしいですか？')) {
    return false;
  }
  applyTempo({ bpm, beatsPerBar }, hasLoops);
  p2p.send({ t: 'bpm', bpm, beatsPerBar });
  return true;
}

function applyTempo({ bpm, beatsPerBar }, clearLoops) {
  engine.bpm = bpm;
  engine.beatsPerBar = beatsPerBar;
  $('bpmInput').value = bpm;
  $('meterSel').value = beatsPerBar;
  rebuildLeds();
  if (clearLoops) for (const { track } of tracks.values()) track.clear();
}

function rebuildLeds() {
  const leds = $('beatLeds');
  leds.innerHTML = '';
  for (let i = 0; i < engine.beatsPerBar; i++) leds.appendChild(document.createElement('i'));
}

// ─────────────────────── トラック ───────────────────────

$('addTrackBtn').addEventListener('click', () => addLocalTrack());

function addLocalTrack() {
  const id = `${myPeerId}-T${++trackSeq}`;
  const track = new Track(engine, {
    id,
    ownerId: myPeerId,
    name: `TRACK ${trackSeq}`,
    lengthBars: 2,
    remote: false,
  });
  buildTrackRow(track);
  p2p.send({ t: 'track-add', trackId: id, name: track.name, lengthBars: track.lengthBars });
  return tracks.get(id);
}

function createRemoteTrack({ trackId, name, lengthBars }) {
  const track = new Track(engine, {
    id: trackId,
    ownerId: trackId.split('-')[0],
    name: name || 'REMOTE',
    lengthBars: lengthBars || 2,
    remote: true,
  });
  buildTrackRow(track);
  return tracks.get(trackId);
}

function buildTrackRow(track) {
  const color = TRACK_COLORS[colorSeq++ % TRACK_COLORS.length];
  const el = document.createElement('div');
  el.className = 'track' + (track.remote ? ' remote' : '');
  el.style.setProperty('--tcolor', color);
  el.innerHTML = `
    <div class="colorStrip"></div>
    <div class="body">
      <div class="trackHead">
        ${track.remote
          ? '<span class="tname"></span>'
          : '<input class="tname tnameEdit" maxlength="16" spellcheck="false" title="クリックして名前を変更">'}
        <span class="towner"></span>
        <select class="tlen" title="ループ長">
          <option value="1">1小節</option>
          <option value="2">2小節</option>
          <option value="4">4小節</option>
          <option value="8">8小節</option>
        </select>
        <span class="tstate">EMPTY</span>
        ${track.remote ? '' : '<button class="tdel" title="トラック削除">✕</button>'}
      </div>
      <div class="wave">
        <canvas></canvas>
        <div class="waveEmpty">NO LOOP</div>
        <div class="recShade"></div>
        <div class="playhead"></div>
      </div>
      <div class="tctl">
        ${track.remote ? '' : `
        <button class="trec" title="録音/オーバーダブ（次の小節頭から開始）">●</button>
        <button class="tundo" title="最後のレイヤーを取り消し">UNDO</button>
        <button class="tclear">CLEAR</button>`}
        <button class="tmute" title="ミュート">M</button>
        <input class="tvol" type="range" min="0" max="1.2" step="0.01" value="0.9" title="音量">
      </div>
    </div>`;

  setTrackNameEl(el, track);
  el.querySelector('.towner').textContent = track.remote ? ownerLabel(track.ownerId) : 'YOU';
  el.querySelector('.tlen').value = track.lengthBars;

  const entry = {
    track,
    el,
    color,
    canvas: el.querySelector('canvas'),
    playhead: el.querySelector('.playhead'),
    recShade: el.querySelector('.recShade'),
    emptyLabel: el.querySelector('.waveEmpty'),
    stateEl: el.querySelector('.tstate'),
    lenSel: el.querySelector('.tlen'),
    recBtn: el.querySelector('.trec'),
    undoBtn: el.querySelector('.tundo'),
    clearBtn: el.querySelector('.tclear'),
    muteBtn: el.querySelector('.tmute'),
    volSlider: el.querySelector('.tvol'),
  };
  tracks.set(track.id, entry);
  $('tracks').appendChild(el);

  // ── 操作（自分のトラックのみ録音系あり） ──
  entry.lenSel.addEventListener('change', () => {
    if (track.setLengthBars(+entry.lenSel.value)) {
      if (!track.remote) p2p.send({ t: 'track-len', trackId: track.id, lengthBars: track.lengthBars });
    } else {
      entry.lenSel.value = track.lengthBars;
    }
  });

  entry.muteBtn.addEventListener('click', () => {
    track.setMuted(entry.muteBtn.classList.toggle('on'));
    sendMix(track);
  });

  entry.volSlider.addEventListener('input', (e) => {
    track.setGain(+e.target.value);
    sendMix(track);
  });

  if (!track.remote) {
    const nameInput = el.querySelector('.tnameEdit');
    nameInput.addEventListener('change', () => {
      const v = nameInput.value.trim().slice(0, 16) || track.name;
      track.name = v;
      nameInput.value = v;
      p2p.send({ t: 'track-rename', trackId: track.id, name: v });
    });
  }

  if (!track.remote) {
    entry.recBtn.addEventListener('click', () => {
      if (!engine.hasInput() && !(instrument && instrument.active)) {
        warnInput('録音にはライン入力（INPUT）かプラグイン音源（音源）が必要です。');
        return;
      }
      if (!engine.running) {
        startTransport(true);
        track.arm(1); // 小節0はカウントイン
      } else {
        track.toggleRecord();
      }
    });
    entry.undoBtn.addEventListener('click', () => {
      const layer = track.undo();
      if (layer) p2p.send({ t: 'layer-remove', trackId: track.id, layerId: layer.id });
    });
    entry.clearBtn.addEventListener('click', () => {
      track.clear();
      p2p.send({ t: 'track-clear', trackId: track.id });
    });
    el.querySelector('.tdel').addEventListener('click', () => {
      if (track.layers.length && !confirm(`${track.name} を削除しますか？`)) return;
      removeTrack(track.id);
      p2p.send({ t: 'track-remove', trackId: track.id });
    });

    track.addEventListener('recorded', (e) => sendLayer(track, e.detail.layer));
  }

  track.addEventListener('layers', () => {
    drawWave(entry);
    updateTrackCtl(entry);
  });
  track.addEventListener('change', () => updateTrackCtl(entry));

  drawWave(entry);
  updateTrackCtl(entry);
  return entry;
}

function removeTrack(trackId) {
  const entry = tracks.get(trackId);
  if (!entry) return;
  entry.track.dispose();
  entry.el.remove();
  tracks.delete(trackId);
}

function updateTrackCtl(entry) {
  const t = entry.track;
  const st = entry.stateEl;
  st.className = 'tstate';
  if (t.state === 'empty') st.textContent = 'EMPTY';
  else if (t.state === 'armed') { st.textContent = 'ARMED'; st.classList.add('armed'); }
  else if (t.state === 'recording') { st.textContent = 'REC'; st.classList.add('rec'); }
  else { st.textContent = `PLAY ×${t.layers.length}`; st.classList.add('play'); }

  entry.lenSel.disabled = t.remote || t.layers.length > 0 || t.state !== 'empty';
  if (!t.remote) {
    entry.recBtn.className = 'trec' +
      (t.state === 'armed' ? ' armed' : t.state === 'recording' ? ' recording' : '');
    entry.undoBtn.disabled = !t.layers.length;
    entry.clearBtn.disabled = !t.layers.length && t.state === 'empty';
  }
}

// ─────────────────────── 波形表示 ───────────────────────

function drawWave(entry) {
  const { track, canvas } = entry;
  const dpr = devicePixelRatio || 1;
  const w = (canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr)));
  const h = (canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr)));
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, w, h);
  entry.emptyLabel.style.display = track.layers.length ? 'none' : '';

  // 小節の区切り線
  g.strokeStyle = 'rgba(255,255,255,0.08)';
  g.lineWidth = 1;
  for (let b = 1; b < track.lengthBars; b++) {
    const x = Math.round((b / track.lengthBars) * w) + 0.5;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
  }
  if (!track.layers.length) return;

  const peaks = new Float32Array(w);
  for (const layer of track.layers) {
    for (let c = 0; c < layer.buffer.numberOfChannels; c++) {
      const data = layer.buffer.getChannelData(c);
      const spc = data.length / w;
      const step = Math.max(1, Math.floor(spc / 64));
      for (let x = 0; x < w; x++) {
        let peak = 0;
        const end = Math.min(data.length, Math.floor((x + 1) * spc));
        for (let i = Math.floor(x * spc); i < end; i += step) {
          const v = Math.abs(data[i]);
          if (v > peak) peak = v;
        }
        if (peak > peaks[x]) peaks[x] = peak;
      }
    }
  }
  g.fillStyle = entry.color;
  g.globalAlpha = 0.85;
  const mid = h / 2;
  for (let x = 0; x < w; x++) {
    const y = Math.max(1, peaks[x] * mid);
    g.fillRect(x, mid - y, 1, y * 2);
  }
  g.globalAlpha = 1;
}

// ─────────────────────── 画面更新ループ ───────────────────────

function rafLoop() {
  requestAnimationFrame(rafLoop);
  // 入力メーター
  $('inputMeter').style.width = `${Math.min(1, engine.inputPeak) * 100}%`;

  // バウンス経過表示と上限での自動停止
  if (engine.bounceActive()) {
    const sec = engine.bounceSeconds();
    if (sec > BOUNCE_MAX_SEC) {
      finishBounce();
    } else {
      $('bounceBtn').textContent = `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
    }
  }

  // 小節.拍 表示と LED
  if (engine.running) {
    const pos = engine.posBars();
    if (pos >= 0) {
      const beat = Math.floor((pos % 1) * engine.beatsPerBar);
      $('posDisplay').textContent = `${Math.floor(pos) + 1}.${beat + 1}`;
      const leds = $('beatLeds').children;
      for (let i = 0; i < leds.length; i++) {
        leds[i].className = i === beat ? (beat === 0 ? 'hit head' : 'hit') : '';
      }
    }
  }

  // トラックのプレイヘッド・録音進捗
  for (const entry of tracks.values()) {
    const t = entry.track;
    if (t.state === 'recording') {
      const prog = Math.min(1, Math.max(0, (engine.posBars() - t.recStartBar) / t.lengthBars));
      entry.recShade.style.display = 'block';
      entry.recShade.style.width = `${prog * 100}%`;
    } else {
      entry.recShade.style.display = 'none';
    }
    const p = engine.running ? t.playPos() : null;
    if (p != null) {
      entry.playhead.style.display = 'block';
      entry.playhead.style.left = `${p * 100}%`;
    } else {
      entry.playhead.style.display = 'none';
    }
  }
}

// ─────────────────────── P2P 配線 ───────────────────────

function initConnUI() {
  $('nameInput').value = myName;
  $('nameInput').addEventListener('change', () => {
    myName = $('nameInput').value.trim() || myName;
    localStorage.setItem('ls-name', myName);
    p2p.send({ t: 'peer-name', peerId: myPeerId, name: myName });
    updatePeerList();
  });

  $('makeOfferBtn').addEventListener('click', async () => {
    setConnStatus('オファー作成中…（数秒かかることがあります）');
    try {
      $('localSig').value = await p2p.createOffer();
      setConnStatus('コードを相手に送り、返ってきたコードを下に貼って「受け取る」。');
    } catch (err) {
      setConnStatus('失敗: ' + err.message, 'err');
    }
  });

  $('acceptSigBtn').addEventListener('click', async () => {
    const text = $('remoteSig').value.trim();
    if (!text) return;
    try {
      const answer = await p2p.acceptRemote(text);
      if (answer) {
        $('localSig').value = answer;
        setConnStatus('応答コードを相手に送ってください。接続を待っています…', 'ok');
      } else {
        setConnStatus('接続中…', 'ok');
      }
    } catch (err) {
      setConnStatus('コードを読めませんでした: ' + err.message, 'err');
    }
  });

  $('copySigBtn').addEventListener('click', async () => {
    if (!$('localSig').value) return;
    await navigator.clipboard.writeText($('localSig').value);
    $('copySigBtn').textContent = 'コピーしました';
    setTimeout(() => ($('copySigBtn').textContent = 'コピー'), 1200);
  });

  $('hostRoomBtn').addEventListener('click', hostRoom);
  $('joinRoomBtn').addEventListener('click', joinRoom);
  $('roomInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinRoom();
  });
  $('copyRoomBtn').addEventListener('click', async () => {
    await navigator.clipboard.writeText(roomCode || '');
    $('copyRoomBtn').textContent = 'OK';
    setTimeout(() => ($('copyRoomBtn').textContent = 'コピー'), 1200);
  });

  p2p.addEventListener('status', updateBadge);
  p2p.addEventListener('open', (e) => onPeerOpen(e.detail.link));
  p2p.addEventListener('peer-close', (e) => onPeerClose(e.detail.link));
  p2p.addEventListener('msg', (e) => handleMsg(e.detail.m, e.detail.link));
  p2p.addEventListener('loop', (e) => handleLoop(e.detail));
  p2p.addEventListener('live', (e) => {
    liveRecv.onData(e.detail.data);
    // ホストは他のゲストへ中継（ヘッダに送信者IDが入っているのでそのまま流せる）
    if (p2p.role === 'host') p2p.sendLive(e.detail.data, e.detail.link);
  });
}

function setConnStatus(text, cls = '') {
  const el = $('connStatus');
  el.textContent = text;
  el.className = 'connStatus ' + cls;
}

// ─────────────── かんたん接続（ルームコード自動シグナリング） ───────────────

let signal = null;
let roomCode = null;
const signalPending = new Map(); // gid → {link, sdp}（ホスト側の応答待ち）

// ホスト: ルームを作って参加リクエストを待ち受ける（人数分自動で処理）
async function hostRoom() {
  try {
    $('hostRoomBtn').disabled = true;
    setConnStatus('ルーム作成中…');
    signal = new Signal();
    roomCode = genRoomCode();
    await signal.connect(roomCode);
    signal.addEventListener('msg', onSignalMsgHost);
    $('roomCodeDisp').textContent = roomCode;
    $('roomInfo').hidden = false;
    $('joinRoomBtn').disabled = true;
    setConnStatus('ルームを開きました。コードを参加者に伝えてください。参加は自動で受け付けます。', 'ok');
  } catch (err) {
    $('hostRoomBtn').disabled = false;
    setConnStatus('自動接続を開始できませんでした: ' + (err && err.message || err) + '（下の手動接続を使ってください）', 'err');
  }
}

async function onSignalMsgHost(e) {
  const m = e.detail;
  if (m.t === 'join') {
    // 再送 join には同じオファーを返す
    const pending = signalPending.get(m.gid);
    if (pending) {
      signal.send({ t: 'offer', gid: m.gid, sdp: pending.sdp });
      return;
    }
    try {
      setConnStatus('参加リクエストを受信。接続準備中…');
      const { link, code } = await p2p.createOfferLink();
      signalPending.set(m.gid, { link, sdp: code });
      signal.send({ t: 'offer', gid: m.gid, sdp: code });
    } catch (err) {
      setConnStatus('接続準備に失敗: ' + (err && err.message || err), 'err');
    }
  } else if (m.t === 'answer') {
    const pending = signalPending.get(m.gid);
    if (!pending) return;
    signalPending.delete(m.gid);
    try {
      await p2p.acceptAnswerFor(pending.link, m.sdp);
      setConnStatus('接続処理中…');
    } catch (err) {
      setConnStatus('接続に失敗: ' + (err && err.message || err), 'err');
    }
  }
}

// ゲスト: コードを入れてルームに参加
async function joinRoom() {
  const code = $('roomInput').value.trim().toUpperCase();
  if (code.length < 4) {
    setConnStatus('ルームコードを入力してください。', 'err');
    return;
  }
  try {
    $('joinRoomBtn').disabled = true;
    $('hostRoomBtn').disabled = true;
    setConnStatus('ルームに接続中…');
    signal = new Signal();
    await signal.connect(code);
    const gid = Math.random().toString(36).slice(2, 8);
    let gotOffer = false;
    signal.addEventListener('msg', async (e) => {
      const m = e.detail;
      if (m.t !== 'offer' || m.gid !== gid || gotOffer) return;
      gotOffer = true;
      setConnStatus('ホストが見つかりました。接続中…');
      try {
        const answer = await p2p.acceptRemote(m.sdp);
        signal.send({ t: 'answer', gid, sdp: answer });
      } catch (err) {
        setConnStatus('接続に失敗: ' + (err && err.message || err), 'err');
        $('joinRoomBtn').disabled = false;
        $('hostRoomBtn').disabled = false;
      }
    });
    signal.send({ t: 'join', gid });
    // ホストからの応答がなければ数回再送してあきらめる
    let tries = 0;
    const retry = setInterval(() => {
      if (gotOffer || p2p.isOpen()) {
        clearInterval(retry);
        return;
      }
      if (++tries > 6) {
        clearInterval(retry);
        setConnStatus('ホストが見つかりません。コードを確認してください。', 'err');
        $('joinRoomBtn').disabled = false;
        $('hostRoomBtn').disabled = false;
        return;
      }
      signal.send({ t: 'join', gid });
    }, 4000);
  } catch (err) {
    setConnStatus('自動接続に失敗: ' + (err && err.message || err) + '（下の手動接続を使ってください）', 'err');
    $('joinRoomBtn').disabled = false;
    $('hostRoomBtn').disabled = false;
  }
}

function updateBadge() {
  const badge = $('connBadge');
  const n = p2p.openLinks().length;
  if (n > 0) {
    const total = p2p.role === 'host' ? n : peerNames.size;
    badge.textContent = `⇄ ${Math.max(total, n)}人`;
    badge.title = [...peerNames.values()].join(', ');
    badge.className = 'badge on';
  } else {
    badge.textContent = 'OFFLINE';
    badge.className = 'badge off';
    if (peerNames.size) setConnStatus('切断されました。', 'err');
  }
  updatePeerList();
}

function updatePeerList() {
  const names = [...peerNames.values()];
  $('peerList').textContent = names.length
    ? `参加者: ${myName}（自分）, ${names.join(', ')}`
    : '';
}

function refreshOwnerLabels() {
  for (const { el, track } of tracks.values()) {
    if (track.remote) el.querySelector('.towner').textContent = ownerLabel(track.ownerId);
  }
}

// リンクの DataChannel が開いた（ゲスト側はクロック同期後に飛んでくる）
function onPeerOpen(link) {
  // ゲストはホストと繋がったらシグナリング(ブローカー)は不要
  if (p2p.role === 'guest' && signal) {
    signal.close();
    signal = null;
  }
  p2p.sendTo(link, { t: 'hello', peerId: myPeerId, name: myName });
  if (liveSend && liveSend.enabled) liveSend.sendState();
  updateBadge();
  if (p2p.role === 'host') {
    setConnStatus(signal
      ? '接続しました！ ルームは開いたままなので、追加の参加者も同じコードでOK。'
      : '接続しました！ さらに人数を増やすには再度「参加コードを作る」。', 'ok');
  } else {
    setConnStatus('接続しました！', 'ok');
  }
}

function onPeerClose(link) {
  if (link.peerId) {
    peerNames.delete(link.peerId);
    if (p2p.role === 'host') p2p.send({ t: 'peer-left', peerId: link.peerId });
  }
  updateBadge();
}

function handleMsg(m, link) {
  // ホストは制御メッセージを他のゲストへ中継する（スター型の要）
  if (p2p.role === 'host' && RELAY_TYPES.has(m.t)) {
    p2p.send(m, link);
  }
  switch (m.t) {
    case 'hello': {
      link.peerId = m.peerId;
      link.peerName = m.name;
      peerNames.set(m.peerId, m.name);
      updateBadge();
      refreshOwnerLabels();
      if (m.quiet) return; // 名前変更の再通知
      if (p2p.role === 'host') {
        // 新しい参加者を既存メンバーに紹介し、既存メンバーの名前を新参加者へ
        p2p.send({ t: 'peer-name', peerId: m.peerId, name: m.name }, link);
        for (const [id, name] of peerNames) {
          if (id !== m.peerId) p2p.sendTo(link, { t: 'peer-name', peerId: id, name });
        }
      }
      sendSnapshotTo(link, m.peerId);
      return;
    }
    case 'peer-name':
      peerNames.set(m.peerId, m.name);
      updateBadge();
      refreshOwnerLabels();
      return;
    case 'peer-left':
      peerNames.delete(m.peerId);
      updateBadge();
      return;
    case 'sync': {
      // 接続時にオファー側から届くテンポ/トランスポートの現状
      if (m.bpm !== engine.bpm || m.beatsPerBar !== engine.beatsPerBar) {
        applyTempo(m, true);
      }
      if (m.running) engine.start(m.startShared);
      return;
    }
    case 'transport':
      if (m.running) engine.start(m.startShared);
      else engine.stop();
      return;
    case 'bpm':
      applyTempo(m, true);
      return;
    case 'track-add':
      if (!tracks.has(m.trackId)) createRemoteTrack(m);
      return;
    case 'track-len': {
      const entry = tracks.get(m.trackId);
      if (entry && entry.track.setLengthBars(m.lengthBars)) {
        entry.lenSel.value = m.lengthBars;
        drawWave(entry);
      }
      return;
    }
    case 'track-clear':
      tracks.get(m.trackId)?.track.clear();
      return;
    case 'track-remove':
      removeTrack(m.trackId);
      return;
    case 'layer-remove':
      tracks.get(m.trackId)?.track.removeLayer(m.layerId);
      return;
    case 'live-state':
      liveRecv.setState(m);
      return;
    case 'track-rename': {
      const entry = tracks.get(m.trackId);
      if (!entry) return;
      entry.track.name = String(m.name).slice(0, 16);
      setTrackNameEl(entry.el, entry.track);
      return;
    }
    case 'mix': {
      // ホストのミックスを反映（設定でオフにしていれば無視）
      if (p2p.role === 'host' || !mixFollow) return;
      const entry = tracks.get(m.trackId);
      if (!entry) return;
      entry.track.setGain(m.gain);
      entry.track.setMuted(!!m.muted);
      entry.volSlider.value = m.gain;
      entry.muteBtn.classList.toggle('on', !!m.muted);
      return;
    }
  }
}

// 接続直後にそのリンクへ現状を送る。ホストはテンポ/走行状態と
// 自分が知る全トラック（他ゲストのぶんも代理送信）、ゲストは自分のトラックのみ。
function sendSnapshotTo(link, joinerId) {
  if (p2p.role === 'host') {
    p2p.sendTo(link, {
      t: 'sync',
      bpm: engine.bpm,
      beatsPerBar: engine.beatsPerBar,
      running: engine.running,
      startShared: engine.startShared,
    });
  }
  for (const { track } of tracks.values()) {
    if (track.ownerId === joinerId) continue; // 本人のトラックは送り返さない
    if (p2p.role !== 'host' && track.remote) continue;
    p2p.sendTo(link, {
      t: 'track-add', trackId: track.id, name: track.name, lengthBars: track.lengthBars,
    });
    for (const layer of track.layers) sendLayerTo(link, track, layer);
    if (p2p.role === 'host') {
      p2p.sendTo(link, { t: 'mix', trackId: track.id, gain: track.gain, muted: track.muted });
    }
  }
}

function layerPayload(track, layer) {
  const buf = layer.buffer;
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  return {
    meta: {
      trackId: track.id,
      layerId: layer.id,
      trackName: track.name,
      lengthBars: track.lengthBars,
      phaseBar: layer.phaseBar,
      sampleRate: buf.sampleRate,
      channels: buf.numberOfChannels,
      frames: buf.length,
    },
    pcm: encodePcm16(chans),
  };
}

function sendLayer(track, layer) {
  if (!p2p.isOpen()) return;
  const { meta, pcm } = layerPayload(track, layer);
  p2p.sendLoop(meta, pcm);
}

function sendLayerTo(link, track, layer) {
  const { meta, pcm } = layerPayload(track, layer);
  p2p.sendLoopTo(link, meta, pcm);
}

function handleLoop({ meta, buffer, link }) {
  // ホストは他のゲストへ中継（layerId の重複チェックがエコーを防ぐ）
  if (p2p.role === 'host') p2p.sendLoop(meta, buffer, link);
  let entry = tracks.get(meta.trackId);
  if (!entry) {
    entry = createRemoteTrack({
      trackId: meta.trackId,
      name: meta.trackName,
      lengthBars: meta.lengthBars,
    });
  }
  const track = entry.track;
  if (track.layers.some((l) => l.id === meta.layerId)) return; // 再送の重複
  track.lengthBars = meta.lengthBars;
  entry.lenSel.value = meta.lengthBars;
  // 送信側のサンプルレートのまま AudioBuffer を作る（再生時に自動リサンプル）
  const chans = decodePcm16(buffer, meta.channels, meta.frames);
  const audioBuf = engine.ctx.createBuffer(meta.channels, meta.frames, meta.sampleRate);
  chans.forEach((d, c) => audioBuf.copyToChannel(d, c));
  track.addLayer({ id: meta.layerId, buffer: audioBuf, phaseBar: meta.phaseBar });
}

// ─────────────────────── プラグイン音源 ───────────────────────

let instrument = null;
let pckb = null;
let midiReady = false;
let synthGuiEl = null;

function initSynthUI() {
  instrument = new InstrumentHost(engine);
  pckb = new PcKeyboard(instrument);
  const sel = $('synthSel');
  sel.appendChild(new Option('なし（ライン入力のみ）', ''));
  for (const p of PLUGIN_PRESETS) sel.appendChild(new Option(p.name, p.url));
  sel.appendChild(new Option('カスタムURL…', 'custom'));

  sel.addEventListener('change', () => onSynthSelect(sel.value));
  instrument.addEventListener('change', updateSynthUI);
  $('synthVol').addEventListener('input', () => instrument.setGain(+$('synthVol').value));
  $('pckbBtn').addEventListener('click', () => {
    pckb.setEnabled($('pckbBtn').classList.toggle('on'));
  });
  $('synthGuiBtn').addEventListener('click', toggleSynthGui);

  // 前回の音源を復元（プリセットにある場合のみ）
  const saved = localStorage.getItem('ls-synth');
  if (saved && PLUGIN_PRESETS.some((p) => p.url === saved)) {
    sel.value = saved;
    onSynthSelect(saved);
  }
  updateSynthUI();
}

async function onSynthSelect(value) {
  const sel = $('synthSel');
  hideSynthGui();
  if (value === 'custom') {
    const url = (prompt('WAM2 プラグイン (index.js) の URL:') || '').trim();
    if (!url) {
      sel.value = instrument.currentUrl || '';
      return;
    }
    sel.insertBefore(new Option(`カスタム: ${url.slice(0, 48)}`, url), sel.lastChild);
    sel.value = url;
    value = url;
  }
  if (!value) {
    instrument.unload();
    localStorage.removeItem('ls-synth');
    synthWarn('');
    return;
  }
  synthWarn('プラグインを読み込み中…');
  try {
    await instrument.load(value);
    localStorage.setItem('ls-synth', value);
    synthWarn('');
    ensureMidi();
  } catch (err) {
    synthWarn('読み込み失敗: ' + (err && err.message || err));
    sel.value = '';
  }
}

// WebMIDI は音源を最初に読み込んだときに一度だけ初期化する
async function ensureMidi() {
  if (midiReady) return;
  midiReady = true;
  try {
    const access = await initMidi(
      (bytes) => instrument.midi(bytes),
      (count) => {
        $('midiStatus').textContent = count ? `${count}台接続` : 'デバイスなし';
      }
    );
    if (!access) $('midiStatus').textContent = 'このブラウザは未対応';
  } catch {
    $('midiStatus').textContent = 'MIDI許可されず';
  }
}

function updateSynthUI() {
  const active = instrument.active;
  $('synthSel').disabled = instrument.loading;
  $('synthGuiBtn').disabled = !active;
  $('pckbBtn').disabled = !active;
  if (!active) {
    $('pckbBtn').classList.remove('on');
    pckb.setEnabled(false);
  }
}

async function toggleSynthGui() {
  const on = $('synthGuiBtn').classList.toggle('on');
  if (!on) {
    hideSynthGui();
    return;
  }
  try {
    synthGuiEl = await instrument.createGui();
    if (!synthGuiEl) throw new Error('このプラグインにGUIはありません');
    const box = $('synthGui');
    box.innerHTML = '';
    box.appendChild(synthGuiEl);
    box.hidden = false;
  } catch (err) {
    $('synthGuiBtn').classList.remove('on');
    synthWarn('GUIを開けませんでした: ' + (err && err.message || err));
  }
}

function hideSynthGui() {
  const box = $('synthGui');
  box.hidden = true;
  if (synthGuiEl && instrument.instance) {
    try { instrument.instance.destroyGui?.(synthGuiEl); } catch {}
  }
  box.innerHTML = '';
  synthGuiEl = null;
  $('synthGuiBtn').classList.remove('on');
}

function synthWarn(text) {
  const el = $('synthWarn');
  el.textContent = text;
  el.hidden = !text;
}

// ─────────────────────── 設定 ───────────────────────

function initSettingsUI() {
  const saved = +localStorage.getItem('ls-latency') || 0;
  engine.userLatencyMs = saved;
  $('latencyInput').value = saved;
  $('latencyInput').addEventListener('change', () => {
    engine.userLatencyMs = +$('latencyInput').value || 0;
    localStorage.setItem('ls-latency', engine.userLatencyMs);
  });
  // マスター音量は環境差が大きいので端末ごとに保存・復元する
  const savedMaster = parseFloat(localStorage.getItem('ls-master'));
  if (!isNaN(savedMaster)) {
    engine.master.gain.value = savedMaster;
    $('masterVol').value = savedMaster;
  }
  $('masterVol').addEventListener('input', () => {
    engine.master.gain.value = +$('masterVol').value;
    localStorage.setItem('ls-master', $('masterVol').value);
  });
  $('mixFollowBtn').classList.toggle('on', mixFollow);
  $('mixFollowBtn').addEventListener('click', () => {
    mixFollow = $('mixFollowBtn').classList.toggle('on');
    localStorage.setItem('ls-mix-follow', mixFollow ? '1' : '0');
  });
  $('outputSel').addEventListener('change', async () => {
    const id = $('outputSel').value;
    try {
      await engine.setOutput(id);
      localStorage.setItem('ls-output', id);
    } catch (err) {
      alert('出力先を変更できませんでした: ' + (err && err.message || err));
      $('outputSel').value = engine.outputDeviceId || 'default';
    }
  });
  updateLatencyLabel();
}

function updateLatencyLabel() {
  $('latencyAuto').textContent = `(自動推定 +${Math.round(engine.autoLatencySec() * 1000)}ms)`;
}

// コンソールからの動作検証用
window.__ls = {
  engine, p2p, clock, tracks,
  get instrument() { return instrument; },
  get liveSend() { return liveSend; },
  get liveRecv() { return liveRecv; },
};
