// 共有時計。3つの時間軸を橋渡しする:
//   - localPerf : この端末の performance.now() (ms)
//   - hostTime  : ホスト端末の performance.now() を基準にした共有タイムライン (ms)
//   - audioTime : AudioContext.currentTime (秒) — 実際の音のスケジュールに使う
//
// hostTime = localPerf + hostOffset   (ホスト自身は hostOffset = 0)
export class AudioClock {
  constructor(ctx) {
    this.ctx = ctx;
    this.anchorPerf = performance.now();
    this.anchorAudio = ctx.currentTime;
    this.hostOffset = 0;
  }

  // performance.now() と AudioContext.currentTime の対応を取り直す。
  // 長時間で両クロックが微妙にドリフトするため、transport 開始時に呼ぶ。
  reanchor() {
    this.anchorPerf = performance.now();
    this.anchorAudio = this.ctx.currentTime;
  }

  localPerfToAudio(perfMs) {
    return this.anchorAudio + (perfMs - this.anchorPerf) / 1000;
  }

  hostNow() {
    return performance.now() + this.hostOffset;
  }

  // 共有タイムライン上の時刻を、この端末で鳴らすべき audioTime(秒) に変換
  hostToAudio(hostMs) {
    return this.localPerfToAudio(hostMs - this.hostOffset);
  }

  // audioTime(秒) → 共有タイムライン上の時刻(ms)。音声キャプチャの時刻付けに使う。
  audioToHost(audioSec) {
    return (
      this.anchorPerf + (audioSec - this.anchorAudio) * 1000 + this.hostOffset
    );
  }
}
