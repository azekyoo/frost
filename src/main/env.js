// Where Frost's files are and where its settings live, decided once at startup.
// Everything that locates something relative to this source tree goes through
// here, so moving a feature file never moves what it points at.
const { app } = require('electron');
const path = require('path');

const MAIN_DIR = __dirname;
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

// Set by tools/shots.js to render the README screenshots: an isolated config
// directory, a wallpaper to use instead of the desktop's, and fixed window
// bounds. Ignored in normal use.
const SHOT = (() => {
  try {
    return process.env.FROST_SHOT ? JSON.parse(process.env.FROST_SHOT) : null;
  } catch {
    return null;
  }
})();

// Installed builds live somewhere unwritable (Program Files, or a read-only
// asar), so their config goes to %APPDATA%. Running from source keeps using the
// repo's config/ folder, which keeps the dev loop and .gitignore intact.
const CONFIG_DIR =
  SHOT?.configDir ||
  (app.isPackaged
    ? path.join(app.getPath('userData'), 'config')
    : path.join(__dirname, '..', '..', 'config'));
const THEME_FILE = path.join(CONFIG_DIR, 'theme.json');
const CSS_FILE = path.join(CONFIG_DIR, 'theme.css');
const AGENTS_FILE = path.join(CONFIG_DIR, 'agents.json');
const KEYS_FILE = path.join(CONFIG_DIR, 'keybindings.json');
const WINDOW_FILE = path.join(CONFIG_DIR, 'window.json');
const ZOOM_FILE = path.join(CONFIG_DIR, 'zoom.json');

// Where agents report to Frost: hook output, launch markers, per-agent settings
// and rc files. Emptied at every start (initAgentInfra).
const STATUS_DIR = path.join(app.getPath('userData'), 'agent-status');

// Height of the native window-button overlay, in unzoomed CSS pixels. Kept here
// because the overlay has to be re-sized whenever the UI zoom changes: it is the
// one part of the titlebar the renderer does not draw.
const TITLEBAR_H = 44;

// Windows wants a real file for a window icon. Inside the asar it can be read
// but not always applied, and when it isn't, Electron falls back to its own
// default icon — which is why a packaged Frost could show the Electron logo on
// the taskbar while the Start Menu shortcut, which the installer stamps, was
// right. Packaged builds therefore ship it as a resource on disk.
const ICON_FILE = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.ico')
  : path.join(__dirname, '..', '..', 'assets', 'icon.ico');

const NOTIFY_ICON_FILE = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(__dirname, '..', '..', 'assets', 'icon.png');

Object.assign(module.exports, {
  MAIN_DIR,
  RENDERER_DIR,
  SHOT,
  CONFIG_DIR,
  THEME_FILE,
  CSS_FILE,
  AGENTS_FILE,
  KEYS_FILE,
  WINDOW_FILE,
  ZOOM_FILE,
  STATUS_DIR,
  TITLEBAR_H,
  ICON_FILE,
  NOTIFY_ICON_FILE
});
