// 手動シグナリング（コピペ）の WebRTC P2P。スター型トポロジで2人以上に対応:
// ホストが参加者ごとにオファー（参加コード）を作り、全員がホストと直結する。
// ゲスト同士のメッセージ/ループ/LIVE音声はホストが中継する（リレーは main.js 側）。
//
// 各リンクは2本の DataChannel を持つ:
//  - 'data': JSON制御 + ループ転送（loop-begin → バイナリチャンク列 → loop-end）
//  - 'live': LIVEモードの音声チャンク（自己記述ヘッダ付き、順不同で混ざっても安全）
//
// クロック同期: ホストの performance.now() を共有時刻の基準とし、
// ゲスト側リンクが ping/pong (NTP方式・最小RTT採用) でオフセットを求める。

const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const CHUNK = 16 * 1024;
const MAX_BUFFERED = 1024 * 1024;

function encodeDesc(desc) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(desc))));
}
function decodeDesc(text) {
  return JSON.parse(decodeURIComponent(escape(atob(text.trim()))));
}

let linkSeq = 0;

// 1本の接続（ホスト⇄ゲスト間）
class PeerLink extends EventTarget {
  constructor(manager, syncRole) {
    super();
    this.id = ++linkSeq;
    this.manager = manager;
    this.syncRole = syncRole; // 'authority'(ホスト側) | 'follower'(ゲスト側)
    this.peerId = null; // hello で判明
    this.peerName = null;
    this.pc = new RTCPeerConnection(ICE);
    this.dc = null;
    this.liveDc = null;
    this.connected = false;
    this._rx = null;
    this._sendQueue = Promise.resolve();
    this._pingResults = [];
    this._pingTimer = null;
    this._synced = false;
    this.pc.onconnectionstatechange = () => {
      const st = this.pc.connectionState;
      if (st === 'failed' || st === 'disconnected' || st === 'closed') {
        this._setConnected(false);
      }
    };
  }

  isOpen() {
    return this.dc && this.dc.readyState === 'open';
  }
  liveOpen() {
    return this.liveDc && this.liveDc.readyState === 'open';
  }

  async makeOffer() {
    this.dc = this.pc.createDataChannel('data');
    this._bindChannel();
    this.liveDc = this.pc.createDataChannel('live');
    this._bindLive();
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await this._gathered();
    return encodeDesc(this.pc.localDescription);
  }

  async acceptOffer(desc) {
    this.pc.ondatachannel = (e) => {
      if (e.channel.label === 'live') {
        this.liveDc = e.channel;
        this._bindLive();
      } else {
        this.dc = e.channel;
        this._bindChannel();
      }
    };
    await this.pc.setRemoteDescription(desc);
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await this._gathered();
    return encodeDesc(this.pc.localDescription);
  }

  async acceptAnswer(desc) {
    await this.pc.setRemoteDescription(desc);
  }

