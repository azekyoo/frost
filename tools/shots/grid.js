'use strict';

// Several finished shots tiled two to a row, each with its name on it — the
// designs scenario's four, so they can be compared at a glance.
//
// The ground between them is the scenario's own wallpaper seen through Frost's
// glass: blurred, smoked and grained the way the window's backdrop is, so the
// grid reads as one more Frost surface rather than a black page with pictures
// on it. A module of its own so a grid can be rebuilt from captures already on
// disk, without driving the app again.

const { BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (p) => 'file:///' + p.replace(/\\/g, '/');
const esc = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

// Frost's grain, as in style.css: grey noise through an overlay layer, so it
// shifts luminance only.
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 0 0 1'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

function gridHtml(tiles, cols, canvas, wallpaper) {
  // Sized off the height: each tile has the window's own proportions, so two
  // rows of full-width tiles would overrun a canvas the same shape as one.
  const rows = Math.ceil(tiles.length / cols);
  const tileH = Math.floor((canvas.height - 56 - 22 * (rows - 1)) / rows);
  const tileW = Math.floor((tileH * canvas.width) / canvas.height);
  return `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #0b0d14; }
  /* the wallpaper through frost: oversized so the blur has no soft edge */
  .ground {
    position: fixed; inset: -80px;
    background: url("${url(wallpaper)}") center / cover no-repeat;
    filter: blur(46px) saturate(1.35);
  }
  .ground + .ground {
    inset: 0; filter: none;
    background:
      radial-gradient(ellipse 120% 90% at 50% 40%, transparent 50%, rgba(0, 0, 0, 0.28)),
      linear-gradient(rgba(10, 12, 22, 0.42), rgba(10, 12, 22, 0.42));
  }
  .grain {
    position: fixed; inset: 0;
    background-image: ${GRAIN}; background-size: 180px;
    opacity: 0.06; mix-blend-mode: overlay;
  }
  main {
    position: relative; box-sizing: border-box; height: 100%; padding: 28px;
    display: grid; gap: 22px;
    grid-template-columns: repeat(${cols}, ${tileW}px);
    justify-content: center;
    align-content: center;
    font-family: "Segoe UI Variable Display", "Segoe UI", sans-serif;
  }
  figure { position: relative; margin: 0; }
  img {
    display: block; width: 100%; border-radius: 12px;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.14), 0 18px 44px -12px rgba(0, 0, 0, 0.6);
  }
  /* each name on a pill of the same glass */
  figcaption {
    position: absolute; left: 14px; bottom: 14px;
    padding: 6px 15px 7px; border-radius: 999px;
    background: rgba(14, 16, 26, 0.55); color: #fff;
    backdrop-filter: blur(18px) saturate(1.5);
    font-size: 22px; font-weight: 600; letter-spacing: .01em;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22), inset 0 0 0 1px rgba(255, 255, 255, 0.14),
      0 8px 20px -8px rgba(0, 0, 0, 0.6);
  }
</style>
<div class="ground"></div><div class="ground"></div><div class="grain"></div>
<main>
${tiles.map((t) => `<figure><img src="${url(t.file)}"><figcaption>${esc(t.label)}</figcaption></figure>`).join('\n')}
</main>
<script>
  window.ready = Promise.all([...document.images].map((i) => i.decode().catch(() => {})))
    .then(() => document.fonts.ready);
</script>`;
}

// `tiles`: [{ label, file }], finished shots. Halved like every other shot:
// sharp, and a sensible size for a README.
async function compositeGrid(tiles, canvas, outFile, { wallpaper, tmp }) {
  const htmlFile = path.join(tmp, 'grid-' + path.basename(outFile) + '.html');
  fs.writeFileSync(htmlFile, gridHtml(tiles, 2, canvas, wallpaper));
  const win = new BrowserWindow({
    width: canvas.width,
    height: canvas.height,
    show: false,
    frame: false,
    useContentSize: true
  });
  try {
    await win.loadFile(htmlFile);
    await win.webContents.executeJavaScript('window.ready');
    await sleep(250);
    const image = await win.webContents.capturePage();
    const scaled = image.resize({ width: Math.round(image.getSize().width / 1.5), quality: 'best' });
    fs.writeFileSync(outFile, scaled.toPNG());
    return scaled.getSize();
  } finally {
    win.destroy();
  }
}

module.exports = { compositeGrid };
