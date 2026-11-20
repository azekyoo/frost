// Frost's main process: the order things start in, and nothing else. What each
// part does lives under features/ (shells, windows, agents, updates…), and
// everything that only works on Windows under platform/.
const { Menu, app, ipcMain, powerMonitor, screen } = require('electron');
const path = require('path');

// A run from source shares nothing with an installed Frost: they would
// otherwise sit on the same userData folder, so the single-instance lock is the
// same lock — launching the dev build just told the installed one to open a tab
// — and Chromium's caches are already held open by the running release, which
// is what the "Unable to move the cache" errors were.
// --user-data-dir already says where to put it — the test tools pass one per
// run, and overriding it here put every one of them on the same folder, and so
// on the same single-instance lock: the second app to start just quit.
if (!app.isPackaged && !process.argv.some((a) => a.startsWith('--user-data-dir'))) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Frost (source)'));
}

// Before any handler is registered, so every one of them is timed.
const stalls = require('./stalls');
stalls.install(ipcMain, app.getPath('userData'));

// Each feature registers its IPC handlers as it loads, and some derive paths
// from userData, so they load only now: after the folder is settled and after
// stalls has wrapped ipcMain. Every one is required here, including those main
// never calls, because loading is what puts their handlers in place.
const { SPARE_FIRST_MS } = require('./features/pty/spare-timing');
const { ensureConfig, readTheme } = require('./features/config');
const { focusedWindow } = require('./features/windows/registry');
const { createWindow, watchConfig } = require('./features/windows/window');
const { flushWindowState, readWindowState, markQuitting } = require('./features/windows/state');
const { getStartupLaunch } = require('./features/launch');
const { cleanLaunch } = require('./core/launch');
const { ptys } = require('./features/pty/registry');
const { fillSpares } = require('./features/pty/spares');
const { destroyGhost } = require('./features/tab-drag');
const { initAgentInfra } = require('./features/agents/agents');
const { initUpdates, stopUpdateTimer } = require('./features/updates');
const { identifySourceBuild } = require('./platform');
require('./features/windows/chrome');
require('./features/windows/zoom');
require('./features/windows/ipc');
require('./features/glass');
require('./features/profiles');
require('./features/git');
require('./features/pty/shells');
require('./features/pty/adoption');
require('./features/theme-ipc');
require('./features/agents/sessions');
require('./features/agents/diff');
require('./features/fonts');
require('./features/notify');
require('./features/open');
require('./features/paths');
require('./features/images');
require('./features/peek');

// --- app lifecycle ---

// A shell context-menu click on a second folder should land in the window
// already open, not start a rival process that fights over window.json.
const primaryInstance = app.requestSingleInstanceLock(getStartupLaunch() || {});
if (!primaryInstance) {
  app.quit();
} else {
  app.on('second-instance', (_e, _argv, _cwd, additionalData) => {
    const target = focusedWindow();
    if (!target) return;
    if (target.isMinimized()) target.restore();
    target.focus();
    const launch = cleanLaunch(additionalData);
    if (launch) target.webContents.send('session:openDir', launch);
  });
}

app.whenReady().then(() => {
  // A second launch has handed its arguments over and is quitting, but quitting
  // doesn't stop 'ready': without this it went on to start up, and emptied the
  // agent-status folder the running Frost was using — status files, and the
  // rc file a Git Bash tab opened for that very launch was about to read.
  if (!primaryInstance) return;
  // whatever these set off is named in stalls.log, rather than "unlabelled"
  stalls.labelEmitter(app, 'app');
  stalls.labelEmitter(screen, 'screen');
  stalls.labelEmitter(powerMonitor, 'power');
  if (!app.isPackaged) identifySourceBuild();

  // No application menu at all. An app that never sets one gets Electron's
  // default, and although the window is frameless and never shows it, its
  // accelerators are live and take the key before the terminal does. That menu
  // binds six keys a terminal has its own meaning for: Ctrl+R and Ctrl+Shift+R
  // reload the renderer, which throws the panes away and looks like the shell
  // resetting itself; Ctrl+W closes the window where a shell deletes the word
  // behind the cursor; Ctrl+Q quits where a shell resumes flow control; Ctrl+M
  // minimizes where a terminal reads a carriage return; Ctrl+A selects the page
  // where readline goes to the start of the line. Nothing here wants a reload —
  // there is no such thing in Windows Terminal either — and every key this
  // frees belongs to the shell. What is worth keeping is bound in the
  // renderer's own table, where it can be seen and rebound.
  Menu.setApplicationMenu(null);

  // No setAppUserModelId for packaged builds. It groups the taskbar button under an id of our
  // choosing, and Windows then resolves that button's icon through the id rather
  // than from the window — which showed the Electron logo on an installed build
  // whose window icon was verifiably correct. Left unset, Windows identifies
  // Frost by its executable, and both the executable and the window carry the
  // right icon. Notifications still appear without it; that was checked.
  ensureConfig();
  initAgentInfra();

  // Every window that was open comes back, each with its own geometry and tabs.
  // A directory given on the command line is the point of that launch, so it
  // gets a single fresh window instead.
  const restoring = (readTheme() || {}).restoreSession !== false;
  const saved = restoring && !getStartupLaunch() ? readWindowState() : [];
  createWindow({ isPrimary: true, restore: saved[0] || null });
  for (const entry of saved.slice(1, 8)) createWindow({ restore: entry });

  watchConfig();
  initUpdates();
  fillSpares(SPARE_FIRST_MS);
});

app.on('before-quit', () => {
  stopUpdateTimer();
  destroyGhost();
  flushWindowState();
  markQuitting(); // after the flush: closing windows must not rewrite it
});

app.on('window-all-closed', () => {
  for (const p of ptys.values()) {
    try { p.kill(); } catch {}
  }
  ptys.clear();
  app.quit();
});
