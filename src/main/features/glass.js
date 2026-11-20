const { ipcMain, screen } = require('electron');
const fs = require('fs');
const stalls = require('../stalls');

const { SHOT } = require('../env');
const { THEMES_DIR, TRANSCODED_WALLPAPER, queryDesktopWallpaper, registryWallpaper, transcodedFor } = require('../platform');
const { glassBounds, liveWindows, windowOf } = require('./windows/registry');

const fileExists = (f) =>
  fs.promises.access(f).then(
    () => true,
    () => false
  );

async function readImageDataUrl(file) {
  const buf = await fs.promises.readFile(file).catch(() => null);
  if (!buf?.length) return null;
  // the transcoded copies have no extension, so ask the bytes
  const mime = buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,` + buf.toString('base64');
}

// Windows measures monitors in physical pixels, Electron in DIPs. Snapping the
// converted rectangle to the display it lands on keeps rounding at mixed scale
// factors from opening a seam between two monitors' tiles.
function dipDisplayRect(r) {
  const dip = screen.screenToDipRect(null, r);
  let best = null;
  let bestArea = 0;
  for (const { bounds: b } of screen.getAllDisplays()) {
    const w = Math.min(b.x + b.width, dip.x + dip.width) - Math.max(b.x, dip.x);
    const h = Math.min(b.y + b.height, dip.y + dip.height) - Math.max(b.y, dip.y);
    if (w > 0 && h > 0 && w * h > bestArea) {
      best = b;
      bestArea = w * h;
    }
  }
  return best || dip;
}

function unionRect(rects) {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

// One tile per monitor: where it is, the picture it shows (null for a solid
// colour) and how Windows fits that picture. `quick` skips asking Windows, for a
// first paint that must not wait on PowerShell: one picture on every display,
// filled, which is right for most desktops.
async function wallpaperTiles(quick) {
  const displays = screen.getAllDisplays().map((d) => d.bounds);
  if (SHOT?.wallpaper && fs.existsSync(SHOT.wallpaper)) {
    // the screenshot compositor stretches its photo over the display the same way
    return { mode: 'stretch', color: null, tiles: displays.map((rect) => ({ rect, file: SHOT.wallpaper })) };
  }
  const single = (await fileExists(TRANSCODED_WALLPAPER)) ? TRANSCODED_WALLPAPER : null;
  const desk = quick ? null : await queryDesktopWallpaper();
  if (!desk?.monitors?.length) {
    const reg = await registryWallpaper();
    const file = reg ? single || reg : null; // no path: a solid colour
    return { mode: 'fill', color: null, tiles: file ? displays.map((rect) => ({ rect, file })) : [] };
  }
  const { mode, color, monitors } = desk;
  if (mode === 'span') {
    return { mode, color, tiles: [{ rect: unionRect(displays), file: single || monitors[0].path || null }] };
  }
  const perMonitor = new Set(monitors.map((m) => m.path.toLowerCase())).size > 1;
  const tiles = [];
  for (const m of monitors) {
    let file = null;
    if (m.path) {
      if (perMonitor && (await fileExists(transcodedFor(m.index)))) file = transcodedFor(m.index);
      else if (!perMonitor && single) file = single;
      else if (await fileExists(m.path)) file = m.path;
    }
    tiles.push({ rect: dipDisplayRect(m), file });
  }
  return { mode, color, tiles };
}

// The layout every glass window draws, and what it was built from: when nothing
// changed (a monitor event that moved nothing, the quick guess proving right)
// no window is sent megabytes of images to decode again.
let wallpaperLayout = null;
let wallpaperKey = '';
let wallpaperQueue = Promise.resolve();

async function buildWallpaperLayout(quick) {
  const { mode, color, tiles } = await wallpaperTiles(quick);
  const files = [...new Set(tiles.map((t) => t.file).filter(Boolean))];
  const stamps = await Promise.all(
    files.map((f) =>
      fs.promises.stat(f).then(
        (s) => s.mtimeMs,
        () => 0
      )
    )
  );
  const key = JSON.stringify({ mode, color, tiles, stamps });
  if (key === wallpaperKey) return false;
  const images = {};
  await Promise.all(
    files.map(async (f) => {
      images[f] = await readImageDataUrl(f);
    })
  );
  wallpaperKey = key;
  wallpaperLayout = { mode, color, tiles, images };
  return true;
}

// One build at a time, so a slow PowerShell answer can never land after, and
// overwrite, a newer one.
function loadWallpaper(quick) {
  wallpaperQueue = wallpaperQueue
    .then(() => buildWallpaperLayout(quick))
    // megabytes of images copied into each window, from a promise callback
    // that nothing else names
    .then(stalls.timed('send wallpaper', (changed) => {
      if (!changed || quick) return;
      for (const w of liveWindows()) {
        if (w.isFramelessMode) w.webContents.send('glass:wallpaper', wallpaperLayout);
      }
    }))
    .catch(() => {});
  return wallpaperQueue;
}

// Windows sends no WM_SETTINGCHANGE when Settings changes the picture, but it
// always rewrites its copies, so watching those files catches every change. One
// change writes them several times: the read waits for the writes to settle.
// Plugging in, unplugging or rescaling a monitor moves the tiles.
let wallpaperWatcher = null;
let wallpaperTimer = null;
function refreshWallpaperSoon(delay = 1000) {
  clearTimeout(wallpaperTimer);
  wallpaperTimer = setTimeout(() => loadWallpaper(false), delay);
}

function watchWallpaper() {
  if (wallpaperWatcher) return;
  try {
    wallpaperWatcher = fs.watch(THEMES_DIR, (_ev, name) => {
      if (!name || /^Transcoded(Wallpaper|_\d+)$/.test(name)) refreshWallpaperSoon();
    });
  } catch {}
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(ev, () => refreshWallpaperSoon());
  }
}

ipcMain.handle('glass:info', async (event) => {
  if (!wallpaperLayout) {
    // paint the quick guess now, then let Windows' own answer correct it
    await loadWallpaper(true);
    refreshWallpaperSoon(0);
  }
  return { wallpaper: wallpaperLayout, ...glassBounds(windowOf(event)) };
});

Object.assign(module.exports, {
  fileExists,
  readImageDataUrl,
  dipDisplayRect,
  unionRect,
  wallpaperTiles,
  buildWallpaperLayout,
  loadWallpaper,
  refreshWallpaperSoon,
  watchWallpaper
});
