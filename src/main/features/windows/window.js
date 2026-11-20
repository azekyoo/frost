const { BrowserWindow, app, ipcMain, nativeTheme, screen, shell } = require('electron');
const chokidar = require('chokidar');
const path = require('path');
const stalls = require('../../stalls');

const { CSS_FILE, KEYS_FILE, MAIN_DIR, RENDERER_DIR, SHOT, THEME_FILE } = require('../../env');
const { DEFAULT_THEME, readCss, readKeys, readTheme } = require('../config');
const { SAFE_SCHEMES } = require('../open');
const { SPARE_REFILL_MS } = require('../pty/spare-timing');
const { appIcon, applyWindowTheme, captionInk } = require('./chrome');
const { frameOptions, refreshMaterialOnBlur } = require('../../platform');
const { applyZoom, displayKey, syncZoom, zoomFor } = require('./zoom');
const { displayKeyOf, scaleBoundsTo } = require('../../core/geometry');
const { boundsVisible, cursorDisplay, defaultBoundsFor, flushWindowState, lastBounds, pendingLayouts, ptyIdsOf, recentlyClosed, saveWindowStateSoon, sessionLayouts, windowEntry } = require('./state');
const { broadcast, focusedWindow, glassBounds, liveWindows, windows } = require('./registry');
const { detachedPtys, pendingAdoptions, ptyMeta, ptys } = require('../pty/registry');
const { fillSpares } = require('../pty/spares');
const { watchWallpaper } = require('../glass');
const { primaryWindow, setPrimaryWindow, getAgentWindow, setAgentWindow } = require('./registry');
const { isQuitting } = require('./state');
const { holdUpdateInstall } = require('../updates');
const { ghostOnWindowClosed } = require('../tab-drag');

let currentMaterial = 'acrylic';
let windowCounter = 0;

