// かんたん接続（自動シグナリング）。
// 公開 MQTT ブローカー（無料・アカウント不要）をルームコードごとのトピックで使い、
// SDP オファー/アンサーの交換を自動化する。ブローカーはシグナリングにしか使わず、
// 音声・制御データは従来どおり P2P 直結。
// ペイロードはルームコードから導出した AES-GCM 鍵で暗号化するため、
// コードを知らない相手には内容（IPアドレス等を含むSDP）を読めない。

// mqtt.js はリポジトリに同梱（外部CDN依存を避ける。元: unpkg mqtt@5.10.1）
const MQTT_CDN = new URL('../vendor/mqtt.min.js', import.meta.url).href;
const BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];
// 紛らわしい文字 (I/1/O/0) を除いた32文字
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function genRoomCode(len = 6) {
  const rnd = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[rnd[i] % CODE_CHARS.length];
  return s;
}

let mqttLoading = null;
function loadMqtt() {
  if (window.mqtt) return Promise.resolve();
  if (!mqttLoading) {
    mqttLoading = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = MQTT_CDN;
      s.onload = res;
      s.onerror = () => {
        mqttLoading = null;
        rej(new Error('MQTTライブラリを読み込めませんでした（オフライン?）'));
      };
      document.head.appendChild(s);
    });
  }
  return mqttLoading;
}

async function roomKey(code) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode('loopsession:' + code)
  );
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export class Signal extends EventTarget {
  constructor() {
    super();
    this.client = null;
    this.key = null;
    this.topic = null;
    this.broker = null;
    this.sid = Math.random().toString(36).slice(2, 10); // 自分の発言を無視するため
  }

  async connect(code) {
    await loadMqtt();
    this.key = await roomKey(code);
    this.topic = 'loopsession/v2/' + code;
    let lastErr = null;
    for (const url of BROKERS) {
      try {
        await this._open(url);
        this.broker = url;
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('シグナリング用ブローカーに接続できませんでした');
  }

  _open(url) {
    return new Promise((res, rej) => {
      const c = window.mqtt.connect(url, {
        connectTimeout: 7000,
        reconnectPeriod: 3000,
        clean: true,
      });
      const timer = setTimeout(() => {
        try { c.end(true); } catch {}
        rej(new Error('接続タイムアウト'));
      }, 9000);
      c.once('connect', () => {
        clearTimeout(timer);
        c.subscribe(this.topic, { qos: 0 }, (err) => (err ? rej(err) : res()));
        c.on('message', (t, payload) => this._onMessage(payload));
      });
      c.once('error', (e) => {
        clearTimeout(timer);
        try { c.end(true); } catch {}
        rej(e);
      });
      this.client = c;
    });
  }

  async _onMessage(payload) {
    try {
      const data = unb64(payload.toString());
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: data.slice(0, 12) },
        this.key,
        data.slice(12)
      );
      const m = JSON.parse(new TextDecoder().decode(plain));
      if (m.sid === this.sid) return;
      this.dispatchEvent(new CustomEvent('msg', { detail: m }));
    } catch {
      // 復号できない＝別アプリ/壊れたメッセージ。無視
    }
  }

  async send(obj) {
    if (!this.client) return;
    obj.sid = this.sid;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.key,
      new TextEncoder().encode(JSON.stringify(obj))
    );
    const out = new Uint8Array(12 + ct.byteLength);
    out.set(iv);
    out.set(new Uint8Array(ct), 12);
    this.client.publish(this.topic, b64(out));
  }

  close() {
    if (this.client) {
      try { this.client.end(true); } catch {}
      this.client = null;
    }
  }
}
