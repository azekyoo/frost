const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const { focusedWindow, liveWindows, windowOf } = require('./windows/registry');
const { RENDERER_DIR } = require('../env');
const { pendingAdoptions } = require('./pty/registry');
const { late } = require('../late');
const { createWindow } = late(require('./windows/window'), ['createWindow']);

// ---------- the tab that follows the cursor ----------
// A page cannot draw outside its own window, so the tab being dragged cannot be
// a element in the window it came from: the moment it crosses the window edge —
// which is the whole point of dragging one out — it would be clipped away. It is
// therefore a window of its own: frameless, transparent, click-through, above
// everything, and never focused, so it is a picture following the cursor and
// nothing else. Kept between drags because creating one costs a visible frame.

let ghostWin = null;
let ghostKey = ''; // which tab it is showing, so it is not reloaded per move
let ghostReady = false; // its page has loaded and can be talked to
let ghostMode = ''; // the outline it should be showing: reorder | detach | merge
let ghostSize = null; // the size it was shown at, so a move never has to ask for it

function ghostWindow() {
  if (ghostWin && !ghostWin.isDestroyed()) return ghostWin;
  ghostWin = new BrowserWindow({
    width: 180,
    height: 34,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    // Never takes focus, never appears in the taskbar or in Alt+Tab: it is a
    // cursor decoration, and the window being dragged from must stay active.
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    thickFrame: false,
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  // 'screen-saver' rather than plain always-on-top: it has to sit above other
  // Frost windows, which are themselves ordinary top-level windows.
  ghostWin.setAlwaysOnTop(true, 'screen-saver');
  // The drop must reach whatever is underneath, so the ghost is transparent to
  // the mouse as well as to the eye.
  ghostWin.setIgnoreMouseEvents(true);
  // The outline is the one thing pushed into the page after it loads, and it is
  // pushed from here as well: a mode that changed while the page was still
  // loading would otherwise be lost, and asking during the load is what piles up
  // did-stop-loading listeners — executeJavaScript parks each call behind one.
  ghostWin.webContents.on('did-finish-load', () => {
    ghostReady = true;
    paintGhostMode();
  });
  ghostWin.on('closed', () => {
    ghostWin = null;
    ghostKey = '';
    ghostReady = false;
    ghostMode = '';
    ghostSize = null;
  });
  return ghostWin;
}

function paintGhostMode() {
  if (!ghostReady || !ghostWin || ghostWin.isDestroyed() || !ghostMode) return;
  ghostWin.webContents
    .executeJavaScript(`document.body.dataset.mode=${JSON.stringify(ghostMode)}`)
    .catch(() => {}); // the window can go while the call is in flight
}

// The renderer reports the ghost's position in its own CSS pixels, as it does
// for a drop target: the conversion needs the window's zoom factor and content
// origin, and main is what has both.
function toScreen(from, x, y) {
  const zoom = from.webContents.getZoomFactor() || 1;
  const origin = from.getContentBounds();
  return { x: Math.round(origin.x + x * zoom), y: Math.round(origin.y + y * zoom), zoom };
}

ipcMain.on('ghost:show', (event, { label, mode, x, y, width, height, accent, fg, bg, font }) => {
  const from = windowOf(event);
  if (!from) return;
  const w = ghostWindow();
  const pt = toScreen(from, x, y);
  ghostMode = mode || 'reorder';
  // The label and the colours are in the URL, so they only cost a load when the
  // tab being dragged is a different one from last time
  const key = [label, accent, fg, bg, font].join('|');
  if (key !== ghostKey) {
    ghostKey = key;
    ghostReady = false;
    const params = new URLSearchParams({
      label: String(label || '').slice(0, 80),
      mode: mode || 'reorder',
      accent: accent || '',
      fg: fg || '',
      bg: bg || '',
      font: String(font || '').slice(0, 120)
    });
    w.loadFile(path.join(RENDERER_DIR, 'dragghost.html'), {
      search: params.toString()
    }).catch(() => {});
  } else {
    // Same tab as last drag, so the page is still the right one — only the
    // outline may have moved on since
    paintGhostMode();
  }
  ghostSize = {
    width: Math.max(60, Math.round((width || 160) * pt.zoom)),
    height: Math.max(20, Math.round((height || 34) * pt.zoom))
  };
  w.setBounds({ x: pt.x, y: pt.y, ...ghostSize });
  if (!w.isVisible()) w.showInactive(); // showInactive: the drag keeps its window
});

ipcMain.on('ghost:move', (event, { x, y, mode }) => {
  const from = windowOf(event);
  if (!from || !ghostWin || ghostWin.isDestroyed() || !ghostWin.isVisible()) return;
  const pt = toScreen(from, x, y);
  // The size it was shown at is set again on every move, rather than moving it
  // and leaving the size alone. setPosition is not position-only: it is a
  // setBounds carrying the size it reads back off the window, and a rectangle
  // read back and re-applied is resolved against a different display's scale
  // than the one it came from (the same trap as the note in createWindow), so
  // on a mixed-DPI desktop every mouse move multiplied the ghost by that ratio
  // and it grew across the screen for as long as the drag lasted. Passing the
  // size we already know never reads anything back, so there is nothing to
  // multiply.
  if (ghostSize) ghostWin.setBounds({ x: pt.x, y: pt.y, ...ghostSize });
  else ghostWin.setPosition(pt.x, pt.y);
  // Moving is every mouse move; repainting is only when what the drop would do
  // actually changes, which is a handful of times per drag at most.
  if (mode && mode !== ghostMode) {
    ghostMode = mode;
    paintGhostMode();
  }
});

ipcMain.on('ghost:hide', () => {
  if (ghostWin && !ghostWin.isDestroyed() && ghostWin.isVisible()) ghostWin.hide();
});

// Which window a tab would land in if it were dropped now. Only main can answer
// it: a window knows nothing about the others, and the one being dropped onto is
// a different renderer that never sees the drag — the pointer stays captured by
// the window the gesture started in for as long as the button is held.
//
// The point arrives in the dragging window's own CSS pixels and is converted
// here rather than in the renderer, because the conversion needs that window's
// zoom factor and content origin, both of which main owns. Synthetic mouse
// events (the tab test) therefore land where the arithmetic says, not where the
// operating system's cursor happens to be.
ipcMain.handle('tab:dropTarget', (event, { x, y }) => {
  const from = windowOf(event);
  if (!from || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const zoom = from.webContents.getZoomFactor() || 1;
  const origin = from.getContentBounds();
  const pt = { x: Math.round(origin.x + x * zoom), y: Math.round(origin.y + y * zoom) };
  const inside = (w) => {
    const b = w.getBounds();
    return pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height;
  };
  // Over the window being dragged from, it is not a hand-off however far the
  // pointer is from the strip: that gesture already means "open it on its own".
  // Checked first, so a window sitting on top of another behaves as it looks.
  if (inside(from)) return null;
  // No z-order to consult, so the focused window is preferred and the rest are
  // taken in creation order — which is what overlapping windows usually mean.
  const focused = focusedWindow();
  const candidates = [focused, ...liveWindows()].filter(
    (w, i, all) => w && w !== from && !w.isMinimized() && all.indexOf(w) === i
  );
  const hit = candidates.find(inside);
  return hit ? { frostId: hit.frostId, title: hit.getTitle() } : null;
});

ipcMain.on('tab:moveTo', (_e, { frostId, payload }) => {
  if (!payload) return;
  const target = liveWindows().find((w) => w.frostId === frostId);
  // The window went away between the drop and this message — rare, but the
  // shells are already ownerless and must not be left that way, so they get a
  // window of their own rather than being lost.
  if (!target) {
    const w = createWindow();
    pendingAdoptions.set(w.frostId, payload);
    return;
  }
  target.webContents.send('tab:adopt', payload);
  if (target.isMinimized()) target.restore();
  target.focus();
});

ipcMain.handle('tab:pending', (event) => {
  const w = windowOf(event);
  if (!w) return null;
  const payload = pendingAdoptions.get(w.frostId) || null;
  pendingAdoptions.delete(w.frostId); // adopted once, not again on a reload
  return payload;
});

// A window closing while one of its tabs was mid-drag would leave the copy
// hanging over the desktop with nothing driving it.
function ghostOnWindowClosed() {
  if (ghostWin && !ghostWin.isDestroyed()) {
    if (liveWindows().length) ghostWin.hide();
    // Otherwise it would be the one window still open, and window-all-closed
    // — which is what quits Frost — would never fire.
    else ghostWin.destroy();
  }
}

function destroyGhost() {
  if (ghostWin && !ghostWin.isDestroyed()) ghostWin.destroy();
}

Object.assign(module.exports, {
  ghostOnWindowClosed,
  destroyGhost,
  ghostWindow,
  paintGhostMode,
  toScreen
});
