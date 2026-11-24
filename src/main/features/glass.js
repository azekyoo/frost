const { ipcMain, screen } = require('electron');
const fs = require('fs');
const stalls = require('../stalls');

const { SHOT } = require('../env');
const { desktopWallpaperTiles, watchWallpaperFiles } = require('../platform');
const { glassBounds, liveWindows, windowOf } = require('./windows/registry');

async function readImageDataUrl(file) {
  const buf = await fs.promises.readFile(file).catch(() => null);
  if (!buf?.length) return null;
  // the transcoded copies have no extension, so ask the bytes
  const mime = buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,` + buf.toString('base64');
}

// One tile per monitor: where it is, the picture it shows (null for a solid
// colour) and how the desktop fits that picture. `quick` is a first guess that
// must not wait on the operating system (see desktopWallpaperTiles).
async function wallpaperTiles(quick) {
  const displays = screen.getAllDisplays().map((d) => d.bounds);
  if (SHOT?.wallpaper && fs.existsSync(SHOT.wallpaper)) {
    // the screenshot compositor stretches its photo over the display the same way
    return { mode: 'stretch', color: null, tiles: displays.map((rect) => ({ rect, file: SHOT.wallpaper })) };
  }
  return desktopWallpaperTiles(displays, quick);
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
    wallpaperWatcher = watchWallpaperFiles(() => refreshWallpaperSoon());
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
  readImageDataUrl,
  wallpaperTiles,
  buildWallpaperLayout,
  loadWallpaper,
  refreshWallpaperSoon,
  watchWallpaper
});
