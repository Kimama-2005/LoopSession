// 最小構成の合成ドラム音源（Web Audio）。GM風のキットを鍵盤13キーに割り当てる。
export const DRUM_ORDER = [
  { note: 60, name: "kick", label: "Kick" },
  { note: 61, name: "snare", label: "Snare" },
  { note: 62, name: "hihat", label: "HH" },
  { note: 63, name: "openhat", label: "OpenHH" },
  { note: 64, name: "clap", label: "Clap" },
  { note: 65, name: "tomLow", label: "Tom-L" },
  { note: 66, name: "tomMid", label: "Tom-M" },
  { note: 67, name: "tomHi", label: "Tom-H" },
  { note: 68, name: "crash", label: "Crash" },
  { note: 69, name: "ride", label: "Ride" },
  { note: 70, name: "rim", label: "Rim" },
  { note: 71, name: "cowbell", label: "Cow" },
  { note: 72, name: "kick", label: "Kick" },
];
export const DRUM_MAP = new Map(DRUM_ORDER.map((d) => [d.note, d]));

const noiseCache = new WeakMap();
function getNoise(ctx) {
  let b = noiseCache.get(ctx);
  if (!b) {
    const n = Math.floor(ctx.sampleRate * 1.0);
    b = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, b);
  }
  return b;
}

function env(ctx, dest, peak, when, dur) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(Math.max(peak, 0.0002), when);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  g.connect(dest);
  return g;
}

function noiseHit(ctx, dest, when, peak, dur, type, freq) {
  const n = ctx.createBufferSource();
  n.buffer = getNoise(ctx);
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  const g = env(ctx, dest, peak, when, dur);
  n.connect(f).connect(g);
  n.start(when);
  n.stop(when + dur + 0.02);
}

function toneDrop(ctx, dest, when, peak, dur, f0, f1, type = "sine") {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, when);
  o.frequency.exponentialRampToValueAtTime(f1, when + dur * 0.8);
  const g = env(ctx, dest, peak, when, dur);
  o.connect(g);
  o.start(when);
  o.stop(when + dur + 0.02);
}

// dest はパンナー等のノード（→ master）。velocity は 0..127。when は audioTime(秒)。
export function playDrum(ctx, dest, name, velocity, when) {
  const v = Math.max(0.2, velocity / 127);
  switch (name) {
    case "kick":
      toneDrop(ctx, dest, when, v, 0.3, 150, 50);
      break;
    case "snare":
      noiseHit(ctx, dest, when, v * 0.8, 0.2, "highpass", 1500);
      toneDrop(ctx, dest, when, v * 0.5, 0.12, 220, 180, "triangle");
      break;
    case "hihat":
      noiseHit(ctx, dest, when, v * 0.5, 0.05, "highpass", 7000);
      break;
    case "openhat":
      noiseHit(ctx, dest, when, v * 0.5, 0.3, "highpass", 7000);
      break;
    case "clap":
      noiseHit(ctx, dest, when, v * 0.6, 0.12, "bandpass", 1200);
      noiseHit(ctx, dest, when + 0.02, v * 0.5, 0.1, "bandpass", 1200);
      break;
    case "tomLow":
      toneDrop(ctx, dest, when, v * 0.8, 0.3, 120, 70);
      break;
    case "tomMid":
      toneDrop(ctx, dest, when, v * 0.8, 0.28, 180, 110);
      break;
    case "tomHi":
      toneDrop(ctx, dest, when, v * 0.8, 0.25, 260, 160);
      break;
    case "crash":
      noiseHit(ctx, dest, when, v * 0.45, 1.0, "highpass", 5000);
      break;
    case "ride":
      noiseHit(ctx, dest, when, v * 0.4, 0.5, "highpass", 8000);
      toneDrop(ctx, dest, when, v * 0.2, 0.4, 500, 450, "square");
      break;
    case "rim":
      toneDrop(ctx, dest, when, v * 0.6, 0.05, 900, 400, "square");
      break;
    case "cowbell":
      toneDrop(ctx, dest, when, v * 0.4, 0.15, 560, 540, "square");
      toneDrop(ctx, dest, when, v * 0.4, 0.15, 820, 800, "square");
      break;
    default:
      toneDrop(ctx, dest, when, v, 0.2, 200, 100);
  }
}
