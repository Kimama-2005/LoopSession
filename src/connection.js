// WebRTC の手動シグナリングラッパー。
// STUN のみ使用（自前サーバーなし）。ICE 候補が出揃うまで待ってから
// SDP を丸ごと base64 文字列にして人間がコピペで交換する（trickle なし）。
const encode = (d) => btoa(JSON.stringify({ type: d.type, sdp: d.sdp }));
const decode = (s) => JSON.parse(atob(s.trim()));

export class PeerConnection {
  constructor() {
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    this.dc = null;
    this.onMessage = () => {};
    this.onOpen = () => {};
    this.onState = () => {};
    this.pc.onconnectionstatechange = () =>
      this.onState(this.pc.connectionState);
  }

  _setup(dc) {
    this.dc = dc;
    dc.onopen = () => this.onOpen();
    dc.onmessage = (e) => this.onMessage(JSON.parse(e.data));
  }

  send(m) {
    if (this.dc && this.dc.readyState === "open") {
      this.dc.send(JSON.stringify(m));
    }
  }

  // ホスト側: オファーを作る
  async createOffer() {
    const dc = this.pc.createDataChannel("session", { ordered: true });
    this._setup(dc);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this._iceComplete();
    return encode(this.pc.localDescription);
  }

  // ホスト側: 相手のアンサーを取り込む
  async acceptAnswer(code) {
    await this.pc.setRemoteDescription(decode(code));
  }

  // 参加者側: オファーを受けてアンサーを作る
  async createAnswer(offerCode) {
    this.pc.ondatachannel = (e) => this._setup(e.channel);
    await this.pc.setRemoteDescription(decode(offerCode));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this._iceComplete();
    return encode(this.pc.localDescription);
  }

  _iceComplete() {
    return new Promise((res) => {
      if (this.pc.iceGatheringState === "complete") return res();
      const check = () => {
        if (this.pc.iceGatheringState === "complete") {
          this.pc.removeEventListener("icegatheringstatechange", check);
          res();
        }
      };
      this.pc.addEventListener("icegatheringstatechange", check);
    });
  }
}
