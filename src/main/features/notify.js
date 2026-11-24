const { Notification, ipcMain } = require('electron');
const path = require('path');
const stalls = require('../stalls');

const { DEFAULT_THEME, readTheme } = require('./config');
const { NOTIFY_ICON_FILE } = require('../env');
const { anyWindowFocused, focusedWindow, liveWindows } = require('./windows/registry');
const { getAgentWindow } = require('./windows/registry');

// ---------- notifications ----------
// Only ever raised when the window doesn't have focus. Inside Frost the tab dot
// already tells you, and a toast for something you're looking at is noise.

function notifySettings() {
  const configured = (readTheme() || {}).notify;
  return { ...DEFAULT_THEME.notify, ...(configured || {}) };
}

function notifyRaw({ title, body, agentId }) {
  if (!liveWindows().length || anyWindowFocused() || !Notification.isSupported()) return;
  const toast = new Notification({
    title,
    body,
    icon: NOTIFY_ICON_FILE
  });
  toast.on('click', () => {
    const agentWindow = getAgentWindow();
    const target = (agentWindow && !agentWindow.isDestroyed() && agentWindow) || focusedWindow();
    if (!target) return;
    if (target.isMinimized()) target.restore();
    target.focus();
    if (agentId) target.webContents.send('agent:reveal', agentId);
  });
  toast.show();
  // Flashing the taskbar button covers the case where notifications are muted
  // by focus assist; Windows stops it as soon as the window is activated.
  for (const w of liveWindows()) {
    try {
      w.flashFrame(true);
    } catch {}
  }
}
const notify = stalls.timed('notify', notifyRaw);

ipcMain.on('notify:command', (_e, { seconds, cwd, exit }) => {
  const settings = notifySettings();
  const threshold = Number(settings.commandSeconds) || 0;
  if (!threshold || seconds < threshold) return;
  const how = exit === 0 ? 'finished' : Number.isFinite(exit) ? `failed (exit ${exit})` : 'finished';
  notify({
    title: `Command ${how} after ${Math.round(seconds)}s`,
    body: cwd ? path.basename(cwd) : 'Frost'
  });
});

Object.assign(module.exports, {
  notifySettings,
  notifyRaw,
  notify
});
