// Renders Frost's app icon from SVG into assets/: icon.svg (the master),
// icon-16/32/48/256.png, icon.png and icon.ico.
//
//   npx electron tools/make-icon.js [--palette ice|smoke] [--preview <out.png>]
//
// The icon is cut from the same sheet of ice as the v2 UI (see the material
// tokens at the top of src/renderer/style.css): a smoked, cool body, a lit top
// edge, a soft sheen, a whisper of grain, and the accent as the only colour.
// 16 and 32 px get their own drawing rather than a downscale: no grain,
// heavier strokes, so the prompt still reads in a taskbar.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

// smoke: the dark ice of the UI chrome. ice: the pale blue the name suggests.
const PALETTES = {
  smoke: { body: ['#3a4770', '#1b2033', '#0e1019'], bloom: '#7aa2f7', bloomAt: [0.78, 0.86], fg: '#e4eaff', cursor: '#7aa2f7', ink: 0 },
  ice: { body: ['#b4d0ff', '#6f96e8', '#34559e'], bloom: '#ffffff', bloomAt: [0.2, 0.12], fg: '#ffffff', cursor: '#e2f1ff', ink: 0.3 },
};
const pi = process.argv.indexOf('--palette');
const P = PALETTES[pi === -1 ? 'ice' : process.argv[pi + 1]];

function svg({ small = false } = {}) {
  // Small sizes fill more of the canvas and drop everything finer than a pixel.
  const t = small ? { x: 8, s: 240, r: 56 } : { x: 18, s: 220, r: 54 };
  const stroke = small ? 30 : 21;
  const chev = small ? 'M70 84 L124 128 L70 172' : 'M80 94 L122 128 L80 162';
  const cursor = small ? { x: 140, y: 150, w: 58, h: 26 } : { x: 136, y: 150, w: 46, h: 18 };
  const tile = `x="${t.x}" y="${t.x}" width="${t.s}" height="${t.s}" rx="${t.r}"`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="body" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${P.body[0]}"/>
      <stop offset="0.55" stop-color="${P.body[1]}"/>
      <stop offset="1" stop-color="${P.body[2]}"/>
    </linearGradient>
    <radialGradient id="bloom" cx="${P.bloomAt[0]}" cy="${P.bloomAt[1]}" r="0.7">
      <stop offset="0" stop-color="${P.bloom}" stop-opacity="0.42"/>
      <stop offset="1" stop-color="${P.bloom}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.16"/>
      <stop offset="0.42" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.55"/>
      <stop offset="0.3" stop-color="#fff" stop-opacity="0.12"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0.06"/>
    </linearGradient>
    <clipPath id="clip"><rect ${tile}/></clipPath>
    <filter id="grain" x="0" y="0" width="1" height="1">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/>
      <feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.09 0"/>
    </filter>
    <filter id="glow" x="-50%" y="-100%" width="200%" height="300%">
      <feGaussianBlur stdDeviation="${small ? 6 : 8}"/>
    </filter>
    <filter id="lift" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="6" stdDeviation="7" flood-color="#000" flood-opacity="0.35"/>
    </filter>
    <!-- a soft shadow under the glyph, so white still reads on pale ice -->
    <filter id="ink" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="${small ? 4 : 3}" stdDeviation="${small ? 4 : 5}" flood-color="#142a5c" flood-opacity="${P.ink}"/>
    </filter>
  </defs>

  <rect ${tile} fill="url(#body)"${small ? '' : ' filter="url(#lift)"'}/>
  <g clip-path="url(#clip)">
    <rect ${tile} fill="url(#bloom)"/>
    ${small ? '' : `<rect ${tile} filter="url(#grain)"/>`}
    <rect ${tile} fill="url(#sheen)"/>
  </g>
  <rect x="${t.x + 1}" y="${t.x + 1}" width="${t.s - 2}" height="${t.s - 2}" rx="${t.r - 1}"
        fill="none" stroke="url(#edge)" stroke-width="${small ? 6 : 2}"/>

  <rect x="${cursor.x}" y="${cursor.y}" width="${cursor.w}" height="${cursor.h}" rx="${cursor.h / 2}"
        fill="${P.cursor}" opacity="0.8" filter="url(#glow)"/>
  <g${P.ink ? ' filter="url(#ink)"' : ''}>
    <path d="${chev}" fill="none" stroke="${P.fg}" stroke-width="${stroke}"
          stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="${cursor.x}" y="${cursor.y}" width="${cursor.w}" height="${cursor.h}" rx="${cursor.h / 2}"
          fill="${P.cursor}"/>
  </g>
</svg>`;
}

// Draw an SVG onto a canvas in the page and hand back PNG bytes.
async function raster(win, markup, size, bg) {
  const url = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(markup).toString('base64'))};
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = ${size};
    const g = c.getContext('2d');
    ${bg ? `g.fillStyle = ${JSON.stringify(bg)}; g.fillRect(0, 0, ${size}, ${size});` : ''}
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, ${size}, ${size});
    return c.toDataURL('image/png');
  })()`);
  return Buffer.from(url.split(',')[1], 'base64');
}

// ICO holding PNG frames, which Windows has read since Vista.
function ico(frames) {
  const head = Buffer.alloc(6 + frames.length * 16);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(frames.length, 4);
  let offset = head.length;
  frames.forEach(({ size, png }, i) => {
    const o = 6 + i * 16;
    head[o] = size >= 256 ? 0 : size;
    head[o + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(png.length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...frames.map((f) => f.png)]);
}

// A contact sheet of every size on a dark and a light taskbar, for eyeballing.
async function preview(win, out) {
  const sizes = [16, 24, 32, 48, 256];
  const html = await win.webContents.executeJavaScript(`(async () => {
    const big = new Image(); big.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg()).toString('base64'))};
    const sm = new Image(); sm.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg({ small: true })).toString('base64'))};
    await big.decode(); await sm.decode();
    const c = document.createElement('canvas'); c.width = 760; c.height = 640;
    const g = c.getContext('2d');
    [['#1c1c1c', 0], ['#eeeeee', 320]].forEach(([bg, y]) => {
      g.fillStyle = bg; g.fillRect(0, y, 760, 320);
      let x = 20;
      for (const s of ${JSON.stringify(sizes)}) {
        g.drawImage(s <= 32 ? sm : big, x, y + 300 - s, s, s);
        x += s + 30;
      }
    });
    return c.toDataURL('image/png');
  })()`);
  fs.writeFileSync(out, Buffer.from(html.split(',')[1], 'base64'));
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  const assets = path.join(__dirname, '..', 'assets');

  const i = process.argv.indexOf('--preview');
  if (i !== -1) {
    await preview(win, process.argv[i + 1]);
  } else {
    fs.writeFileSync(path.join(assets, 'icon.svg'), svg());
    const frames = [];
    for (const size of [256, 48, 32, 16]) {
      const png = await raster(win, svg({ small: size <= 32 }), size);
      fs.writeFileSync(path.join(assets, `icon-${size}.png`), png);
      frames.push({ size, png });
    }
    fs.copyFileSync(path.join(assets, 'icon-256.png'), path.join(assets, 'icon.png'));
    fs.writeFileSync(path.join(assets, 'icon.ico'), ico(frames));
  }
  app.quit();
});
