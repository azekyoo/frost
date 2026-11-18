'use strict';

// Frost Flow's liquid, drawn in a worker.
//
// The same picture designs/flow.css paints with CSS (a rainbow band sliding
// underneath, six blobs swimming over it) but on one small canvas: the liquid
// is nothing but soft gradients, so drawing it at a third of the window's size
// and letting the compositor scale it up looks the same, and costs one layer
// instead of seven window-sized ones. Off the main thread, so a terminal busy
// printing never stutters it.
//
// Time is a clock the page owns, so pausing (window in the background) and
// resuming carries on where it stopped.

const PINK = [0xff, 0x4f, 0x9a];
const ORANGE = [0xff, 0x9a, 0x3c];
const YELLOW = [0xff, 0xd9, 0x3d];
const MINT = [0x2f, 0xe0, 0xa0];
const SKY = [0x3c, 0xc8, 0xff];
const VIOLET = [0xa0, 0x66, 0xff];
const BAND = [PINK, ORANGE, YELLOW, MINT, SKY, VIOLET, PINK, ORANGE, YELLOW, MINT, SKY, VIOLET, PINK];
const BAND_MS = 18000;
const ANGLE = (100 * Math.PI) / 180;

// keyframes as in flow.css: [offset, x vw, y vh, scale x, scale y]
const PATHS = {
  1: [[0, 0, 0, 1, 1], [0.33, 28, 18, 1.25, 0.85], [0.66, 8, 42, 0.85, 1.2], [1, -12, 12, 1.1, 1]],
  2: [[0, 0, 0, 1, 1], [0.33, -30, 22, 0.85, 1.25], [0.66, -10, 50, 1.2, 0.9], [1, -40, 5, 1, 1.1]],
  3: [[0, 0, 0, 1, 1], [0.33, 22, -35, 1.2, 0.85], [0.66, -25, -20, 0.9, 1.2], [1, 5, -55, 1.15, 1]],
};

// [colour, path, ms, left %, top %, reversed]
const BLOBS = [
  [PINK, 1, 11000, 15, 20, false],
  [YELLOW, 2, 13000, 80, 25, false],
  [SKY, 3, 9000, 50, 85, false],
  [MINT, 1, 15000, 90, 90, true],
  [VIOLET, 2, 12000, 10, 85, true],
  [ORANGE, 3, 14000, 45, 10, false],
];

const SCALE = 1 / 3;

let canvas = null;
let ctx = null;
let W = 0;
let H = 0;
let playing = false;
let at = 0; // the page's clock when play began
let wall = 0; // and the wall time it began at

const raf = self.requestAnimationFrame
  ? (fn) => self.requestAnimationFrame(fn)
  : (fn) => setTimeout(() => fn(), 16);

const absNow = () => performance.timeOrigin + performance.now();
const clock = () => (playing ? at + (absNow() - wall) : at);

// ease-in-out, cubic-bezier(.42, 0, .58, 1), solved for x
function ease(x) {
  let t = x;
  for (let i = 0; i < 6; i++) {
    const cx = 3 * 0.42 * t * (1 - t) * (1 - t) + 3 * 0.58 * t * t * (1 - t) + t * t * t - x;
    const d = 3 * 0.42 * (1 - t) * (1 - 3 * t) + 3 * 0.58 * t * (2 - 3 * t) + 3 * t * t;
    if (Math.abs(d) < 1e-6) break;
    t -= cx / d;
  }
  t = Math.min(1, Math.max(0, t));
  return 3 * 0 * t * (1 - t) * (1 - t) + 3 * 1 * t * t * (1 - t) + t * t * t;
}

// a blob's place on its path at time T: alternate, ease-in-out per keyframe
function blobAt(b, T) {
  const [, path, ms, , , reversed] = b;
  const n = Math.floor(T / ms);
  let p = (T % ms) / ms;
  if ((n % 2 === 1) !== reversed) p = 1 - p;
  const k = PATHS[path];
  let i = 0;
  while (i < k.length - 2 && p > k[i + 1][0]) i++;
  const a = k[i];
  const z = k[i + 1];
  const e = ease((p - a[0]) / (z[0] - a[0]));
  const lerp = (j) => a[j] + (z[j] - a[j]) * e;
  return [(lerp(1) * W) / 100, (lerp(2) * H) / 100, lerp(3), lerp(4)];
}

// the band's box and gradient line, as CSS lays a 100deg gradient on it
function bandGeometry(T) {
  const phase = (T % BAND_MS) / BAND_MS;
  const x0 = -phase * 1.5 * W;
  const y0 = -0.2 * H;
  const w = 3 * W;
  const h = 1.4 * H;
  const dx = Math.sin(ANGLE);
  const dy = -Math.cos(ANGLE);
  const len = Math.abs(w * dx) + Math.abs(h * dy);
  const cx = x0 + w / 2;
  const cy = y0 + h / 2;
  return { x0, y0, w, h, sx: cx - (dx * len) / 2, sy: cy - (dy * len) / 2, dx, dy, len };
}

const css = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

function draw() {
  if (!ctx || !W || !H) return;
  const T = clock();
  const k = canvas.width / W;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const g = bandGeometry(T);
  const band = ctx.createLinearGradient(g.sx, g.sy, g.sx + g.dx * g.len, g.sy + g.dy * g.len);
  BAND.forEach((c, i) => band.addColorStop(i / (BAND.length - 1), css(c)));
  ctx.fillStyle = band;
  ctx.fillRect(0, 0, W, H);

  const S = 0.46 * Math.max(W, H);
  for (const b of BLOBS) {
    const [tx, ty, sx, sy] = blobAt(b, T);
    ctx.save();
    ctx.translate((b[3] / 100) * W + tx, (b[4] / 100) * H + ty);
    ctx.scale(sx, sy);
    const r = ctx.createRadialGradient(0, 0, 0, 0, 0, S / 2);
    r.addColorStop(0, css(b[0]));
    r.addColorStop(0.35, css(b[0]));
    r.addColorStop(1, css(b[0], 0));
    ctx.fillStyle = r;
    ctx.fillRect(-S / 2, -S / 2, S, S);
    ctx.restore();
  }
}


function loop() {
  if (!playing) return;
  draw();
  raf(loop);
}

self.onmessage = ({ data }) => {
  if (data.canvas) {
    canvas = data.canvas;
    ctx = canvas.getContext('2d', { alpha: true });
  }
  if (data.size) {
    W = data.size[0];
    H = data.size[1];
    canvas.width = Math.max(1, Math.ceil(W * SCALE));
    canvas.height = Math.max(1, Math.ceil(H * SCALE));
  }
  if (data.play) {
    at = data.at;
    wall = data.wall;
    if (!playing) {
      playing = true;
      raf(loop);
    }
  } else if (data.pause) {
    playing = false;
    at = data.at;
  }
  if (!playing) draw();
};
