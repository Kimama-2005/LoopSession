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
    this.audioDc = null;
    this.onMessage = () => {};
    this.onAudio = () => {}; // バイナリ音声チャンク受信 (ArrayBuffer)
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

  _setupAudio(dc) {
    this.audioDc = dc;
    dc.binaryType = "arraybuffer";
    dc.onmessage = (e) => this.onAudio(e.data);
  }

  send(m) {
    if (this.dc && this.dc.readyState === "open") {
      this.dc.send(JSON.stringify(m));
    }
  }

  sendAudio(buf) {
    if (this.audioDc && this.audioDc.readyState === "open") {
      this.audioDc.send(buf);
    }
  }

  // ホスト側: オファーを作る
  async createOffer() {
    const dc = this.pc.createDataChannel("session", { ordered: true });
    this._setup(dc);
    this._setupAudio(this.pc.createDataChannel("audio", { ordered: true }));
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
    this.pc.ondatachannel = (e) => {
      if (e.channel.label === "audio") this._setupAudio(e.channel);
      else this._setup(e.channel);
    };
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
