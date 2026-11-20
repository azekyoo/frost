const { BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('fs');

const { TITLEBAR_H, ZOOM_FILE } = require('../../env');
const { windowOf } = require('./registry');
const { setCaptionButtons } = require('../../platform');

// ---------- UI zoom ----------
// A monitor's scale factor makes text the same *physical* size everywhere, which
// is right for a laptop panel and wrong for a big desktop screen sat further
// away: same size, much more of it. Zoom is therefore remembered per display
// rather than per window, so dragging the window across screens picks up the
// size that screen was last set to, and dragging it back restores the other one.

// Zoom steps are derived from the display's scale factor rather than fixed,
// because the terminal renderer rasterises a glyph cell to whole device pixels:
// at an effective ratio of 1.5 the rounding error lands differently in every
// column and the text looks gritty. Every step below multiplies out to a whole
// or half device pixel ratio, so zooming also sharpens rather than blurs.
const ZOOM_DPRS = [1, 1.5, 2, 2.5, 3, 4];
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

function zoomSteps(scaleFactor) {
  const steps = ZOOM_DPRS.map((dpr) => dpr / (scaleFactor || 1)).filter(
    (z) => z >= ZOOM_MIN - 1e-6 && z <= ZOOM_MAX + 1e-6
  );
  // A scale factor outside the table (an odd 1.75, say) could filter down to
  // nothing; 1:1 always has to remain reachable.
  return steps.length ? steps : [1];
}

let zoomByDisplay = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(ZOOM_FILE, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
})();
let zoomTimer = null;

function saveZoomSoon() {
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => {
    try {
      fs.writeFileSync(ZOOM_FILE, JSON.stringify(zoomByDisplay, null, 2));
    } catch {}
  }, 300);
}

// Resolution + scale rather than display.id: ids are reassigned when a monitor
// is unplugged and plugged back in, which would forget the setting every time.
function displayKeyOf(d) {
  return `${d.size.width}x${d.size.height}@${d.scaleFactor}`;
}

function displayKey(w) {
  return displayKeyOf(screen.getDisplayMatching(w.getBounds()));
}

function zoomFor(key) {
  const z = Number(zoomByDisplay[key]);
  if (!Number.isFinite(z)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

function applyZoom(w, factor) {
  if (!w || w.isDestroyed()) return;
  w.webContents.setZoomFactor(factor);
  // Chromium zooms by origin, and every Frost window is the same page: the
  // others have just been zoomed too, without being told. Each is told the
  // zoom it actually has, or its glass and titlebar go on fitting the old one.
  for (const other of BrowserWindow.getAllWindows()) tellZoom(other);
}

function tellZoom(w) {
  if (!w || w.isDestroyed()) return;
  const factor = w.webContents.getZoomFactor() || 1;
  // The native buttons are drawn by Windows, not by us, so they only match the
  // zoomed titlebar the renderer draws if the overlay is resized to match.
  if (!w.isFramelessMode) {
    try {
      setCaptionButtons(w, { height: Math.round(TITLEBAR_H * factor) });
    } catch {}
  }
  w.webContents.send('win:zoom', { factor });
}

// Called on every move: cheap, and the only moment a window can change display.
function syncZoom(w) {
  if (!w || w.isDestroyed() || w.isMinimized()) return;
  const key = displayKey(w);
  if (key === w.frostZoomKey) return;
  w.frostZoomKey = key;
  applyZoom(w, zoomFor(key));
}

function stepZoom(w, dir) {
  const d = screen.getDisplayMatching(w.getBounds());
  const key = displayKey(w);
  const steps = zoomSteps(d.scaleFactor);
  const current = zoomFor(key);
  let next;
  if (!dir) next = 1;
  else {
    // nearest step to where we are, then move one along — a hand-edited zoom.json
    // value between two steps still zooms in the direction asked for
    let i = 0;
    for (let k = 1; k < steps.length; k++) {
      if (Math.abs(steps[k] - current) < Math.abs(steps[i] - current)) i = k;
    }
    next = steps[Math.min(steps.length - 1, Math.max(0, i + dir))];
  }
  w.frostZoomKey = key;
  zoomByDisplay[key] = next;
  saveZoomSoon();
  applyZoom(w, next);
  return next;
}

// dir: 1 = in, -1 = out, 0 = back to the display's default
ipcMain.handle('zoom:step', (event, dir) => {
  const w = windowOf(event);
  return w ? stepZoom(w, dir) : 1;
});

Object.assign(module.exports, {
  ZOOM_DPRS,
  ZOOM_MIN,
  ZOOM_MAX,
  zoomSteps,
  saveZoomSoon,
  displayKeyOf,
  displayKey,
  zoomFor,
  applyZoom,
  tellZoom,
  syncZoom,
  stepZoom
});
