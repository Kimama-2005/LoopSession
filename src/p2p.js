// 手動シグナリング（コピペ）の WebRTC P2P 接続。
// 1本の DataChannel に JSON 制御メッセージとループ音声(Int16 PCM)の
// バイナリチャンクを流す。チャンネルは ordered+reliable なので
// loop-begin → チャンク列 → loop-end を順番どおりに組み立てられる。
// クロック同期: オファー側の performance.now() を共有時刻の基準とし、
// アンサー側が ping/pong (NTP方式) でオフセットを求める。

const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const CHUNK = 16 * 1024;
const MAX_BUFFERED = 1024 * 1024;

export class P2P extends EventTarget {
  constructor(clock) {
    super();
    this.clock = clock;
    this.pc = null;
    this.dc = null;
    this.role = null; // 'offer' | 'answer'
    this.connected = false;
    this._rx = null;
    this._sendQueue = Promise.resolve();
    this._pingResults = [];
    this._pingTimer = null;
    this._synced = false;
  }

  isOpen() {
    return this.dc && this.dc.readyState === 'open';
  }

  // ── シグナリング ──────────────────────────────────────

  async createOffer() {
    this._setup('offer');
    this.dc = this.pc.createDataChannel('data');
    this._bindChannel();
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await this._gathered();
    return this._encode(this.pc.localDescription);
  }

  async acceptRemote(text) {
    const desc = this._decode(text);
    if (desc.type === 'offer') {
      this._setup('answer');
      this.pc.ondatachannel = (e) => {
        this.dc = e.channel;
        this._bindChannel();
      };
      await this.pc.setRemoteDescription(desc);
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      await this._gathered();
      return this._encode(this.pc.localDescription);
    }
    // answer
    if (!this.pc) throw new Error('先に「オファーを作る」を押してください');
    await this.pc.setRemoteDescription(desc);
    return null;
  }

  _setup(role) {
    this.close();
    this.role = role;
    this.pc = new RTCPeerConnection(ICE);
    this.pc.onconnectionstatechange = () => {
      const st = this.pc?.connectionState;
      if (st === 'failed' || st === 'disconnected' || st === 'closed') {
        this.connected = false;
        this.dispatchEvent(new CustomEvent('status'));
      }
    };
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

  _encode(desc) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(desc))));
  }

  _decode(text) {
    return JSON.parse(decodeURIComponent(escape(atob(text.trim()))));
  }

  // ── チャンネル ────────────────────────────────────────

  _bindChannel() {
    const dc = this.dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 256 * 1024;
    dc.onopen = () => {
      this.connected = true;
      this.dispatchEvent(new CustomEvent('status'));
      if (this.role === 'answer') {
        // 先にクロック同期を済ませてから 'open' を通知する
        this._syncClock().then(() => this.dispatchEvent(new CustomEvent('open')));
      } else {
        this.dispatchEvent(new CustomEvent('open'));
      }
      this._pingTimer = setInterval(() => {
        if (this.role === 'answer' && this.isOpen()) this._syncClock(3);
      }, 20000);
    };
    dc.onclose = () => {
      this.connected = false;
      clearInterval(this._pingTimer);
      this.dispatchEvent(new CustomEvent('status'));
    };
    dc.onmessage = (e) => {
      if (typeof e.data === 'string') this._onJson(JSON.parse(e.data));
      else this._onBinary(e.data);
    };
  }

  send(obj) {
    if (this.isOpen()) this.dc.send(JSON.stringify(obj));
  }

  close() {
    clearInterval(this._pingTimer);
    if (this.dc) {
      this.dc.onmessage = null;
      try { this.dc.close(); } catch {}
      this.dc = null;
    }
    if (this.pc) {
      try { this.pc.close(); } catch {}
      this.pc = null;
    }
    this.connected = false;
    this._synced = false;
    this._rx = null;
  }

  // ── メッセージ処理 ────────────────────────────────────

  _onJson(m) {
    switch (m.t) {
      case 'ping':
        this.send({ t: 'pong', id: m.id, ts: m.ts, now: this.clock.now() });
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
        this.dispatchEvent(new CustomEvent('loop', { detail: { meta: rx.meta, buffer: buf.buffer } }));
        return;
      }
      default:
        this.dispatchEvent(new CustomEvent('msg', { detail: m }));
    }
  }

  _onBinary(buf) {
    if (!this._rx) return;
    this._rx.parts.push(buf);
    this._rx.got += buf.byteLength;
  }

  // ── クロック同期 ──────────────────────────────────────

  async _syncClock(count = 8) {
    this._pingResults = [];
    for (let i = 0; i < count; i++) {
      this.send({ t: 'ping', id: i, ts: performance.now() });
      await new Promise((r) => setTimeout(r, 80));
    }
    if (!this._pingResults.length) return;
    const best = this._pingResults.reduce((a, b) => (a.rtt < b.rtt ? a : b));
    // 初回は無条件で採用、以降は 4ms 超のずれのみ追従（ジッタで揺らさない）
    if (!this._synced || Math.abs(best.offset - this.clock.offsetMs) > 4) {
      this.clock.offsetMs = best.offset;
      this._synced = true;
    }
  }

  // ── ループ転送 ────────────────────────────────────────

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
