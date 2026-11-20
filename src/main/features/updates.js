const { Notification, app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const stalls = require('../stalls');

const { NOTIFY_ICON_FILE } = require('../env');
const { anyWindowFocused, broadcast, focusedWindow, liveWindows } = require('./windows/registry');
const { flushWindowState } = require('./windows/state');
const { readTheme } = require('./config');
const { markQuitting } = require('./windows/state');

// ---------- updates ----------
// electron-updater against the GitHub releases the CI workflow already cuts:
// the build writes latest.yml beside the installer, the workflow uploads it, and
// that file is what tells a running Frost a newer version exists — plus the
// sha512 it verifies the download against. The builds are unsigned, so there is
// no publisher name to check; the hash is what stands in for one, which is why
// latest.yml has to come from the release rather than from anywhere else.
//
// Installing is left to app quit. A terminal is a window people keep open for
// days with work running inside it, so an update that picks its own moment to
// close it is worse than no update at all. The download is quiet, the install
// happens the next time Frost closes anyway, and settings offers "Restart and
// install" for anyone who would rather have it now.

// Sent to every window on each transition, and returned verbatim by
// update:check, so the settings panel never has to assemble the story itself.
let updateState = {
  stage: 'idle', // idle | checking | current | available | downloading | ready | error | unsupported
  version: app.getVersion(),
  latest: null,
  percent: 0,
  message: '',
  autoDownload: true
};
let updater = null; // the electron-updater singleton, required on first use
let updateTimer = null;

// Windows is signing out or shutting down: see the session-end note in createWindow.
function holdUpdateInstall() {
  if (updater) updater.autoInstallOnAppQuit = false;
}

function stopUpdateTimer() {
  clearInterval(updateTimer);
}
let readyVersion = null; // the release already downloaded and waiting to install

// A portable exe was never installed, so there is no installation for an NSIS
// installer to update — running one would quietly install a second, separate
// Frost. A run from source has no app-update.yml at all. Both check nothing and
// say why; the panel then links to the releases page, which is the update
// mechanism those two builds actually have.
function updateSupport() {
  if (!app.isPackaged) return { ok: false, message: 'Running from source — git pull to update.' };
  if (process.env.PORTABLE_EXECUTABLE_FILE)
    return { ok: false, message: 'Portable build — download a new exe to update.' };
  return { ok: true, message: '' };
}

function setUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  broadcast('update:state', updateState);
}

function updateCfg() {
  const cfg = (readTheme() || {}).update || {};
  return { check: cfg.check !== false, download: cfg.download !== false };
}

function getUpdater() {
  if (updater) return updater;
  // Required lazily: a run from source and a portable build never check, and
  // neither should pay to load the module at startup.
  const { autoUpdater } = require('electron-updater');
  // Never electron-updater's own automatic download: whether to fetch a release
  // is decided in the update-available handler below, which is also the only
  // place that knows whether the release found is the one already waiting.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  stalls.labelEmitter(autoUpdater, 'updater');
  autoUpdater.on('checking-for-update', () => setUpdateState({ stage: 'checking', message: '' }));
  autoUpdater.on('update-not-available', (info) =>
    setUpdateState({ stage: 'current', latest: info?.version || null, message: '' })
  );
  autoUpdater.on('update-available', (info) => {
    const version = info?.version || null;
    // The release waiting to install is found again by every later check. It is
    // already on disk, so the check ends where it started rather than fetching
    // a hundred megabytes a second time.
    if (readyVersion && version === readyVersion) {
      setUpdateState({ stage: 'ready', latest: version, percent: 100, message: '' });
      return;
    }
    setUpdateState({ stage: 'available', latest: version, percent: 0, message: '' });
    if (updateCfg().download) startUpdateDownload();
  });
  autoUpdater.on('download-progress', (p) =>
    setUpdateState({ stage: 'downloading', percent: Math.round(p?.percent || 0) })
  );
  autoUpdater.on('update-downloaded', (info) => onUpdateDownloaded(info?.version || null));
  autoUpdater.on('error', onUpdateError);
  updater = autoUpdater;
  return updater;
}

