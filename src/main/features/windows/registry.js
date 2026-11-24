const { BrowserWindow, ipcMain, screen } = require('electron');

// ---------- window registry ----------
// Frost can have several windows. `win` is kept as the primary one — the window
// whose layout is saved and restored, and the fallback for anything that isn't
// tied to a particular sender.

let win = null;
const primaryWindow = () => win;
const setPrimaryWindow = (w) => {
  win = w;
};

const windows = new Set();

const liveWindows = () => [...windows].filter((w) => !w.isDestroyed());

// Everything the whole app cares about — themes, keys, agent lists — goes to
// every window, since none of that is per-window state.
function broadcast(channel, payload) {
  for (const w of liveWindows()) w.webContents.send(channel, payload);
}

const windowOf = (event) => BrowserWindow.fromWebContents(event.sender);

function focusedWindow() {
  // windows.has: the drag ghost is a BrowserWindow of its own and is never one
  // of these, however Windows happens to have ordered them
  const active = BrowserWindow.getFocusedWindow();
  if (active && windows.has(active)) return active;
  return (win && !win.isDestroyed() ? win : liveWindows()[0]) || null;
}

const anyWindowFocused = () => liveWindows().some((w) => w.isFocused());

function glassBounds(target) {
  const w = target && !target.isDestroyed() ? target : win;
  if (!w) return { bounds: null, display: null };
  return {
    bounds: w.getContentBounds(),
    display: screen.getDisplayMatching(w.getBounds()).bounds
  };
}

// Only one window may host the agent tab: agents are global, so a second one
// would render an identical list and both would fight over the diff watcher.
let agentWindow = null;
const getAgentWindow = () => agentWindow;
const setAgentWindow = (w) => {
  agentWindow = w;
};

// Agent tabs are unique across the app, not per window. A window asking for one
// either takes ownership or is told which window already has it.
ipcMain.handle('agents:claimTab', (event) => {
  const me = windowOf(event);
  if (agentWindow && !agentWindow.isDestroyed() && agentWindow !== me) {
    if (agentWindow.isMinimized()) agentWindow.restore();
    agentWindow.focus();
    return { owned: false };
  }
  agentWindow = me;
  return { owned: true };
});

ipcMain.on('agents:releaseTab', (event) => {
  if (agentWindow === windowOf(event)) agentWindow = null;
});

Object.assign(module.exports, {
  windows,
  liveWindows,
  broadcast,
  windowOf,
  focusedWindow,
  anyWindowFocused,
  glassBounds,
  primaryWindow,
  setPrimaryWindow,
  getAgentWindow,
  setAgentWindow
});
