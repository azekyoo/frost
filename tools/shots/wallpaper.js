'use strict';

// Wallpapers for the screenshot renderer: generated landscapes, in the vein of
// a stock desktop background.
//
// Generated rather than photographed for two reasons. There's no third-party
// image to license in a public repo, and the output is deterministic — same
// seed, same pixels — so re-running the renderer doesn't churn the committed
// PNGs.
//
// Ridge silhouettes matter more than they look: Frost's `glass` backdrop only
// reads as glass when the image behind it has hard edges and fine detail. Blur a
// smooth gradient and it stays a smooth gradient, and the effect vanishes.

const { nativeImage } = require('electron');

function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeLattice(size, rand) {
  const g = new Float32Array(size * size);
  for (let i = 0; i < g.length; i++) g[i] = rand();
  return g;
}

const smooth = (t) => t * t * (3 - 2 * t);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mix = (a, b, t) => a + (b - a) * t;
const mixRgb = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

function noise2(g, size, x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smooth(x - xi);
  const yf = smooth(y - yi);
  const x0 = ((xi % size) + size) % size;
  const y0 = ((yi % size) + size) % size;
  const x1 = (x0 + 1) % size;
  const y1 = (y0 + 1) % size;
  const a = g[y0 * size + x0];
  const b = g[y0 * size + x1];
  const c = g[y1 * size + x0];
  const d = g[y1 * size + x1];
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}

function fbm2(g, size, x, y, octaves) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise2(g, size, x, y);
    norm += amp;
    amp *= 0.5;
    x *= 2.02;
    y *= 2.02;
  }
  return sum / norm;
}

// Ridge profile: 1 - |noise| folded, which gives creased peaks rather than the
// rolling hills plain fBm produces.
function ridgeAt(g, size, x, row, octaves) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let fx = x;
  for (let o = 0; o < octaves; o++) {
    const n = Math.abs(noise2(g, size, fx, row) * 2 - 1);
    sum += amp * (1 - n);
    norm += amp;
    amp *= 0.5;
    fx *= 2.07;
  }
  return sum / norm;
}

