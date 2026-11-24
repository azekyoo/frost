// Wallpaper for the 'glass' material: Frost blurs the desktop picture itself,
// as on Windows. macOS says which picture each screen shows through AppKit
// (NSWorkspace), asked from a JavaScript-for-Automation script so no helper
// binary has to be built. It scripts no other app, so it needs no permission.
const { app } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SCRIPT = `
ObjC.import('AppKit');
const ws = $.NSWorkspace.sharedWorkspace;
const screens = $.NSScreen.screens;
const out = [];
for (let i = 0; i < screens.count; i++) {
  const s = screens.objectAtIndex(i);
  const f = s.frame;
  const url = ws.desktopImageURLForScreen(s);
  const o = ws.desktopImageOptionsForScreen(s);
  const sc = o.objectForKey($.NSWorkspaceDesktopImageScalingKey);
  const clip = o.objectForKey($.NSWorkspaceDesktopImageAllowClippingKey);
  out.push({
    x: f.origin.x, y: f.origin.y, width: f.size.width, height: f.size.height,
    path: url.isNil() ? null : url.path.js,
    scaling: sc.isNil() ? null : Number(sc.intValue),
    clip: clip.isNil() ? null : Boolean(clip.boolValue)
  });
}
JSON.stringify(out);
`;

// The Windows-only names exist so the export list matches.
const THEMES_DIR = null;
const TRANSCODED_WALLPAPER = null;
const transcodedFor = () => null;
const registryWallpaper = () => null;

// NSImageScaling: 1 = stretch to the screen, 2 = centred at its own size (shown
// as fit, the closest the glass backdrop has), 3 = proportional, which fills
// when it may crop and fits when it may not. No options means the default: fill.
function modeOf(m) {
  if (m.scaling === 1) return 'stretch';
  if (m.scaling === 2) return 'fit';
  if (m.scaling === 3 && m.clip === false) return 'fit';
  return 'fill';
}

// [{ x, y, width, height, path, scaling, clip }] in AppKit's coordinates, or
// null when macOS would not say.
function queryDesktopWallpaper() {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT], { encoding: 'utf8', timeout: 15000 }, (err, out) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(out.trim()));
      } catch {
        resolve(null);
      }
    });
  });
}

// AppKit puts the origin at the bottom left of the main screen (the first one
// listed), Electron at its top left; both count in points, so only y flips.
// Snapping to the display it matches keeps rounding from opening a seam.
function toDisplayRect(m, mainHeight, displays) {
  const r = { x: m.x, y: mainHeight - (m.y + m.height), width: m.width, height: m.height };
  return displays.find((d) => d.x === r.x && d.y === r.y && d.width === r.width && d.height === r.height) || r;
}

// Chromium can't show HEIC, which is what most macOS wallpapers are, so those
// become a JPEG once, with sips (part of macOS). They are blurred anyway: a
// smaller copy costs nothing visible and is far less to hand every window.
const CACHE_DIR = path.join(app.getPath('temp'), 'frost-wallpaper');
const SHOWABLE = /\.(jpe?g|png)$/i;

async function showableFile(file) {
  if (!file) return null;
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st?.isFile()) return null;
  if (SHOWABLE.test(file) && st.size < 12 * 1024 * 1024) return file;
  const key = crypto.createHash('sha1').update(`${file}|${st.mtimeMs}|${st.size}`).digest('hex').slice(0, 16);
  const out = path.join(CACHE_DIR, key + '.jpg');
  if (fs.existsSync(out)) return out;
  await fs.promises.mkdir(CACHE_DIR, { recursive: true }).catch(() => {});
  return new Promise((resolve) => {
    execFile('/usr/bin/sips', ['-s', 'format', 'jpeg', '-Z', '2560', file, '--out', out], { timeout: 30000 }, (err) =>
      resolve(!err && fs.existsSync(out) ? out : null)
    );
  });
}

// One tile per display: where it is, the picture it shows (null for a solid
// colour) and how macOS fits it. Asking takes a fraction of a second, so the
// quick first guess Windows needs isn't worth having here.
async function desktopWallpaperTiles(displays) {
  const desk = await queryDesktopWallpaper();
  if (!desk?.length) return { mode: 'fill', color: null, tiles: [] };
  const mainHeight = desk[0].height;
  const tiles = [];
  for (const m of desk) {
    tiles.push({ rect: toDisplayRect(m, mainHeight, displays), file: await showableFile(m.path) });
  }
  return { mode: modeOf(desk[0]), color: null, tiles };
}

// Since macOS 14 System Settings records the wallpaper in this folder, so a
// change there is the picture changing. Older systems: no live updates, the
// next start (or a monitor change) picks it up.
const STORE_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'com.apple.wallpaper', 'Store');

function watchWallpaperFiles(onChange) {
  if (!fs.existsSync(STORE_DIR)) return { close() {} };
  return fs.watch(STORE_DIR, () => onChange());
}

Object.assign(module.exports, {
  THEMES_DIR,
  TRANSCODED_WALLPAPER,
  transcodedFor,
  registryWallpaper,
  queryDesktopWallpaper,
  desktopWallpaperTiles,
  watchWallpaperFiles
});