function createWindow({ isPrimary = false, restore = null } = {}) {
  const theme = readTheme() || DEFAULT_THEME;
  const material = theme.material || 'acrylic';
  const alwaysOn = material === 'acrylic-always';
  const glass = material === 'glass';
  nativeTheme.themeSource = theme.colorMode || 'dark';

  const opts = {
    width: 1100,
    height: 700,
    minWidth: 480,
    minHeight: 300,
    show: false,
    icon: appIcon(),
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(MAIN_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  };

  frameOptions(opts, { glass, material, alwaysOn, theme, symbolColor: captionInk(theme) });

  // A window restores its own geometry when it has some; one opened by hand is
  // offset from the current window so it doesn't land exactly on top of it.
  if (SHOT?.bounds) {
    Object.assign(opts, SHOT.bounds);
  } else if (restore?.bounds) {
    const saved = restore.display;
    const sameScreen = !saved?.key || screen.getAllDisplays().some((d) => displayKeyOf(d) === saved.key);
    if (sameScreen && boundsVisible(restore.bounds)) {
      // the monitor it was last on is still here: put it back exactly
      Object.assign(opts, restore.bounds);
    } else {
      const host = boundsVisible(restore.bounds) ? screen.getDisplayMatching(restore.bounds) : cursorDisplay();
      Object.assign(opts, scaleBoundsTo(restore.bounds, saved?.workArea, host.workArea) || defaultBoundsFor(host));
    }
  } else {
    const from = focusedWindow();
    if (from) {
      const b = from.getBounds();
      Object.assign(opts, { x: b.x + 34, y: b.y + 34, width: b.width, height: b.height });
    } else {
      Object.assign(opts, defaultBoundsFor(cursorDisplay()));
    }
  }

  const w = new BrowserWindow(opts);
  // not its webContents: everything a page sends is an IPC call, labelled
  // already, and its events would only add a second name on the busiest path
  stalls.labelEmitter(w, 'window');
  // Windows is signing out or shutting down: a waiting update must not start
  // installing now, because the session ending kills the installer between
  // removing the old version and copying the new one, and Frost no longer
  // starts (2026-11-17). It installs on the next ordinary quit instead. The
  // installer's own RunOnce retry (build/installer.nsh) covers any kill this
  // misses.
  w.on('session-end', () => {
    holdUpdateInstall();
  });
  // The constructor resolves its bounds against the primary display's scale
  // factor, wherever the window is actually going to land. Opening a 976px-wide
  // window on a 150% screen from a 200% primary therefore produces one 732px
  // wide — and since that is what gets saved on close, every restart multiplied
  // the window by 0.75 again. Re-applying the rectangle once the window exists
  // resolves it against the display it is really on. Still hidden at this point,
  // so nothing is seen to jump.
  if (['x', 'y', 'width', 'height'].every((k) => Number.isFinite(opts[k]))) {
    try {
      w.setBounds({ x: opts.x, y: opts.y, width: opts.width, height: opts.height });
    } catch {}
  }
  // Set again after creation: the constructor option is silently ignored in some
  // configurations, and this path is the one that reliably sticks.
  const icon = appIcon();
  if (icon) {
    try {
      w.setIcon(icon);
    } catch {}
  }
  w.isFramelessMode = glass;
  w.frostId = ++windowCounter;
  windows.add(w);
  if (isPrimary) setPrimaryWindow(w);
  // Held until the renderer asks for it, since only it can rebuild the panes.
  if (restore?.tabs?.length) pendingLayouts.set(w.frostId, restore);

  const sendBounds = () => {
    // skip while minimized: bounds are bogus (-16000) and would park the
    // glass wallpaper offscreen until the next move/resize
    if (!w.isDestroyed() && w.isFramelessMode && !w.isMinimized()) {
      w.webContents.send('win:bounds', glassBounds(w));
    }
  };
  w.on('move', sendBounds);
  w.on('resize', sendBounds);
  w.on('restore', sendBounds);
  w.on('show', sendBounds);
  w.on('focus', sendBounds);
  if (glass) watchWallpaper();

  // Dragging onto another monitor is the moment the display's own zoom applies.
  for (const ev of ['move', 'moved', 'resize', 'restore', 'show']) {
    w.on(ev, () => syncZoom(w));
  }
  // Zoom does not survive a reload, and the renderer needs to be told the factor
  // it is running at before it positions anything against screen coordinates.
  w.webContents.on('did-finish-load', () => {
    w.frostZoomKey = displayKey(w);
    applyZoom(w, zoomFor(w.frostZoomKey));
  });

  w.on('focus', () => {
    try {
      w.flashFrame(false);
    } catch {}
  });

  // acrylic-always: the backdrop keeps its focused look while unfocused
  w.on('blur', () => {
    if (currentMaterial === 'acrylic-always') {
      try {
        refreshMaterialOnBlur(w);
      } catch {}
    }
  });

  // Belt and braces around anything a link in terminal output might attempt:
  // never open a window for it, and never let the app itself navigate away.
  w.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (SAFE_SCHEMES.has(new URL(url).protocol)) shell.openExternal(url);
    } catch {}
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (event) => event.preventDefault());

  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) {
    w.on(ev, saveWindowStateSoon);
  }
  // Recorded while the window still exists, so its geometry and tabs are
  // captured rather than measured from a window that is already gone.
  w.on('close', () => {
    recentlyClosed.set(w.frostId, { at: Date.now(), entry: windowEntry(w) });
    flushWindowState();
  });

  currentMaterial = material;
  w.loadFile(path.join(RENDERER_DIR, 'index.html'));
  // ready-to-show waits for the renderer's first paint, and a window that opens
  // underneath another one may never get painted: Windows reports it occluded,
  // the compositor skips it, and the window stays invisible for good — holding
  // the app open with nothing on screen. Restoring several windows at once is
  // exactly that situation. The event is still the moment worth waiting for,
  // since it shows a drawn window rather than an empty frame; the timer is the
  // deadline on waiting.
  let revealed = false;
  const reveal = () => {
    if (revealed || w.isDestroyed()) return;
    revealed = true;
    clearTimeout(revealTimer);
    if (restore?.maximized) w.maximize();
    w.show();
  };
  const revealTimer = setTimeout(reveal, 1500);
  w.once('ready-to-show', reveal);
  w.on('closed', () => {
    windows.delete(w);
    // Closed before its renderer claimed the tab it was opened for — a load
    // that failed, or a very fast close. Those shells have no owner and no
    // window to appear in, so they are killed rather than left running unseen.
    const unclaimed = pendingAdoptions.get(w.frostId);
    if (unclaimed) {
      pendingAdoptions.delete(w.frostId);
      for (const id of ptyIdsOf(unclaimed.root)) {
        detachedPtys.delete(id);
        ptyMeta.delete(id);
        const p = ptys.get(id);
        if (p) {
          ptys.delete(id);
          try {
            p.kill();
          } catch {}
        }
      }
    }
    sessionLayouts.delete(w.frostId);
    lastBounds.delete(w.frostId);
    pendingLayouts.delete(w.frostId);
    if (getAgentWindow() === w) setAgentWindow(null);
    ghostOnWindowClosed();
    // hand primary status on, so the last window standing still saves its state
    if (primaryWindow() === w) setPrimaryWindow(liveWindows()[0] || null);
    // The window's own entry is already held, and stays held for the grace
    // period; this write is for the ones still open.
    if (!isQuitting() && liveWindows().length) saveWindowStateSoon();
  });
  return w;
}