function render(scene, width, height) {
  const rand = mulberry32(scene.seed);
  const size = 64;
  const cloudField = makeLattice(size, rand);
  const ridgeField = makeLattice(size, rand);
  const rippleField = makeLattice(size, rand);

  const horizon = Math.round(height * scene.horizon);
  const waterTop = scene.water ? horizon : height;
  const sunX = Math.round(width * scene.sun.x);
  const sunY = Math.round(height * scene.sun.y);
  const sunR = height * (scene.sun.r ?? 0.035);

  // Ridge heights per column, back layer first, so the per-pixel loop is a
  // handful of comparisons rather than noise lookups.
  const layers = scene.layers.map((layer, i) => {
    const top = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      const u = (x / width) * layer.freq;
      const r = ridgeAt(ridgeField, size, u, 12.5 + i * 7.3, 6);
      top[x] = horizon - layer.base * height - r * layer.amp * height;
    }
    return { ...layer, top };
  });

  // Stars, placed before anything else so the sky can draw over the horizon glow
  const stars = [];
  if (scene.stars) {
    for (let i = 0; i < scene.stars; i++) {
      const sx = Math.floor(rand() * width);
      const sy = Math.floor(rand() * horizon * 0.85);
      stars.push([sx, sy, 0.35 + rand() * 0.65]);
    }
  }
  const starAt = new Float32Array(width * height);
  for (const [sx, sy, mag] of stars) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = sx + dx;
        const y = sy + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const fall = dx === 0 && dy === 0 ? 1 : 0.28;
        starAt[y * width + x] = Math.max(starAt[y * width + x], mag * fall);
      }
    }
  }

  // BGRA on Windows, which is what createFromBitmap expects
  const buf = Buffer.allocUnsafe(width * height * 4);
  const put = (i, rgb, grain) => {
    buf[i] = clamp(rgb[2] + grain, 0, 255);
    buf[i + 1] = clamp(rgb[1] + grain, 0, 255);
    buf[i + 2] = clamp(rgb[0] + grain, 0, 255);
    buf[i + 3] = 255;
  };
  const grainAmt = (scene.grain ?? 0.018) * 255;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const grain = (rand() - 0.5) * grainAmt;

      // ---- water: mirror what's already been drawn above the waterline ----
      if (y >= waterTop) {
        const depth = (y - waterTop) / Math.max(1, height - waterTop);
        const ripple =
          (fbm2(rippleField, size, (x / width) * 9, depth * 26, 3) - 0.5) *
          (6 + depth * 46) *
          (width / 1536);
        const srcY = clamp(
          Math.round(waterTop - (y - waterTop) * (scene.water.squash ?? 0.85)),
          0,
          waterTop - 1
        );
        const srcX = clamp(Math.round(x + ripple), 0, width - 1);
        const s = (srcY * width + srcX) * 4;
        const reflected = [buf[s + 2], buf[s + 1], buf[s]];
        let rgb = mixRgb(reflected, scene.water.tint, 0.28 + depth * 0.34);
        // a band of glitter where the sun sits
        const glint =
          Math.exp(-Math.pow((x - sunX) / (width * 0.1), 2)) *
          Math.max(0, fbm2(rippleField, size, (x / width) * 40, depth * 60, 2) - 0.52) *
          2.2 *
          (1 - depth * 0.7);
        if (glint > 0) rgb = mixRgb(rgb, scene.sun.color, clamp(glint, 0, 0.75));
        put(i, rgb, grain);
        continue;
      }

      // ---- ridges: nearest layer that covers this pixel wins ----
      let painted = false;
      for (let l = layers.length - 1; l >= 0; l--) {
        const layer = layers[l];
        if (y < layer.top[x]) continue;
        const depth = l / Math.max(1, layers.length - 1); // 1 = nearest
        let rgb = mixRgb(scene.haze, layer.color, 0.25 + depth * 0.75);
        // snow: only near a summit, and only on the higher layers
        if (layer.snow) {
          const above = (layer.top[x] + height * layer.snow.below - y) / (height * layer.snow.below);
          if (above > 0) {
            const rough = fbm2(ridgeField, size, (x / width) * 30, 40 + l, 3);
            if (above > 0.35 + rough * 0.5) rgb = mixRgb(rgb, layer.snow.color, 0.75);
          }
        }
        // Sunlit side: lighten flanks that face the sun. Sampled over a wide
        // span — a narrow one picks up the ridge's highest octave and paints
        // full-height vertical stripes down the slope.
        const span = Math.max(4, Math.round(width / 128));
        const slope = layer.top[Math.max(0, x - span)] - layer.top[Math.min(width - 1, x + span)];
        const facing = clamp(((sunX > x ? slope : -slope) / span) * 0.5, -0.2, 0.24);
        rgb = mixRgb(rgb, facing > 0 ? scene.sun.color : scene.haze, Math.abs(facing) * 0.35);
        // and shade towards the bottom of the frame so near layers read as mass
        // rather than as a flat silhouette
        rgb = mixRgb(rgb, scene.shade ?? [0, 0, 0], depth * 0.22 * (y / height));
        put(i, rgb, grain);
        painted = true;
        break;
      }
      if (painted) continue;

      // ---- sky ----
      const t = y / horizon;
      let rgb = mixRgb(scene.sky.top, scene.sky.horizon, Math.pow(t, scene.sky.curve ?? 1.5));

      // clouds, stretched wide and thinning towards the horizon
      const c = fbm2(cloudField, size, (x / width) * 3.4, t * 7.5, 5);
      const cover = clamp((c - (scene.clouds.threshold ?? 0.5)) * (scene.clouds.gain ?? 3.4), 0, 1);
      const band = Math.sin(Math.PI * clamp(t * 1.25, 0, 1));
      if (cover > 0) {
        const lit = clamp(1 - Math.hypot(x - sunX, y - sunY) / (width * 0.55), 0, 1);
        rgb = mixRgb(rgb, mixRgb(scene.clouds.color, scene.sun.color, lit * 0.65), cover * band * (scene.clouds.alpha ?? 0.85));
      }

      // star field, dimmed by whatever cloud sits in front of it
      const star = starAt[y * width + x];
      if (star > 0) rgb = mixRgb(rgb, [255, 255, 245], star * 0.85 * (1 - cover * 0.9));

      // sun or moon: glow, then the disc
      const d = Math.hypot(x - sunX, (y - sunY) * 1.02);
      const glow = Math.exp(-Math.pow(d / (sunR * (scene.sun.spread ?? 9)), 1.7));
      rgb = mixRgb(rgb, scene.sun.color, glow * (scene.sun.strength ?? 0.55));
      if (d < sunR) rgb = mixRgb(rgb, scene.sun.color, clamp((sunR - d) / (sunR * 0.35), 0, 1));

      put(i, rgb, grain);
    }
  }

  return nativeImage.createFromBitmap(buf, { width, height }).toPNG();
}