  _gathered() {
    const pc = this.pc;
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((res) => {
      const timeout = setTimeout(res, 4000);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timeout);
          res();
        }
      });
    });
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _setConnected(b) {
    if (this.connected === b) return;
    this.connected = b;
    if (!b) clearInterval(this._pingTimer);
    this._emit(b ? 'connect' : 'close');
  }

  _bindChannel() {
    const dc = this.dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 256 * 1024;
    dc.onopen = () => {
      this._setConnected(true);
      if (this.syncRole === 'follower') {
        // 先にクロック同期を済ませてから 'open' を通知する
        this._syncClock().then(() => this._emit('open'));
        this._pingTimer = setInterval(() => {
          if (this.isOpen()) this._syncClock(3);
        }, 20000);
      } else {
        this._emit('open');
      }
    };
    dc.onclose = () => this._setConnected(false);
    dc.onmessage = (e) => {
      if (typeof e.data === 'string') this._onJson(JSON.parse(e.data));
      else this._onBinary(e.data);
    };
  }

  _bindLive() {
    this.liveDc.binaryType = 'arraybuffer';
    this.liveDc.onmessage = (e) => this._emit('live', e.data);
  }

  send(obj) {
    if (this.isOpen()) this.dc.send(JSON.stringify(obj));
  }

  // 溢れそうなら送らず捨てる（遅延を溜め込むより欠落のほうがまし）
  sendLive(buf) {
    if (this.liveOpen() && this.liveDc.bufferedAmount < 256 * 1024) {
      this.liveDc.send(buf);
    }
  }

  _onJson(m) {
    switch (m.t) {
      case 'ping':
        this.send({ t: 'pong', id: m.id, ts: m.ts, now: this.manager.clock.now() });
        return;
      case 'pong': {
        const t2 = performance.now();
        const rtt = t2 - m.ts;
        this._pingResults.push({ rtt, offset: m.now + rtt / 2 - t2 });
        return;
      }
      case 'loop-begin':
        this._rx = { meta: m.meta, bytes: m.bytes, parts: [], got: 0 };
        return;
      case 'loop-end': {
        const rx = this._rx;
        this._rx = null;
        if (!rx || rx.got < rx.bytes) return;
        const buf = new Uint8Array(rx.bytes);
        let o = 0;
        for (const p of rx.parts) {
          buf.set(new Uint8Array(p), o);
          o += p.byteLength;
        }
        this._emit('loop', { meta: rx.meta, buffer: buf.buffer });
        return;
      }
      default:
        this._emit('msg', m);
    }
  }

  _onBinary(buf) {
    if (!this._rx) return;
    this._rx.parts.push(buf);
    this._rx.got += buf.byteLength;
  }

  async _syncClock(count = 8) {
    this._pingResults = [];
    for (let i = 0; i < count; i++) {
      this.send({ t: 'ping', id: i, ts: performance.now() });
      await new Promise((r) => setTimeout(r, 80));
    }
    if (!this._pingResults.length) return;
    const best = this._pingResults.reduce((a, b) => (a.rtt < b.rtt ? a : b));
    // 初回は無条件で採用、以降は 4ms 超のずれのみ追従（ジッタで揺らさない）
    if (!this._synced || Math.abs(best.offset - this.manager.clock.offsetMs) > 4) {
      this.manager.clock.offsetMs = best.offset;
      this._synced = true;
    }
  }

  sendLoop(meta, arrayBuffer) {
    this._sendQueue = this._sendQueue
      .then(() => this._sendLoop(meta, arrayBuffer))
      .catch((e) => console.warn('loop send failed', e));
  }

  async _sendLoop(meta, buf) {
    if (!this.isOpen()) return;
    this.send({ t: 'loop-begin', meta, bytes: buf.byteLength });
    for (let o = 0; o < buf.byteLength; o += CHUNK) {
      if (!this.isOpen()) return;
      if (this.dc.bufferedAmount > MAX_BUFFERED) await this._drain();
      this.dc.send(buf.slice(o, Math.min(o + CHUNK, buf.byteLength)));
    }
    this.send({ t: 'loop-end' });
  }

  _drain() {
    return new Promise((res) => {
      const dc = this.dc;
      const done = () => {
        dc.removeEventListener('bufferedamountlow', done);
        clearTimeout(timer);
        res();
      };
      const timer = setTimeout(done, 1000);
      dc.addEventListener('bufferedamountlow', done);
    });
  }

  close() {
    clearInterval(this._pingTimer);
    if (this.liveDc) {
      this.liveDc.onmessage = null;
      try { this.liveDc.close(); } catch {}
    }
    if (this.dc) {
      this.dc.onmessage = null;
      try { this.dc.close(); } catch {}
    }
    try { this.pc.close(); } catch {}
    this._setConnected(false);
  }
}