function onUpdateError(err) {
  // Offline is the common case, and it reads as a stack trace otherwise
  const raw = String(err?.message || err || 'unknown error');
  const offline = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|net::/i.test(raw);
  // electron-updater's text is a chain of wrapped errors ending in the HTTP
  // status ("Cannot parse releases feed: Error: Unable to find latest version
  // on GitHub (...), please ensure a production release exists: HttpError:
  // 504"), and only that last number means anything to a reader. GitHub
  // answers anonymous traffic with 5xx during its own incidents, so that case
  // is said plainly; the raw text stays one hover away for a bug report.
  const m = raw.match(/HttpError:\s*(\d{3})|status(?:Code)?\D{0,3}(\d{3})/i);
  const status = m ? Number(m[1] || m[2]) : 0;
  // A release cut before this feature existed carries the exes but no
  // latest.yml, and the 404 that produces says nothing a reader can act on
  const noInfo = status === 404 || /latest\.yml/i.test(raw);
  const message = offline
    ? 'No connection to GitHub.'
    : status >= 500
      ? "GitHub isn't answering right now. Frost will try again later."
      : status === 403 || status === 429
        ? 'GitHub is limiting requests right now. Frost will try again later.'
        : noInfo
          ? 'The newest release carries no update info — see the release notes.'
          : 'The update check failed. Frost will try again later.';
  setUpdateState({ stage: 'error', percent: 0, message, detail: raw.split('\n')[0] });
}

function onUpdateDownloaded(version) {
  readyVersion = version;
  setUpdateState({ stage: 'ready', latest: version, percent: 100, message: '' });
  notifyUpdateReady(version);
}

// The in-app toast is enough when someone is looking at Frost. Frost is mostly
// sitting behind an editor or minimized, though, and an eight-second toast
// nobody sees meant the update went in at the next quit with no word at all.
// Once per download, not per check: the checks that find the waiting release
// again every six hours are not news.
function notifyUpdateReady(version) {
  if (!liveWindows().length || anyWindowFocused() || !Notification.isSupported()) return;
  const n = new Notification({
    title: version ? `Frost ${version} is ready` : 'A Frost update is ready',
    body: 'It installs the next time you quit Frost.',
    icon: NOTIFY_ICON_FILE
  });
  n.on('click', () => {
    const target = focusedWindow() || liveWindows()[0];
    if (!target) return;
    if (target.isMinimized()) target.restore();
    target.focus();
  });
  n.show();
}

// ---------- "Frost updated" on the first launch of a new version ----------
// The install itself is silent, so without this an update is only ever noticed
// by someone who happened to see the download toast. The last version that ran
// is kept beside the rest of the app's own state; a version newer than it means
// this launch is the first of an update. A fresh install has no record yet and
// is not an update, so it says nothing.

const LAST_VERSION_FILE = path.join(app.getPath('userData'), 'last-version.json');
let justUpdated = null; // { from, to }, handed to the first window that asks

function cmpVersion(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

function recordLaunchVersion() {
  const now = app.getVersion();
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(LAST_VERSION_FILE, 'utf8')).version || null;
  } catch {}
  if (FAKE_UPDATE === 'updated') prev = '0.0.0';
  if (prev && cmpVersion(now, prev) > 0) justUpdated = { from: prev, to: now };
  if (prev !== now && FAKE_UPDATE !== 'updated') {
    try {
      fs.writeFileSync(LAST_VERSION_FILE, JSON.stringify({ version: now }));
    } catch {}
  }
}

// Every window restored at launch would otherwise say it, so only one does.
ipcMain.handle('update:justUpdated', () => {
  const j = justUpdated;
  justUpdated = null;
  return j;
});

// ---------- fake updates, for trying the notices from source ----------
// FROST_FAKE_UPDATE=ready plays a whole download a few seconds after launch,
// ending in the same handler a real one does. =updated makes this launch look
// like the first after an update. =error504 fails the check the way GitHub's
// outages do, through the same error handler. None touches the network, and
// "Restart and install" refuses rather than quitting into an installer that
// doesn't exist.

const FAKE_UPDATE = (process.env.FROST_FAKE_UPDATE || '').toLowerCase() || null;

function playFakeUpdate() {
  const version = app.getVersion().replace(/^(\d+)\.(\d+)\..*$/, (_m, a, b) => `${a}.${+b + 1}.0`);
  setTimeout(() => {
    setUpdateState({ stage: 'checking', message: '' });
    setTimeout(() => {
      setUpdateState({ stage: 'available', latest: version, percent: 0, autoDownload: true });
      let p = 0;
      const t = setInterval(() => {
        p += 20;
        if (p < 100) return setUpdateState({ stage: 'downloading', percent: p });
        clearInterval(t);
        onUpdateDownloaded(version);
      }, 600);
    }, 1000);
  }, 8000);
}