// One landscape per scenario, so each screenshot sits on its own desktop.
const SCENES = {
  // Dusk over snowy peaks — closest to the wallpaper in the original screenshots
  alpine: {
    seed: 20260806,
    horizon: 0.66,
    shade: [30, 22, 44],
    sky: { top: [38, 44, 92], horizon: [246, 168, 128], curve: 1.7 },
    clouds: { color: [252, 214, 200], threshold: 0.48, gain: 3.2, alpha: 0.9 },
    sun: { x: 0.7, y: 0.6, r: 0.03, color: [255, 226, 186], strength: 0.6, spread: 10 },
    haze: [222, 168, 158],
    layers: [
      { base: 0.0, amp: 0.15, freq: 2.2, color: [158, 146, 184], snow: { below: 0.05, color: [246, 244, 252] } },
      { base: -0.035, amp: 0.15, freq: 3.1, color: [116, 102, 148], snow: { below: 0.03, color: [232, 232, 246] } },
      { base: -0.09, amp: 0.13, freq: 4.3, color: [78, 66, 106] },
      { base: -0.16, amp: 0.11, freq: 6.0, color: [50, 42, 72] }
    ]
  },

  // Islands across calm water
  coast: {
    seed: 771102,
    horizon: 0.54,
    shade: [8, 30, 44],
    water: { tint: [16, 62, 78], squash: 0.9 },
    sky: { top: [16, 62, 92], horizon: [196, 232, 226], curve: 1.4 },
    clouds: { color: [246, 252, 250], threshold: 0.5, gain: 3.0, alpha: 0.8 },
    sun: { x: 0.36, y: 0.34, r: 0.028, color: [252, 246, 214], strength: 0.42, spread: 11 },
    haze: [176, 216, 216],
    layers: [
      { base: 0.0, amp: 0.07, freq: 2.6, color: [96, 140, 146] },
      { base: -0.012, amp: 0.05, freq: 4.4, color: [44, 92, 104] },
      { base: -0.03, amp: 0.045, freq: 7.0, color: [18, 58, 72] }
    ]
  },

  // Layered mesas in late afternoon light
  desert: {
    seed: 4480219,
    horizon: 0.62,
    shade: [40, 20, 20],
    sky: { top: [90, 118, 172], horizon: [250, 208, 158], curve: 1.6 },
    clouds: { color: [255, 236, 214], threshold: 0.54, gain: 2.6, alpha: 0.7 },
    sun: { x: 0.24, y: 0.5, r: 0.032, color: [255, 216, 158], strength: 0.5, spread: 10 },
    haze: [238, 196, 162],
    layers: [
      { base: 0.0, amp: 0.11, freq: 1.9, color: [196, 148, 130] },
      { base: -0.04, amp: 0.11, freq: 3.0, color: [166, 106, 86] },
      { base: -0.11, amp: 0.1, freq: 4.6, color: [126, 74, 60] },
      { base: -0.19, amp: 0.09, freq: 6.8, color: [86, 48, 42] }
    ]
  },

  // Misty forested valley, morning
  pine: {
    seed: 5512034,
    horizon: 0.6,
    shade: [10, 26, 24],
    sky: { top: [58, 96, 122], horizon: [216, 232, 226], curve: 1.5 },
    clouds: { color: [248, 252, 250], threshold: 0.46, gain: 3.2, alpha: 0.85 },
    sun: { x: 0.78, y: 0.3, r: 0.026, color: [255, 248, 220], strength: 0.45, spread: 12 },
    haze: [200, 220, 214],
    layers: [
      { base: 0.0, amp: 0.12, freq: 2.4, color: [124, 148, 140] },
      { base: -0.05, amp: 0.13, freq: 3.6, color: [74, 104, 96] },
      { base: -0.12, amp: 0.12, freq: 5.2, color: [42, 68, 60] },
      { base: -0.2, amp: 0.1, freq: 7.4, color: [24, 44, 38] }
    ]
  },

  // Moonlit lake
  night: {
    seed: 90124,
    horizon: 0.56,
    shade: [4, 8, 24],
    water: { tint: [10, 16, 40], squash: 0.88 },
    sky: { top: [6, 10, 30], horizon: [58, 76, 138], curve: 1.9 },
    clouds: { color: [86, 104, 158], threshold: 0.56, gain: 2.8, alpha: 0.55 },
    sun: { x: 0.68, y: 0.24, r: 0.026, color: [236, 240, 255], strength: 0.34, spread: 8 },
    haze: [46, 60, 108],
    stars: 900,
    layers: [
      { base: 0.0, amp: 0.1, freq: 2.4, color: [30, 40, 78], snow: { below: 0.03, color: [176, 192, 232] } },
      { base: -0.03, amp: 0.1, freq: 3.8, color: [18, 24, 54] },
      { base: -0.09, amp: 0.09, freq: 6.2, color: [9, 12, 32] }
    ]
  }
};

module.exports = { render, SCENES };