// 全リンクの管理（アプリからは従来の P2P とほぼ同じ感覚で使う）
export class P2P extends EventTarget {
  constructor(clock) {
    super();
    this.clock = clock;
    this.links = [];
    this.role = null; // 'host' | 'guest' | null
    this._pending = null; // 応答コード待ちのリンク（ホスト側）
  }

  isOpen() {
    return this.links.some((l) => l.isOpen());
  }
  liveOpen() {
    return this.links.some((l) => l.liveOpen());
  }
  get connected() {
    return this.isOpen();
  }
  openLinks() {
    return this.links.filter((l) => l.isOpen());
  }

  // ホスト: 参加者1人ぶんの参加コードを作る（人数分繰り返す）
  async createOffer() {
    if (this.role === 'guest') {
      throw new Error('ゲストとして参加中はホストになれません');
    }
    this.role = 'host';
    const link = this._newLink('authority');
    this._pending = link;
    return link.makeOffer();
  }

  // 貼られたコードを自動判別: 参加コード(offer)→応答を返す / 応答コード(answer)→取り込み
  async acceptRemote(text) {
    const desc = decodeDesc(text);
    if (desc.type === 'offer') {
      if (this.role === 'host') {
        throw new Error('ホストが貼るのは相手からの「応答コード」です');
      }
      if (this.isOpen()) throw new Error('すでに参加中です');
      this.role = 'guest';
      const link = this._newLink('follower');
      return link.acceptOffer(desc);
    }
    if (!this._pending) throw new Error('先に「参加コードを作る」を押してください');
    await this._pending.acceptAnswer(desc);
    this._pending = null;
    return null;
  }

  _newLink(syncRole) {
    const link = new PeerLink(this, syncRole);
    this.links.push(link);
    link.addEventListener('open', () =>
      this.dispatchEvent(new CustomEvent('open', { detail: { link } })));
    link.addEventListener('connect', () => this.dispatchEvent(new CustomEvent('status')));
    link.addEventListener('close', () => {
      this.dispatchEvent(new CustomEvent('peer-close', { detail: { link } }));
      this.dispatchEvent(new CustomEvent('status'));
    });
    link.addEventListener('msg', (e) =>
      this.dispatchEvent(new CustomEvent('msg', { detail: { m: e.detail, link } })));
    link.addEventListener('loop', (e) =>
      this.dispatchEvent(new CustomEvent('loop', { detail: { ...e.detail, link } })));
    link.addEventListener('live', (e) =>
      this.dispatchEvent(new CustomEvent('live', { detail: { data: e.detail, link } })));
    return link;
  }

  // except を指定するとそのリンクを除いて送る（ホストの中継用）
  send(obj, except) {
    for (const l of this.openLinks()) if (l !== except) l.send(obj);
  }
  sendTo(link, obj) {
    if (link.isOpen()) link.send(obj);
  }
  sendLoop(meta, buf, except) {
    for (const l of this.openLinks()) if (l !== except) l.sendLoop(meta, buf);
  }
  sendLoopTo(link, meta, buf) {
    if (link.isOpen()) link.sendLoop(meta, buf);
  }
  sendLive(buf, except) {
    for (const l of this.openLinks()) if (l !== except) l.sendLive(buf);
  }

  close() {
    for (const l of this.links) l.close();
    this.links = [];
    this.role = null;
    this._pending = null;
  }
}

// ── PCM 変換 ────────────────────────────────────────────

export function encodePcm16(channelData) {
  const frames = channelData[0].length;
  const out = new Int16Array(frames * channelData.length);
  let o = 0;
  for (const ch of channelData) {
    for (let i = 0; i < frames; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      out[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }
  return out.buffer;
}

export function decodePcm16(arrayBuffer, channels, frames) {
  const int = new Int16Array(arrayBuffer);
  const chans = [];
  for (let c = 0; c < channels; c++) {
    const f = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      const v = int[c * frames + i];
      f[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
    }
    chans.push(f);
  }
  return chans;
}