function startUpdateDownload() {
  try {
    setUpdateState({ stage: 'downloading', percent: 0, message: '' });
    getUpdater().downloadUpdate();
  } catch (e) {
    setUpdateState({ stage: 'error', message: String(e?.message || e) });
  }
}

// byUser: a click on "Check now" checks whatever the automatic setting says,
// because the answer to "am I up to date" is worth a request even from someone
// who does not want the background ones.
function checkForUpdates({ byUser = false } = {}) {
  const support = updateSupport();
  if (!support.ok) {
    setUpdateState({ stage: 'unsupported', message: support.message });
    return updateState;
  }
  const cfg = updateCfg();
  if (!byUser && !cfg.check) return updateState;
  // A download in flight is the one thing a check must not interrupt.
  if (updateState.stage === 'downloading') return updateState;
  // A release already downloaded used to stop the checking altogether, on the
  // reasoning that there was nothing left to find. There was: the release after
  // it. Frost stays open for days, so a version could be waiting to install
  // while two newer ones came and went, and the panel went on offering the old
  // one however many times it was asked to check. The check runs; it is the
  // handler that knows to leave a waiting release alone.
  setUpdateState({ autoDownload: cfg.download });
  getUpdater()
    .checkForUpdates()
    .catch(() => {}); // the error event already reported it
  return updateState;
}

function initUpdates() {
  recordLaunchVersion();
  if (FAKE_UPDATE === 'ready') return playFakeUpdate();
  if (FAKE_UPDATE === 'error504') {
    const fail = () =>
      onUpdateError(
        new Error(
          'Cannot parse releases feed: Error: Unable to find latest version on GitHub (https://github.com/azekyoo/frost/releases/latest), please ensure a production release exists: HttpError: 504'
        )
      );
    setTimeout(fail, 3000);
    ipcMain.removeHandler('update:check');
    ipcMain.handle('update:check', () => {
      setUpdateState({ stage: 'checking', message: '' });
      setTimeout(fail, 800);
      return updateState;
    });
    return;
  }
  const support = updateSupport();
  if (!support.ok) {
    updateState = { ...updateState, stage: 'unsupported', message: support.message };
    return;
  }
  setUpdateState({ autoDownload: updateCfg().download });
  // Late enough that the first window is up and its shell has started: a check
  // competes with process spawning for the same disk otherwise, and nothing
  // about it is urgent.
  setTimeout(() => checkForUpdates(), 20_000);
  // Frost stays open for days, so the interval is what actually finds releases
  updateTimer = setInterval(() => checkForUpdates(), 6 * 60 * 60 * 1000);
}

ipcMain.handle('update:get', () => updateState);
ipcMain.handle('update:check', () => checkForUpdates({ byUser: true }));
ipcMain.on('update:download', () => {
  if (updateSupport().ok) startUpdateDownload();
});
ipcMain.on('update:install', () => {
  if (updateState.stage !== 'ready') return;
  if (FAKE_UPDATE) {
    setUpdateState({ stage: 'error', message: 'Fake update (FROST_FAKE_UPDATE) — nothing to install.' });
    return;
  }
  flushWindowState();
  markQuitting();
  // isSilent: the installer runs without asking anything, since the user just
  // answered the only question it would have. isForceRunAfter brings Frost back,
  // which is the whole point of restarting rather than waiting for the next quit.
  try {
    getUpdater().quitAndInstall(true, true);
  } catch (e) {
    setUpdateState({ stage: 'error', message: String(e?.message || e) });
  }
});

Object.assign(module.exports, {
  holdUpdateInstall,
  stopUpdateTimer,
  updateSupport,
  setUpdateState,
  updateCfg,
  getUpdater,
  onUpdateError,
  onUpdateDownloaded,
  notifyUpdateReady,
  LAST_VERSION_FILE,
  cmpVersion,
  recordLaunchVersion,
  FAKE_UPDATE,
  playFakeUpdate,
  startUpdateDownload,
  checkForUpdates,
  initUpdates
});