// Whether the window is transparent is fixed when it is created — Windows gives
// no way to convert a frameless transparent window into one with a DWM backdrop
// or back. Changing across that boundary therefore needs a new window, and this
// used to be a toast that faded after a couple of seconds, so the setting simply
// appeared to do nothing.
const MATERIAL_NAMES = {
  glass: 'Glass',
  acrylic: 'Acrylic',
  'acrylic-always': 'Acrylic (always on)',
  mica: 'Mica',
  tabbed: 'Tabbed',
  none: 'None'
};

// Asked in the app's own dialog rather than a Windows message box: this is a
// question about Frost's own appearance, and the reason differs by direction —
// one way we're giving up a transparent window, the other we need one.
function promptGlassRestart(material) {
  const target = focusedWindow();
  if (!target) return;
  const to = MATERIAL_NAMES[material] || material;
  const leavingGlass = Boolean(target.isFramelessMode);
  // Each sentence earns the next: what Glass is, what the other thing is, why
  // they can't coexist, what the button does. It used to end on "this one has to
  // be replaced", which left the reader to work out both that "this one" meant
  // the window and that replacing it meant restarting.
  const detail = leavingGlass
    ? `Glass gives Frost a transparent window so it can blur your wallpaper itself. ${to} is drawn by Windows behind a solid window — and a window can't switch between the two once it's open. Restarting opens a fresh one.`
    : `Glass needs a transparent window so Frost can blur your wallpaper itself, rather than letting Windows draw the backdrop. A window can't switch between the two once it's open. Restarting opens a fresh one.`;

  const keepsTabs = (readTheme() || {}).restoreSession !== false;
  const note = keepsTabs
    ? 'Restarting reopens your tabs in the same directories, but it closes their shells: anything still running stops, and the text already on screen is cleared.'
    : 'Restarting closes every shell — anything still running stops and the text on screen is cleared. Session restore is off, so your tabs will not be reopened either.';

  target.webContents.send('app:needsRestart', {
    title: leavingGlass ? `Restart to switch from Glass to ${to}` : `Restart to switch to Glass`,
    detail,
    note
  });
}

ipcMain.on('app:relaunch', () => {
  flushWindowState();
  app.relaunch();
  app.exit(0);
});

function watchConfig() {
  const timers = {};
  chokidar
    .watch([THEME_FILE, CSS_FILE, KEYS_FILE], { ignoreInitial: true })
    .on('all', (_ev, file) => {
      if (path.basename(file || '') === path.basename(KEYS_FILE)) {
        clearTimeout(timers.keys);
        timers.keys = setTimeout(() => {
          const win = primaryWindow();
          if (!win) return;
          const keys = readKeys();
          broadcast(
            'keys:changed',
            keys ? { keys } : { error: 'keybindings.json: invalid JSON — keeping previous keys' }
          );
        }, 60);
        return;
      }
      clearTimeout(timers.theme);
      timers.theme = setTimeout(() => {
        const win = primaryWindow();
        if (!win) return;
        const theme = readTheme();
        if (!theme) {
          broadcast('theme:changed', { error: 'theme.json: invalid JSON — keeping previous theme' });
          return;
        }
        fillSpares(SPARE_REFILL_MS); // edited by hand: spares under the old settings go
        // Compared against what the windows actually are, not against the last
        // material that was asked for. Declining the restart leaves the setting
        // ahead of reality, and comparing to it meant the next change looked
        // like an ordinary switch while still being unappliable.
        const wantsGlass = (theme.material || 'acrylic') === 'glass';
        const mismatched = liveWindows().some((w) => Boolean(w.isFramelessMode) !== wantsGlass);
        applyWindowTheme(theme);
        broadcast('theme:changed', { theme, css: readCss() });
        currentMaterial = theme.material || 'acrylic';
        // Last, because it can restart the app and the renderer should have the
        // new theme first in case the answer is Later.
        if (mismatched) promptGlassRestart(theme.material || 'acrylic');
      }, 60);
    });
}

Object.assign(module.exports, {
  createWindow,
  MATERIAL_NAMES,
  promptGlassRestart,
  watchConfig
});
