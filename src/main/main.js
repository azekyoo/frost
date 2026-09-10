const {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  nativeImage,
  net,
  Notification,
  ipcMain,
  shell,
  nativeTheme,
  screen,
  dialog
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const chokidar = require('chokidar');
const pty = require('@lydell/node-pty');

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
const SESSIONS_FILE = path.join(CONFIG_DIR, 'sessions.json');
const KEYS_FILE = path.join(CONFIG_DIR, 'keybindings.json');
const WINDOW_FILE = path.join(CONFIG_DIR, 'window.json');
const ZOOM_FILE = path.join(CONFIG_DIR, 'zoom.json');

// Height of the native window-button overlay, in unzoomed CSS pixels. Kept here
// because the overlay has to be re-sized whenever the UI zoom changes: it is the
// one part of the titlebar the renderer does not draw.
const TITLEBAR_H = 44;

// Only overrides live in this file; the defaults stay in code so new versions
// can add keys without rewriting a file the user owns. Ctrl+Shift+P lists every
// command with its current key.
const DEFAULT_KEYS = {
  _help: [
    'Overrides for Frost built-in keys. Each entry: { "keys": "ctrl+shift+t", "command": "tab.new" }.',
    'Same "keys" as a built-in replaces it; "command": null unbinds it.',
    'Optional "args", e.g. { "keys": "ctrl+1", "command": "tab.go", "args": { "index": 1 } }.',
    'Keys are physical positions, so they behave the same on every layout.',
    'Press Ctrl+Shift+P for the command list.'
  ].join(' '),
  bindings: []
};

const DEFAULT_THEME = {
  material: 'glass',
  colorMode: 'dark',
  glassBlur: 33,
  // Floor on how much the glass backdrop is darkened behind text. Tint alone is
  // a look; this is legibility, and a wallpaper can be arbitrarily bright.
  glassReadability: 0.3,
  // Off. It exists for palettes built for an opaque black background, and it
  // pays for legibility by dragging every colour towards the foreground: a
  // PowerShell error came out pastel pink rather than red. The palette below is
  // chosen to be readable over glass on its own, so nothing has to be recoloured.
  minContrast: 1,
  // Off by default, which is the opposite of what a terminal usually wants. The
  // GPU renderer rasterises each glyph once into a texture atlas and blends it
  // over whatever is behind the window; every pane in Frost is transparent, so
  // that blend is grayscale antialiasing against an unknown backdrop and the
  // text comes out gritty. The DOM renderer hands the text to the browser, which
  // hints and gamma-corrects it the way the rest of Windows does, and the
  // difference is plain at a glance. The toggle stays for anyone whose work is
  // firehose output rather than reading.
  gpuRenderer: false,
  autoDetectAgents: true,
  // Off, like every other Windows terminal: a shell that comes back with
  // yesterday's tabs in it is a surprise, and the tabs it restores are empty
  // shells in the right directories rather than the work that was in them.
  restoreSession: false,
  notify: { agentBlocked: true, agentDone: true, commandSeconds: 20 },
  // check: look for a newer release at startup and every six hours. download:
  // fetch it when one is found. Either way the installer only runs when Frost
  // quits, or when you ask for it in settings.
  update: { check: true, download: true },
  agentLayout: { rail: 210, diff: 340 },
  copyOnSelect: true,
  // Text with line breaks in it is typed into the shell as typed input, and a
  // line ending in a newline runs. The clipboard is not always the user's own
  // writing, so the paste is confirmed once rather than trusted silently.
  // warnInAgent is off: inside a claude session a wall of logs is ordinary
  // input, nothing runs on arrival, and a prompt answered by reflex guards
  // nothing.
  paste: { warnMultiline: true, warnInAgent: false },
  unicodeVersion: '11',
  tint: 'rgba(0, 0, 0, 0.00)',
  accent: '#80a8ff',
  padding: 14,
  cornerRadius: 13,
  font: {
    family: '"Cascadia Mono", Consolas, monospace',
    // 16px, not 14. Windows Terminal's font size is in points and its default is
    // 12pt — 16px — so a terminal that says 14 looks smaller than the one people
    // compare it against, for no reason they can name.
    size: 16,
    lineHeight: 1.15,
    // Below normal, which is not what a transparent window suggests. Composited
    // text is antialiased in grayscale rather than with ClearType, and against a
    // white foreground over a photograph those soft edges read as extra mass
    // rather than as softness — 400 looks fat here where it looks ordinary on an
    // opaque terminal. 350 is Cascadia's variable axis interpolating genuinely
    // lighter (the axis runs 200–700), so the strokes thin without losing a pixel
    // anywhere, and bold at 700 is still bold.
    weight: 350,
    // On, and free where there is nothing to do: the renderer asks the font
    // whether it draws => as one glyph before changing anything, so the default
    // font here — Cascadia Mono, which has no ligatures, that being its whole
    // difference from Cascadia Code — is rendered exactly as it was. Pick a font
    // that has them and they appear without a setting to find.
    ligatures: true
  },
  cursor: { style: 'bar', blink: true },
  // smoothMs: 0 restores xterm's instant row-at-a-time scroll. lines is rows per
  // wheel notch, fastLines the same while Shift is held.
  scroll: { smoothMs: 90, lines: 3, fastLines: 10 },
  // Lines kept after they scroll off the top, per pane. What is not kept cannot
  // be scrolled to and cannot be found by search — it is gone rather than
  // hidden — and it is memory, so the renderer holds this to 1,000–200,000.
  scrollback: 10000,
  // Not Campbell. Windows Terminal's palette assumes an opaque black background,
  // and half of it — red, blue, magenta — is too dark to read through a window
  // that shows the wallpaper behind it. Nor is it a muted designer scheme: those
  // are tuned against one fixed background, and what reads as tasteful on it
  // reads as washed out over a photograph. Every colour here is near-full
  // saturation and kept bright enough to hold its own against a light
  // wallpaper — vivid first, and recognisably the colour it is named after.
  terminal: {
    // White, not the palette's blue-tinted white. Glass shows the wallpaper
    // through the text's own antialiasing, so a foreground that is 92% bright
    // and slightly blue reads as grey next to an opaque terminal's white.
    foreground: '#ffffff',
    cursor: '#ffffff',
    selectionBackground: 'rgba(255, 255, 255, 0.30)',
    black: '#12141f',
    red: '#ff3b4e',
    green: '#20e070',
    yellow: '#ffc21f',
    blue: '#3d97ff',
    magenta: '#f04bff',
    cyan: '#12dcf0',
    white: '#e4ebff',
    brightBlack: '#8d97c4',
    brightRed: '#ff6b78',
    brightGreen: '#4dff96',
    brightYellow: '#ffdc4d',
    brightBlue: '#6fb6ff',
    brightMagenta: '#ff7dff',
    brightCyan: '#5cf2ff',
    brightWhite: '#ffffff'
  }
};

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

function appIcon() {
  try {
    const image = nativeImage.createFromPath(ICON_FILE);
    return image.isEmpty() ? undefined : image;
  } catch {
    return undefined;
  }
}

let win = null;
let ptyCounter = 0;
const ptys = new Map();
// A shell belongs to the window that asked for it, so its output must go there
// and nowhere else.
const ptyOwners = new Map(); // ptyId -> WebContents
// What the shell was started as, kept because a tab moved to another window has
// to arrive there knowing which profile it came from — the window that created
// it is not necessarily still around to say.
const ptyMeta = new Map(); // ptyId -> { profileId, profileName }

// A tab moving between windows leaves its shells ownerless for as long as it
// takes the new window to load: the old renderer has already disposed its
// terminals, the new one does not exist yet. Output arriving in that gap has
// nowhere to go, and dropping it would eat the tail of whatever was running —
// so it is held here and replayed to the window that adopts the shell.
const detachedPtys = new Map(); // ptyId -> { chunks: [], bytes, exit? }
// Enough for a build's worth of output in the half-second a window takes to
// open. Past it the oldest goes, which is what a terminal does anyway.
const DETACH_BUFFER_MAX = 512 * 1024;

function sendToOwner(id, channel, payload) {
  const owner = ptyOwners.get(id);
  if (owner && !owner.isDestroyed()) {
    owner.send(channel, payload);
    return;
  }
  const held = detachedPtys.get(id);
  if (!held) return; // no owner and not in flight: the pane is simply gone
  if (channel === 'pty:exit') {
    held.exit = payload?.exitCode ?? 0;
    return;
  }
  if (channel !== 'pty:data') return;
  held.chunks.push(payload.data);
  held.bytes += payload.data.length;
  while (held.bytes > DETACH_BUFFER_MAX && held.chunks.length > 1) {
    held.bytes -= held.chunks.shift().length;
  }
}

// ---------- shell profiles ----------
// A profile is { id, name, shell, args[], cwd?, env?, agentWrapper }.
// agentWrapper picks the shell dialect used to inject the `claude` wrapper:
// 'powershell' | 'bash' | 'none' (no agent auto-detect in that shell).

function whichExe(name) {
  const r = spawnSync('where.exe', [name], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout && r.stdout.trim()) {
    const hits = r.stdout.trim().split(/\r?\n/);
    // prefer a real executable over a shim: `where code` lists an extensionless
    // launcher script that Node can't spawn without a shell
    const exes = hits.filter((h) => /\.exe$/i.test(h));
    // A Store app is listed twice: inside its versioned package directory and
    // again as the execution alias. The alias tracks whichever version is
    // current, which is what we would rather record — but it is a reparse
    // point that ConPTY cannot start, so take the real file and let the spawn
    // recover when an update moves it.
    return exes.find((h) => fs.existsSync(h)) || exes[0] || hits[0];
  }
  return null;
}

function wslDistros() {
  // wsl.exe -l -q writes UTF-16LE, so decode the raw buffer ourselves
  const r = spawnSync('wsl.exe', ['-l', '-q'], { encoding: 'buffer' });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .toString('utf16le')
    .split(/\r?\n/)
    .map((s) => s.replace(/\0/g, '').trim())
    .filter(Boolean);
}

function detectProfiles() {
  const out = [];
  const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

  const pwsh = whichExe('pwsh');
  if (pwsh) out.push({ id: 'pwsh', name: 'PowerShell', shell: pwsh, args: [], agentWrapper: 'powershell' });

  const wps = path.join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (fs.existsSync(wps)) {
    out.push({ id: 'powershell', name: 'Windows PowerShell', shell: wps, args: [], agentWrapper: 'powershell' });
  }

  const cmd = path.join(sys, 'cmd.exe');
  if (fs.existsSync(cmd)) {
    out.push({ id: 'cmd', name: 'Command Prompt', shell: cmd, args: [], agentWrapper: 'none' });
  }

  for (const base of [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')
  ]) {
    if (!base) continue;
    const b = path.join(base, 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(b)) {
      out.push({ id: 'git-bash', name: 'Git Bash', shell: b, args: ['-i', '-l'], agentWrapper: 'bash' });
      break;
    }
  }

  const wsl = whichExe('wsl.exe');
  if (wsl) {
    // docker-desktop* are Docker's plumbing distros, not shells anyone wants
    for (const d of wslDistros().filter((d) => !/^docker-desktop/i.test(d))) {
      out.push({
        id: 'wsl-' + d.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        name: d + ' (WSL)',
        shell: wsl,
        args: ['-d', d, '--cd', '~'],
        agentWrapper: 'none'
      });
    }
  }

  if (!out.length) {
    out.push({ id: 'powershell', name: 'Windows PowerShell', shell: 'powershell.exe', args: [], agentWrapper: 'powershell' });
  }
  return out;
}

function getProfiles() {
  const t = readTheme();
  return Array.isArray(t?.profiles) && t.profiles.length ? t.profiles : detectProfiles();
}

function findProfile(id) {
  const list = getProfiles();
  const def = readTheme()?.defaultProfile;
  return list.find((p) => p.id === id) || list.find((p) => p.id === def) || list[0];
}

function ensureConfig() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(THEME_FILE)) {
    fs.writeFileSync(THEME_FILE, JSON.stringify(DEFAULT_THEME, null, 2));
  }
  // fill in shell profiles for configs written before profiles existed
  const t = readTheme();
  if (t && (!Array.isArray(t.profiles) || !t.profiles.length)) {
    t.profiles = detectProfiles();
    t.defaultProfile = t.defaultProfile || t.profiles[0].id;
    fs.writeFileSync(THEME_FILE, JSON.stringify(t, null, 2));
  }
  if (!fs.existsSync(AGENTS_FILE)) {
    fs.writeFileSync(AGENTS_FILE, JSON.stringify({ spaces: [] }, null, 2));
  }
  if (!fs.existsSync(KEYS_FILE)) {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(DEFAULT_KEYS, null, 2));
  }
  if (!fs.existsSync(CSS_FILE)) {
    fs.writeFileSync(
      CSS_FILE,
      [
        '/* theme.css — raw CSS injected into the terminal window. Hot-reloads on save. */',
        '/* Anything goes: override CSS variables, restyle tabs, add animations...   */',
        '/* Examples:                                                                */',
        '/*   :root { --tint: rgba(40, 0, 60, 0.4); }                                */',
        '/*   .tab.active { box-shadow: 0 0 12px var(--accent); }                    */',
        ''
      ].join('\n')
    );
  }
}

function readTheme() {
  try {
    return JSON.parse(fs.readFileSync(THEME_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function readCss() {
  try {
    return fs.readFileSync(CSS_FILE, 'utf8');
  } catch {
    return '';
  }
}

function readKeys() {
  try {
    const k = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    return Array.isArray(k.bindings) ? k.bindings : [];
  } catch {
    return null; // invalid JSON — caller keeps whatever is loaded
  }
}

let currentMaterial = 'acrylic';

// Wallpaper for the 'glass' material — the app blurs it itself, DWM stays out.
function getWallpaperDataUrl() {
  try {
    if (SHOT?.wallpaper && fs.existsSync(SHOT.wallpaper)) {
      return 'data:image/png;base64,' + fs.readFileSync(SHOT.wallpaper).toString('base64');
    }
    const r = spawnSync('reg', ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'WallPaper'], {
      encoding: 'utf8'
    });
    const m = /WallPaper\s+REG_SZ\s+(.+)/.exec(r.stdout || '');
    const p = m && m[1].trim();
    if (!p || !fs.existsSync(p)) return null;
    const mime = path.extname(p).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,` + fs.readFileSync(p).toString('base64');
  } catch {
    return null;
  }
}

// ---------- window registry ----------
// Frost can have several windows. `win` is kept as the primary one — the window
// whose layout is saved and restored, and the fallback for anything that isn't
// tied to a particular sender.

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
  // The native buttons are drawn by Windows, not by us, so they only match the
  // zoomed titlebar the renderer draws if the overlay is resized to match.
  if (!w.isFramelessMode) {
    try {
      w.setTitleBarOverlay({ height: Math.round(TITLEBAR_H * factor) });
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

function applyWindowTheme(theme) {
  if (!theme) return;
  // The acrylic/mica base layer follows the app's color mode:
  // light mode = whitish frost, dark mode = dark smoke.
  nativeTheme.themeSource = theme.colorMode || 'dark';
  const material = theme.material || 'acrylic';
  for (const w of liveWindows()) {
    // A frameless window is the glass one and paints its own backdrop; 'glass'
    // is not a DWM material, so there is nothing to hand Windows either way.
    if (w.isFramelessMode || material === 'glass') continue;
    try {
      w.setBackgroundMaterial(material === 'acrylic-always' ? 'acrylic' : material);
    } catch {}
    try {
      w.setTitleBarOverlay({
        color: '#00000000',
        symbolColor: theme.terminal?.foreground || '#ffffff',
        // must track the zoom, or changing any theme setting shrinks the native
        // buttons back to their unzoomed height while the titlebar stays tall
        height: Math.round(TITLEBAR_H * (w.webContents.getZoomFactor() || 1))
      });
    } catch {}
  }
}

// ---------- window + session state ----------
// window.json is written continuously rather than on close, so a crash or a
// kill still leaves the last layout on disk.

const sessionLayouts = new Map(); // frostId -> { tabs, activeTab } as reported
const lastBounds = new Map(); // frostId -> bounds, for windows that are minimised
const pendingLayouts = new Map(); // frostId -> the layout a new window should restore
// Closing three windows one at a time is how a person leaves; closing one and
// carrying on with the other two is a decision to have one window fewer. The
// difference is only visible in the timing, so a closed window's entry is kept
// for a while: long enough to cover the last few clicks of leaving, short
// enough that a window closed and forgotten about does not come back tomorrow.
const CLOSE_GRACE_MS = SHOT?.closeGraceMs ?? 20000;
const recentlyClosed = new Map(); // frostId -> { at, entry }, pruned on write

// Every shell in a moved tab's saved tree, however deeply it is split
function ptyIdsOf(node) {
  if (!node) return [];
  if (node.t === 'split') return (node.children || []).flatMap(ptyIdsOf);
  return node.ptyId ? [node.ptyId] : [];
}
let sessionTimer = null;
let windowCounter = 0;
let quitting = false;

// window.json holds one entry per window. Files written before that was true had
// a single window's fields at the top level, so they're read as one window.
function readWindowState() {
  try {
    const raw = JSON.parse(fs.readFileSync(WINDOW_FILE, 'utf8'));
    if (Array.isArray(raw.windows)) return raw.windows;
    return raw.tabs || raw.bounds ? [raw] : [];
  } catch {
    return [];
  }
}

// Reject bounds that no longer land on a monitor — an unplugged second screen
// would otherwise park the window somewhere unreachable.
function boundsVisible(b) {
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.width)) return false;
  return screen.getAllDisplays().some(({ workArea: w }) => {
    return (
      b.x < w.x + w.width - 40 &&
      b.x + b.width > w.x + 40 &&
      b.y < w.y + w.height - 40 &&
      b.y + b.height > w.y + 40
    );
  });
}

// A window size is only meaningful next to the screen it was chosen on: two
// thirds of a laptop panel is a third of a 4K one, and restoring the rectangle
// verbatim onto a different monitor produces a window nobody asked for. The
// saved geometry therefore carries the work area it was measured against, and
// is re-proportioned when it comes back to a screen of another size.
function scaleBoundsTo(b, from, to) {
  if (!b || !from || !from.width || !from.height) return null;
  const fw = Math.min(1, b.width / from.width);
  const fh = Math.min(1, b.height / from.height);
  const width = Math.max(480, Math.round(to.width * fw));
  const height = Math.max(300, Math.round(to.height * fh));
  const fx = Math.min(Math.max((b.x - from.x) / from.width, 0), 1);
  const fy = Math.min(Math.max((b.y - from.y) / from.height, 0), 1);
  return {
    width,
    height,
    x: Math.max(to.x, Math.min(Math.round(to.x + fx * to.width), to.x + to.width - width)),
    y: Math.max(to.y, Math.min(Math.round(to.y + fy * to.height), to.y + to.height - height))
  };
}

// A window with nothing to restore is sized the way Windows Terminal sizes its
// own: 120 columns by 30 rows. A share of the display was the other candidate,
// and it makes a terminal that is two thirds of a 4K monitor wide for no reason
// anyone asked for. Frost's default font is Windows Terminal's default font at
// its default size, so the same grid lands on the same window.
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

function defaultBoundsFor(display) {
  const theme = readTheme() || DEFAULT_THEME;
  const font = theme.font || DEFAULT_THEME.font;
  const size = Number(font.size) > 0 ? Number(font.size) : DEFAULT_THEME.font.size;
  const lineHeight =
    Number(font.lineHeight) > 0 ? Number(font.lineHeight) : DEFAULT_THEME.font.lineHeight;
  const pad = Number.isFinite(theme.padding) ? theme.padding : DEFAULT_THEME.padding;
  // 0.6em is the advance width of Cascadia Mono and of the faces Windows falls
  // back to. The real cell is only known once the renderer has measured the
  // font, so this is close rather than exact — a couple of columns either way.
  const wa = display.workArea;
  const width = Math.min(wa.width, Math.round(DEFAULT_COLS * size * 0.6 + pad * 2));
  const height = Math.min(
    wa.height,
    Math.round(DEFAULT_ROWS * size * lineHeight + pad * 2) + TITLEBAR_H
  );
  return {
    width,
    height,
    x: wa.x + Math.round((wa.width - width) / 2),
    y: wa.y + Math.round((wa.height - height) / 2)
  };
}

const cursorDisplay = () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

// Everything worth writing down about one window, measured now.
function windowEntry(w) {
  // A minimised window reports nonsense bounds, so keep the last real ones.
  if (!w.isMinimized()) {
    const d = screen.getDisplayMatching(w.getBounds());
    lastBounds.set(w.frostId, {
      bounds: w.getNormalBounds(),
      maximized: w.isMaximized(),
      display: { key: displayKeyOf(d), workArea: d.workArea }
    });
  }
  const geometry = lastBounds.get(w.frostId) || {};
  return { ...geometry, ...(sessionLayouts.get(w.frostId) || { tabs: [], activeTab: 0 }) };
}

function flushWindowState() {
  clearTimeout(sessionTimer);
  sessionTimer = null;
  const now = Date.now();
  for (const [id, rec] of recentlyClosed) {
    if (now - rec.at > CLOSE_GRACE_MS) recentlyClosed.delete(id);
  }
  // A window in the middle of closing is still live, and its entry was taken
  // when the close began — the one in hand is the better of the two.
  const entries = [
    ...liveWindows()
      .filter((w) => !recentlyClosed.has(w.frostId))
      .map((w) => ({ seq: w.frostId, entry: windowEntry(w) })),
    ...[...recentlyClosed].map(([id, rec]) => ({ seq: id, entry: rec.entry }))
  ].sort((a, b) => a.seq - b.seq);
  // Nothing left to describe: an empty file would throw away the layout we're
  // trying to preserve.
  if (!entries.length) return;
  const windows = entries.map((e) => e.entry);
  try {
    fs.writeFileSync(WINDOW_FILE, JSON.stringify({ windows }, null, 2));
  } catch {}
}

function saveWindowStateSoon() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(flushWindowState, 500);
}

// Only one window may host the agent tab: agents are global, so a second one
// would render an identical list and both would fight over the diff watcher.
let agentWindow = null;

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
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  };

  if (glass) {
    // Frameless but solid: the renderer paints its own blurred wallpaper and
    // window buttons, and that wallpaper is opaque, so the window never needed
    // to be transparent — the only thing transparency bought was a corner
    // radius we could pick ourselves. It cost far more than that. A transparent
    // window is layered, gets no WS_THICKFRAME, and Windows therefore refuses
    // it Aero Snap, snap layouts, a sizing border, a drop shadow and the
    // minimise animation. Solid buys all of that back, and DWM rounds the
    // corners itself.
    opts.transparent = false;
    opts.frame = false;
    opts.roundedCorners = true;
    opts.backgroundColor = theme.terminal?.background || '#101014';
  } else {
    opts.backgroundMaterial = alwaysOn ? 'acrylic' : material;
    opts.titleBarStyle = 'hidden';
    opts.titleBarOverlay = {
      color: '#00000000',
      symbolColor: theme.terminal?.foreground || '#ffffff',
      height: TITLEBAR_H
    };
  }

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
  if (isPrimary) win = w;
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

  // Windows dims/disables the acrylic backdrop when the window deactivates.
  // Re-applying the material right after blur makes DWM repaint it in its
  // active look — keeps the blur constant when unfocused.
  w.on('blur', () => {
    if (currentMaterial === 'acrylic-always') {
      try {
        w.setBackgroundMaterial('none');
        w.setBackgroundMaterial('acrylic');
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
  w.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
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
    if (agentWindow === w) agentWindow = null;
    // A window closing while one of its tabs was mid-drag would leave the copy
    // hanging over the desktop with nothing driving it.
    if (ghostWin && !ghostWin.isDestroyed()) {
      if (liveWindows().length) ghostWin.hide();
      // Otherwise it would be the one window still open, and window-all-closed
      // — which is what quits Frost — would never fire.
      else ghostWin.destroy();
    }
    // hand primary status on, so the last window standing still saves its state
    if (win === w) win = liveWindows()[0] || null;
    // The window's own entry is already held, and stays held for the grace
    // period; this write is for the ones still open.
    if (!quitting && liveWindows().length) saveWindowStateSoon();
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
        if (!win) return;
        const theme = readTheme();
        if (!theme) {
          broadcast('theme:changed', { error: 'theme.json: invalid JSON — keeping previous theme' });
          return;
        }
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

function startDir() {
  const d = readTheme()?.startDir;
  if (d && fs.existsSync(d)) return d;
  return process.env.USERPROFILE || process.cwd();
}

// `frost .` and the "Open Frost here" shell entry both arrive as a directory
// argument. Packaged, argv is [exe, ...args]; from source it's [electron, '.', ...].
function dirFromArgv(argv) {
  for (const a of argv.slice(app.isPackaged ? 1 : 2)) {
    if (!a || a.startsWith('-')) continue;
    try {
      const p = path.resolve(a);
      if (fs.statSync(p).isDirectory()) return p;
    } catch {}
  }
  return null;
}

// --- IPC ---

// Session-local `claude` wrapper: announces launches to the app (start/end +
// cwd) and quietly adds the status-hooks settings file. Lives only inside
// terminals this app spawns — the user's profile and global config untouched.
const CLAUDE_WRAPPER =
  'function claude { ' +
  '$exe = (Get-Command claude -CommandType Application | Select-Object -First 1).Source; ' +
  'if (-not $exe) { Write-Error "claude not found"; return }; ' +
  'Set-Content -LiteralPath $env:FROST_LAUNCH -Value ("start|" + (Get-Location).Path) -Encoding UTF8; ' +
  '& $exe --settings $env:FROST_HOOKS @args; ' +
  'Set-Content -LiteralPath $env:FROST_LAUNCH -Value ("end|" + (Get-Location).Path) -Encoding UTF8 ' +
  '}';

// Reports the shell's cwd to the app on every prompt via OSC 9;9 (the sequence
// Windows Terminal uses). Wraps whatever `prompt` the user's profile installed
// — starship, oh-my-posh — instead of replacing it: -Command runs after the
// profile has loaded.
// Also emits OSC 133 command marks: D;<exit> closes the command that just ran,
// A marks where this prompt begins. Together they let Frost show how each
// command ended and jump between them. $? has to be read before anything else
// in the function, or it reports on our own statements instead.
const PS_CWD_HOOK =
  '$global:__frostPrompt = $function:prompt; ' +
  'function global:prompt { ' +
  '$__ok = $?; $__ec = $LASTEXITCODE; ' +
  '$__code = if ($__ok) { 0 } elseif ($__ec) { $__ec } else { 1 }; ' +
  '$out = try { & $global:__frostPrompt } catch { "PS " + (Get-Location).Path + "> " }; ' +
  'try { $l = Get-Location; if ($l.Provider.Name -eq "FileSystem") { ' +
  '[Console]::Write([char]27 + "]9;9;" + $l.ProviderPath + [char]7) } } catch {}; ' +
  'try { ' +
  'if ($global:__frostSeen) { [Console]::Write([char]27 + "]133;D;" + $__code + [char]7) }; ' +
  '$global:__frostSeen = $true; ' +
  '[Console]::Write([char]27 + "]133;A" + [char]7) } catch {}; ' +
  '$out }';

function psStartup(withClaude) {
  return withClaude ? CLAUDE_WRAPPER + '; ' + PS_CWD_HOOK : PS_CWD_HOOK;
}

// Same two jobs for bash-family shells (Git Bash, MSYS), delivered as an rc
// file so the user's own ~/.bashrc still loads. `type -P` skips functions,
// otherwise the claude wrapper would resolve to itself and recurse.
function bashRc(withClaude) {
  const lines = [
    '# Frost session rc — exists only inside terminals Frost spawns.',
    '[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc',
    '[ -f ~/.bashrc ] && . ~/.bashrc'
  ];
  if (withClaude) {
    lines.push(
      'claude() {',
      '  local exe; exe=$(type -P claude) || exe=""',
      '  if [ -z "$exe" ]; then echo "claude not found" >&2; return 1; fi',
      '  local here; here=$(pwd -W 2>/dev/null || pwd)',
      '  printf "start|%s" "$here" > "$FROST_LAUNCH"',
      '  "$exe" --settings "$FROST_HOOKS" "$@"',
      '  printf "end|%s" "$here" > "$FROST_LAUNCH"',
      '}'
    );
  }
  lines.push(
    // pwd -W gives the Windows path under MSYS, so Frost gets a path it can stat
    // BEL-terminated: keeps the format string free of backslash escaping traps
    "__frost_cwd() { local p; p=$(pwd -W 2>/dev/null || pwd); printf '\\033]9;9;%s\\007' \"$p\"; }",
    // $? first, before anything else can overwrite it
    '__frost_prompt() {',
    '  local ec=$?',
    "  if [ -n \"$__frost_seen\" ]; then printf '\\033]133;D;%s\\007' \"$ec\"; fi",
    '  __frost_seen=1',
    "  printf '\\033]133;A\\007'",
    '  __frost_cwd',
    '}',
    'PROMPT_COMMAND="__frost_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"',
    ''
  );
  return lines.join('\n');
}

function bashRcFile(withClaude) {
  const f = path.join(STATUS_DIR, withClaude ? 'frost-bashrc-agent' : 'frost-bashrc');
  fs.writeFileSync(f, bashRc(withClaude));
  return f;
}

// ---------- git branch for tab titles ----------
// Read .git/HEAD straight off disk: this runs on every shell prompt, and
// spawning git there would block the main process on each keystroke-to-prompt.

const branchCache = new Map(); // cwd -> { branch, at }

function findGitDir(from) {
  let dir = path.resolve(from);
  for (;;) {
    const p = path.join(dir, '.git');
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) return p;
      if (st.isFile()) {
        // worktree or submodule: .git is a file pointing at the real gitdir
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(p, 'utf8'));
        if (m) return path.resolve(dir, m[1].trim());
      }
    } catch {}
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function branchFor(cwd) {
  if (!cwd) return null;
  const hit = branchCache.get(cwd);
  if (hit && Date.now() - hit.at < 1000) return hit.branch;
  let branch = null;
  const gitDir = findGitDir(cwd);
  if (gitDir) {
    try {
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
      const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      branch = m ? m[1] : head.slice(0, 7); // detached: short sha
    } catch {}
  }
  if (branchCache.size > 200) branchCache.clear();
  branchCache.set(cwd, { branch, at: Date.now() });
  return branch;
}

ipcMain.handle('git:branch', (_e, cwd) => branchFor(cwd));

// owner is the window the output belongs to. It can be null, for a shell that
// exists before any pane does — nothing does that today, and the buffering
// below is what a tab in flight between windows relies on.
function spawnShell({ cols, rows, cwd, run, profileId, owner }) {
  const id = String(++ptyCounter);
  if (owner) ptyOwners.set(id, owner);
  // No owner yet: whatever the shell prints in the meantime is held, by the
  // same buffer a tab in flight between windows uses, and replayed on claim.
  else detachedPtys.set(id, { chunks: [], bytes: 0 });
  const profile = findProfile(profileId);
  const autoDetect = (readTheme() || DEFAULT_THEME).autoDetectAgents !== false;
  // agentWrapper names the shell dialect: it decides both how the `claude`
  // wrapper is written and how the cwd hook is installed. 'none' = neither.
  const dialect = profile.agentWrapper || 'none';
  const withClaude = autoDetect && dialect !== 'none';
  let args = Array.isArray(profile.args) ? [...profile.args] : [];
  // ConPTY passes no TERM of its own, and node-pty's `name` is a no-op on
  // Windows, so a program launched here sees no hint that the terminal can do
  // more than sixteen colours and downgrades its palette: Claude Code's status
  // bar loses its gradients. Frost knows what it renders, so it says so. Set
  // before profile.env, which is the user's to override.
  let env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...(profile.env || {}) };
  if (dialect !== 'none') {
    if (withClaude) {
      const agentId = 'pty' + id;
      const hooks = hookSettingsFile(agentId);
      const launch = path.join(STATUS_DIR, 'ln-' + agentId);
      // bash eats backslashes in redirect targets — hand it msys-style paths
      const fix = dialect === 'bash' ? (s) => s.replace(/\\/g, '/') : (s) => s;
      env.FROST_HOOKS = fix(hooks);
      env.FROST_LAUNCH = fix(launch);
    }
    args =
      dialect === 'bash'
        ? ['--rcfile', bashRcFile(withClaude), '-i']
        : ['-NoLogo', '-NoExit', '-Command', psStartup(withClaude)];
  }
  const startCwd =
    (cwd && fs.existsSync(cwd) && cwd) ||
    (profile.cwd && fs.existsSync(profile.cwd) && profile.cwd) ||
    startDir();
  // A profile written before a Store update points into a package directory
  // that no longer exists. Rather than fail the tab with a file-not-found,
  // look the same executable up again and use wherever it lives now.
  let shell = profile.shell;
  if (shell && path.isAbsolute(shell) && !fs.existsSync(shell)) {
    const again = whichExe(path.basename(shell, '.exe'));
    if (again) shell = again;
  }
  const p = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: startCwd,
    env
  });
  ptys.set(id, p);
  ptyMeta.set(id, { profileId: profile.id, profileName: profile.name });
  p.onData((data) => {
    const rec = agentByPty.get(id);
    // A resize or a focus change makes ConPTY repaint, and that repaint is not
    // the agent doing work — counting it flipped an idle agent to "working"
    // every time you clicked between them.
    if (rec && Date.now() > (rec.muteUntil || 0)) {
      const now = Date.now();
      // A burst arriving after a quiet spell starts a new activity window. An
      // idle TUI redrawing its clock is one short burst; real work streams for
      // longer, which is how the two are told apart.
      if (now - (rec.lastData || 0) > 1500) rec.busySince = now;
      rec.lastData = now;
    }
    sendToOwner(id, 'pty:data', { id, data });
  });
  p.onExit(({ exitCode }) => {
    ptys.delete(id);
    sendToOwner(id, 'pty:exit', { id, exitCode });
    ptyOwners.delete(id);
    ptyMeta.delete(id);
  });
  if (run) {
    // let the shell finish its prompt, then type the command for the user
    setTimeout(() => {
      try {
        p.write(run + '\r');
      } catch {}
    }, 1500);
  }
  return { id, profileId: profile.id, profileName: profile.name };
}

ipcMain.handle('pty:create', (event, opts) => spawnShell({ ...opts, owner: event.sender }));

ipcMain.handle('profiles:list', () =>
  getProfiles().map(({ id, name, agentWrapper }) => ({ id, name, agentWrapper: agentWrapper || 'none' }))
);

ipcMain.on('pty:input', (_e, { id, data }) => {
  const p = ptys.get(id);
  if (p) p.write(data);
  const rec = agentByPty.get(id);
  if (rec) rec.lastInput = Date.now();
});

ipcMain.on('pty:resize', (_e, { id, cols, rows }) => {
  const p = ptys.get(id);
  if (!p || cols <= 0 || rows <= 0) return;
  const rec = agentByPty.get(id);
  // ignore the redraw this is about to provoke
  if (rec) rec.muteUntil = Date.now() + 900;
  p.resize(cols, rows);
});

// Focusing a pane makes the program redraw — TUIs that enable focus reporting
// get told about it — which is Frost's doing, not the agent's.
ipcMain.on('pty:mute', (_e, { id, ms }) => {
  const rec = agentByPty.get(id);
  if (rec) rec.muteUntil = Date.now() + Math.min(3000, Math.max(200, ms || 1200));
});

ipcMain.on('pty:kill', (_e, { id }) => {
  const p = ptys.get(id);
  ptyOwners.delete(id);
  ptyMeta.delete(id);
  detachedPtys.delete(id);
  if (p) {
    ptys.delete(id);
    p.kill();
  }
});

// ---------- moving a tab to another window ----------
// A tab is its shells, and a shell cannot be moved: it is a process this window
// owns, holding a working directory and whatever is running in it. So the shell
// stays exactly where it is and only its ownership moves — the old window gives
// it up, the new one claims it, and main re-points the output. What the new
// window cannot inherit is the scrollback, which lives in the old renderer's
// terminal; that is serialised by the renderer and written back into the new
// one, so the text on screen survives the move too.

// Claimed once by the renderer of the window opened to receive it.
const pendingAdoptions = new Map(); // frostId -> tab payload

// Called by the window giving the shell up, immediately before it disposes the
// terminal. Only its current owner may: otherwise any window could cut another
// window's pane loose.
ipcMain.on('pty:orphan', (event, { id }) => {
  if (ptyOwners.get(id) !== event.sender) return;
  ptyOwners.delete(id);
  detachedPtys.set(id, { chunks: [], bytes: 0 });
});

// The claim. A pty that still has an owner is never handed over — an ownerless
// one is either in flight or gone, and gone returns null so the caller can open
// a fresh shell instead of showing an inert pane.
ipcMain.handle('pty:adopt', (event, { id, cols, rows }) => {
  const p = ptys.get(id);
  const held = detachedPtys.get(id);
  if (!p || !held || ptyOwners.has(id)) return null;
  ptyOwners.set(id, event.sender);
  if (cols > 0 && rows > 0) {
    try {
      p.resize(cols, rows);
    } catch {}
  }
  // The replay waits for pty:flush, for the same reason it does when a warm
  // shell is claimed: this call has not returned yet, so the pane it belongs to
  // has not been wired up to receive anything.
  const meta = ptyMeta.get(id) || {};
  return { id, profileId: meta.profileId || null, profileName: meta.profileName || null };
});

// Asked for by the renderer once the pane is listening. Everything the shell
// said before anyone was there to hear it arrives now, in the order it was said,
// ahead of whatever it says next.
ipcMain.on('pty:flush', (event, { id }) => {
  const held = detachedPtys.get(id);
  if (!held || ptyOwners.get(id) !== event.sender) return;
  detachedPtys.delete(id);
  for (const data of held.chunks) event.sender.send('pty:data', { id, data });
  if (held.exit !== undefined) event.sender.send('pty:exit', { id, exitCode: held.exit });
});

ipcMain.on('tab:detach', (_e, payload) => {
  if (!payload) return;
  const w = createWindow();
  pendingAdoptions.set(w.frostId, payload);
});

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
    w.loadFile(path.join(__dirname, '..', 'renderer', 'dragghost.html'), {
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

ipcMain.handle('theme:get', (event) => ({
  theme: readTheme() || DEFAULT_THEME,
  css: readCss(),
  frameless: Boolean(windowOf(event)?.isFramelessMode),
  home: app.getPath('home'),
  openDir: dirFromArgv(process.argv)
}));

// ---------- agent mode ----------
// Agents run Claude Code in an isolated git worktree. Status comes from
// Claude Code hooks (injected via a per-agent --settings file, the user's
// own config is never touched) plus an output-activity heuristic.

const agents = new Map(); // agentId -> { ptyId, worktree, lastData, lastInput, hook, hookT, status }
const agentByPty = new Map(); // ptyId -> same record
let agentCounter = 0;
let STATUS_DIR = null;
let diffWatcher = null;
let diffTimer = null;

function readAgentsCfg() {
  try {
    return JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
  } catch {
    return { spaces: [] };
  }
}

// Shells disagree on how to spell a directory: PowerShell reports
// C:\dev\repo, the bash wrapper's `pwd -W` reports C:/dev/repo. Same place, and
// comparing them as strings meant one repo could appear twice — once live, once
// as a resumable session.
function canonPath(p) {
  if (!p) return p;
  return path.resolve(String(p).trim()).replace(/[\\/]+$/, '');
}

const samePath = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

function readSessions() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    // normalise on read so entries written before this still dedupe
    return raw.map((s) => ({ ...s, cwd: canonPath(s.cwd) }));
  } catch {
    return [];
  }
}

function upsertSession(entry) {
  const cwd = canonPath(entry.cwd);
  const sessions = readSessions().filter((s) => !samePath(s.cwd, cwd));
  sessions.unshift({ ...entry, cwd });
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions.slice(0, 30), null, 2));
}

function gitInfo(cwd) {
  const b = spawnSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  if (b.status !== 0) return { git: false, branch: null, baseCommit: null };
  const h = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return {
    git: true,
    branch: (b.stdout || '').trim() || 'HEAD',
    baseCommit: (h.stdout || '').trim() || 'HEAD'
  };
}

function registerDetected(agentId, rawCwd) {
  const cwd = canonPath(rawCwd);
  const ptyId = agentId.slice(3); // 'pty<N>' -> '<N>'
  const info = gitInfo(cwd);
  const rec = {
    ptyId,
    cwd,
    baseCommit: info.baseCommit,
    git: info.git,
    lastData: Date.now(),
    lastInput: 0,
    hook: null,
    hookT: 0,
    status: 'working',
    exited: false
  };
  agents.set(agentId, rec);
  agentByPty.set(ptyId, rec);
  const name = path.basename(cwd);
  if (info.git) {
    upsertSession({ name, cwd, branch: info.branch, lastSeen: Date.now() });
  }
  if (win) {
    broadcast('agent:detected', {
      agentId,
      ptyId,
      cwd,
      name,
      branch: info.branch || '(no git)',
      git: info.git,
      sessions: readSessions()
    });
  }
}

function effectiveStatus(rec) {
  if (rec.exited) return 'exited';
  // Claude Code's hooks report the turn's real state, so they win over the
  // output heuristic. Typing only invalidates "blocked" — answering the prompt
  // is what unblocks it — while "done" holds until the next prompt is sent.
  if (rec.hook === 'blocked') return rec.hookT > rec.lastInput ? 'blocked' : 'working';
  if (rec.hook === 'working') {
    // don't stay "working" forever if a session died without firing Stop
    return Date.now() - rec.lastData > 60000 ? 'idle' : 'working';
  }
  if (rec.hook === 'done') return 'done';
  // No hook yet: a shell that hasn't run claude, or a turn that hasn't started.
  // Output has to have been flowing for a moment, not just arrived once, so a
  // single repaint can't pass for work.
  const recent = Date.now() - rec.lastData < 2500;
  const sustained = rec.lastData - (rec.busySince || rec.lastData) > 400;
  return recent && sustained ? 'working' : 'idle';
}

function broadcastStatuses() {
  if (!liveWindows().length) return;
  const settings = notifySettings();
  for (const [id, rec] of agents) {
    const s = effectiveStatus(rec);
    if (s === rec.status) continue;
    rec.status = s;
    broadcast('agent:status', { agentId: id, status: s });
    const name = rec.cwd ? path.basename(rec.cwd) : 'agent';
    if (s === 'blocked' && settings.agentBlocked !== false) {
      notify({ title: `${name} needs you`, body: 'The agent is waiting on an answer.', agentId: id });
    } else if (s === 'done' && settings.agentDone !== false) {
      notify({ title: `${name} is done`, body: 'The agent finished its turn.', agentId: id });
    }
  }
}

function hookSettingsFile(agentId) {
  const statusFile = path.join(STATUS_DIR, 'st-' + agentId).replace(/\\/g, '/');
  const write = (s) => `node -e "require('fs').writeFileSync('${statusFile}','${s}')"`;
  const cfg = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: write('working') }] }],
      Notification: [{ hooks: [{ type: 'command', command: write('blocked') }] }],
      Stop: [{ hooks: [{ type: 'command', command: write('done') }] }]
    }
  };
  const file = path.join(STATUS_DIR, 'cfg-' + agentId + '.json');
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}

function initAgentInfra() {
  STATUS_DIR = path.join(app.getPath('userData'), 'agent-status');
  fs.mkdirSync(STATUS_DIR, { recursive: true });
  // drain stale status files from previous runs
  for (const f of fs.readdirSync(STATUS_DIR)) {
    try { fs.unlinkSync(path.join(STATUS_DIR, f)); } catch {}
  }
  chokidar
    .watch(STATUS_DIR, { ignoreInitial: true })
    .on('all', (_ev, file) => {
      const base = path.basename(file);
      if (base.startsWith('st-')) {
        const agentId = base.slice(3);
        const rec = agents.get(agentId);
        if (!rec) return;
        try {
          rec.hook = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
          rec.hookT = Date.now();
        } catch {}
        broadcastStatuses();
        return;
      }
      if (base.startsWith('ln-')) {
        const agentId = base.slice(3);
        let content = '';
        try {
          content = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
        } catch {
          return;
        }
        const sep = content.indexOf('|');
        if (sep < 0) return;
        const ev = content.slice(0, sep);
        const cwd = content.slice(sep + 1);
        if (ev === 'start') {
          registerDetected(agentId, cwd);
        } else if (ev === 'end') {
          const rec = agents.get(agentId);
          if (rec) {
            agents.delete(agentId);
            agentByPty.delete(rec.ptyId);
          }
          broadcast('agent:ended', { agentId, sessions: readSessions() });
        }
      }
    });
  setInterval(broadcastStatuses, 1500);
}

ipcMain.handle('fonts:list', () => {
  const names = new Set();
  for (const hive of ['HKLM', 'HKCU']) {
    const r = spawnSync(
      'reg',
      ['query', hive + '\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
    );
    for (const line of (r.stdout || '').split(/\r?\n/)) {
      const m = /^\s{4}(.+?)\s+REG_SZ\s+/.exec(line);
      if (!m) continue;
      let name = m[1].replace(/\s*\([^)]*\)\s*$/, '').trim();
      name = name
        .replace(
          /\s+(Bold|Italic|Oblique|Light|SemiBold|Semibold|Medium|Black|Thin|ExtraLight|ExtraBold|Regular|Condensed|SemiLight)(\s+(Italic|Oblique))?$/i,
          ''
        )
        .trim();
      if (name) names.add(name);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
});

ipcMain.handle('dialog:pickDir', async (event) => {
  const r = await dialog.showOpenDialog(windowOf(event) || win, { properties: ['openDirectory'] });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

ipcMain.handle('agents:getConfig', () => readAgentsCfg());

ipcMain.handle('agents:addSpace', async (event) => {
  const r = await dialog.showOpenDialog(windowOf(event) || win, {
    title: 'Add a repository as a space',
    properties: ['openDirectory']
  });
  if (r.canceled || !r.filePaths.length) return null;
  const p = r.filePaths[0];
  const check = spawnSync('git', ['-C', p, 'rev-parse', '--git-dir'], { encoding: 'utf8' });
  if (check.status !== 0) return { error: 'Not a git repository: ' + p };
  const cfg = readAgentsCfg();
  if (!cfg.spaces.some((s) => s.path === p)) {
    cfg.spaces.push({ name: path.basename(p), path: p });
    fs.writeFileSync(AGENTS_FILE, JSON.stringify(cfg, null, 2));
  }
  return cfg;
});

ipcMain.handle('agents:removeSpace', (_e, spacePath) => {
  const cfg = readAgentsCfg();
  cfg.spaces = (cfg.spaces || []).filter((s) => s.path !== spacePath);
  fs.writeFileSync(AGENTS_FILE, JSON.stringify(cfg, null, 2));
  return cfg;
});

ipcMain.handle('agents:spawn', (_e, { spacePath, task, useWorktree }) => {
  let cwd = spacePath;
  let branch;

  if (useWorktree) {
    const slug = (task || 'agent').toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
    const wtBase = path.join(spacePath, '.frost');
    try {
      fs.mkdirSync(wtBase, { recursive: true });
      // keep .frost/ out of git status without touching tracked files
      const exclude = path.join(spacePath, '.git', 'info', 'exclude');
      const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
      if (!cur.includes('.frost/')) fs.appendFileSync(exclude, '\n.frost/\n');
    } catch (e) {
      return { error: String(e) };
    }
    let name = slug;
    let n = 1;
    while (fs.existsSync(path.join(wtBase, name))) name = `${slug}-${++n}`;
    cwd = path.join(wtBase, name);
    branch = 'frost/' + name;
    const r = spawnSync('git', ['-C', spacePath, 'worktree', 'add', cwd, '-b', branch], {
      encoding: 'utf8'
    });
    if (r.status !== 0) return { error: (r.stderr || 'git worktree add failed').trim() };
  } else {
    const b = spawnSync('git', ['-C', spacePath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8'
    });
    branch = (b.stdout || '').trim() || 'HEAD';
  }

  // diff baseline: everything the agent does is measured against this commit,
  // so the diff view survives the agent committing its work
  const base = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const baseCommit = (base.stdout || '').trim() || 'HEAD';

  // with auto-detect on, the session wrapper handles hooks + registration;
  // otherwise pre-register the agent and pass the settings file explicitly
  const autoDetect = (readTheme() || DEFAULT_THEME).autoDetectAgents !== false;
  if (autoDetect) {
    return { agentId: null, cwd, branch, run: 'claude' };
  }
  const agentId = 'ag-' + ++agentCounter;
  const settingsFile = hookSettingsFile(agentId);
  agents.set(agentId, {
    ptyId: null,
    cwd,
    baseCommit,
    git: true,
    lastData: Date.now(),
    lastInput: 0,
    hook: null,
    hookT: 0,
    status: 'working',
    exited: false
  });
  return {
    agentId,
    cwd,
    branch,
    run: `claude --settings "${settingsFile}"`
  };
});

ipcMain.handle('agents:getSessions', () => readSessions());

ipcMain.handle('agents:removeSession', (_e, cwd) => {
  const target = canonPath(cwd);
  const sessions = readSessions().filter((s) => !samePath(s.cwd, target));
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  return sessions;
});

ipcMain.on('agents:track', (_e, { agentId, ptyId }) => {
  const rec = agents.get(agentId);
  if (!rec) return;
  rec.ptyId = ptyId;
  agentByPty.set(ptyId, rec);
});

// Build directories a running agent writes to constantly. Watching them costs
// real CPU on a large repo and tells us nothing: they're gitignored, so they
// can't appear in the diff we're recomputing.
const NOISY_DIRS = [
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '.cache',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.tox',
  '.gradle', '.idea', '.vs', 'coverage', '.terraform', 'Pods', 'DerivedData'
];
const NOISY_RE = new RegExp(
  `(^|[\\\\/])(${NOISY_DIRS.map((d) => d.replace(/\./g, '\\.')).join('|')})([\\\\/]|$)`,
  'i'
);
const isNoisyPath = (p) => NOISY_RE.test(p);

// One diff view at a time, keyed so the renderer can tell whose diff arrived.
// `key` identifies the subject — an agent, or a worktree being reviewed after
// its agent has gone.
function watchDiff({ key, cwd, base, mode }) {
  if (diffWatcher) {
    diffWatcher.close();
    diffWatcher = null;
  }
  clearTimeout(diffTimer);
  if (!key || !cwd) return;

  const runDiff = () => {
    // session = everything since the base commit (survives the agent
    // committing); uncommitted = working tree vs HEAD only
    const target = mode === 'uncommitted' ? 'HEAD' : base;
    const d = spawnSync('git', ['-C', cwd, 'diff', target], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    });
    const s = spawnSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8' });
    broadcast('agent:diff', { key, patch: d.stdout || '', status: s.stdout || '' });
  };
  runDiff();
  diffWatcher = chokidar
    .watch(cwd, {
      ignored: isNoisyPath,
      ignoreInitial: true,
      depth: 8
    })
    .on('all', () => {
      clearTimeout(diffTimer);
      diffTimer = setTimeout(runDiff, 400);
    });
}

ipcMain.on('agents:selectDiff', (_e, payload) => {
  const { agentId, mode } = payload || {};
  const rec = agentId && agents.get(agentId);
  if (!rec) {
    watchDiff({});
    return;
  }
  if (!rec.git) {
    broadcast('agent:diff', { key: 'agent:' + agentId, patch: '', status: '', nogit: true });
    return;
  }
  watchDiff({ key: 'agent:' + agentId, cwd: rec.cwd, base: rec.baseCommit, mode });
});

// ---------- worktrees ----------
// Agents can be isolated in a worktree under <repo>/.frost, which Frost also
// adds to .git/info/exclude — so those checkouts are invisible to git status and
// pile up unnoticed. This is the read-only half: see them, open them, review
// what they contain, and drop registrations whose directory is already gone.

function parseWorktrees(spacePath) {
  const r = spawnSync('git', ['-C', spacePath, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8'
  });
  if (r.status !== 0) return [];
  const out = [];
  let current = null;
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: path.normalize(line.slice(9).trim()), branch: null, head: null };
      out.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice(5).trim();
    } else if (line === 'detached') {
      current.branch = null;
    } else if (line.startsWith('prunable')) {
      current.prunable = true;
    } else if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true;
    }
  }
  return out;
}

function countCommits(cwd, range) {
  const r = spawnSync('git', ['-C', cwd, 'rev-list', '--count', range], { encoding: 'utf8' });
  return r.status === 0 ? Number((r.stdout || '0').trim()) || 0 : 0;
}

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

ipcMain.handle('worktrees:list', () => {
  const rows = [];
  for (const space of readAgentsCfg().spaces || []) {
    if (!fs.existsSync(space.path)) continue;
    const all = parseWorktrees(space.path);
    // the first entry is the repo's own checkout, which isn't a worktree to manage
    const [main, ...rest] = all;
    const base = main?.branch || 'HEAD';
    for (const wt of rest) {
      const exists = fs.existsSync(wt.path);
      const dirty = exists
        ? Boolean((spawnSync('git', ['-C', wt.path, 'status', '--porcelain'], { encoding: 'utf8' }).stdout || '').trim())
        : false;
      rows.push({
        ...wt,
        exists,
        dirty,
        base,
        space: space.name,
        spacePath: space.path,
        name: path.basename(wt.path),
        // .frost/ is where Frost puts them; anything else is the user's own
        mine: isFrostWorktree(space.path, wt.path),
        ahead: exists && wt.branch ? countCommits(wt.path, `${base}..HEAD`) : 0
      });
    }
  }
  return rows;
});

function isFrostWorktree(spacePath, wtPath) {
  const rel = path.relative(path.join(spacePath, '.frost'), wtPath);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Drops registrations for worktrees whose directory no longer exists. Nothing
// recoverable is touched: git only forgets bookkeeping for checkouts already gone.
ipcMain.handle('worktrees:prune', () => {
  const pruned = [];
  for (const space of readAgentsCfg().spaces || []) {
    if (!fs.existsSync(space.path)) continue;
    const before = parseWorktrees(space.path).filter((w) => !fs.existsSync(w.path)).length;
    if (!before) continue;
    const r = spawnSync('git', ['-C', space.path, 'worktree', 'prune'], { encoding: 'utf8' });
    if (r.status === 0) pruned.push({ space: space.name, count: before });
  }
  return pruned;
});

// Finds the repo a worktree belongs to, so operations run against the right
// checkout rather than whichever space happened to be listed first.
function ownerOf(wtPath) {
  for (const space of readAgentsCfg().spaces || []) {
    if (!fs.existsSync(space.path)) continue;
    const all = parseWorktrees(space.path);
    const hit = all.find((w) => samePath(canonPath(w.path), canonPath(wtPath)));
    if (hit) return { space, all, main: all[0], wt: hit };
  }
  return null;
}

const git = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const isDirty = (cwd) => Boolean((git(cwd, ['status', '--porcelain']).stdout || '').trim());

function confirm(event, { message, detail, action, danger }) {
  const w = windowOf(event) || win;
  const choice = dialog.showMessageBoxSync(w, {
    type: danger ? 'warning' : 'question',
    buttons: [action, 'Cancel'],
    defaultId: danger ? 1 : 0,
    cancelId: 1,
    noLink: true,
    message,
    detail
  });
  return choice === 0;
}

// Merge a worktree's branch into the repo's base branch. Everything that could
// leave the repo in a half-finished state is checked first and refused with an
// explanation, rather than attempted and abandoned partway.
ipcMain.handle('worktrees:merge', (event, wtPath) => {
  const found = ownerOf(wtPath);
  if (!found) return { error: 'That worktree no longer belongs to a known space.' };
  const { space, main, wt } = found;
  const base = main.branch;
  if (!wt.branch) return { error: 'This worktree has a detached HEAD, so there is no branch to merge.' };
  if (!base) return { error: 'The repository itself is on a detached HEAD; check out a branch first.' };
  if (isDirty(wt.path)) {
    return { error: `${path.basename(wt.path)} has uncommitted changes. Commit or discard them first.` };
  }
  const ahead = countCommits(wt.path, `${base}..${wt.branch}`);
  if (!ahead) return { error: `${wt.branch} has nothing that ${base} doesn't already have.` };
  if (isDirty(space.path)) {
    return { error: `${space.name} has uncommitted changes on ${base}. Commit or stash them first.` };
  }

  if (!confirm(event, {
    message: `Merge ${wt.branch} into ${base}?`,
    detail: `${ahead} commit${ahead > 1 ? 's' : ''} from ${path.basename(wt.path)} will be merged into ${base} in ${space.name}.`,
    action: 'Merge'
  })) return { cancelled: true };

  const r = git(space.path, ['merge', '--no-ff', wt.branch, '-m', `Merge ${wt.branch}`]);
  if (r.status !== 0) {
    // leave nothing half-applied behind
    git(space.path, ['merge', '--abort']);
    return { error: (r.stdout || r.stderr || 'merge failed').trim().split('\n').slice(0, 4).join(' ') };
  }
  return { merged: ahead, base, branch: wt.branch };
});

// Remove the checkout and delete the branch. Anything not merged is spelled out
// before it goes, and git's own refusal is honoured unless the user insists.
ipcMain.handle('worktrees:discard', (event, wtPath) => {
  const found = ownerOf(wtPath);
  if (!found) return { error: 'That worktree no longer belongs to a known space.' };
  const { space, main, wt } = found;
  const base = main.branch || 'HEAD';
  const exists = fs.existsSync(wt.path);
  const unmerged = exists && wt.branch ? countCommits(wt.path, `${base}..${wt.branch}`) : 0;
  const dirty = exists && isDirty(wt.path);

  const losses = [];
  if (unmerged) losses.push(`${unmerged} commit${unmerged > 1 ? 's' : ''} not in ${base}`);
  if (dirty) losses.push('uncommitted changes');

  if (!confirm(event, {
    message: `Discard ${path.basename(wt.path)}?`,
    detail: losses.length
      ? `This deletes the worktree and the branch ${wt.branch}.\n\nYou would lose ${losses.join(' and ')}. This cannot be undone.`
      : `This deletes the worktree and the branch ${wt.branch}. Its work is already in ${base}.`,
    action: 'Discard',
    danger: losses.length > 0
  })) return { cancelled: true };

  const force = losses.length > 0;
  let r = git(space.path, ['worktree', 'remove', ...(force ? ['--force'] : []), wt.path]);
  if (r.status !== 0 && exists) {
    return { error: (r.stderr || 'could not remove the worktree').trim() };
  }
  if (!exists) git(space.path, ['worktree', 'prune']);
  if (wt.branch) {
    const b = git(space.path, ['branch', force ? '-D' : '-d', wt.branch]);
    if (b.status !== 0) {
      return { removed: true, warning: `Worktree removed; branch ${wt.branch} kept: ${(b.stderr || '').trim()}` };
    }
  }
  return { removed: true, branch: wt.branch };
});

ipcMain.on('worktrees:selectDiff', (_e, payload) => {
  const { cwd, base, mode } = payload || {};
  if (!cwd || !fs.existsSync(cwd)) {
    watchDiff({});
    return;
  }
  // Compare against where this branch left the base, so the view is the
  // worktree's own work rather than everything that landed on base since.
  const merge = spawnSync('git', ['-C', cwd, 'merge-base', base || 'HEAD', 'HEAD'], {
    encoding: 'utf8'
  });
  const baseCommit = (merge.stdout || '').trim() || base || 'HEAD';
  watchDiff({ key: 'wt:' + cwd, cwd, base: baseCommit, mode });
});

ipcMain.on('diag:report', (_e, data) => {
  try {
    fs.writeFileSync(path.join(CONFIG_DIR, 'diag.json'), JSON.stringify(data, null, 2));
  } catch {}
});

ipcMain.handle('glass:info', (event) => ({
  wallpaper: getWallpaperDataUrl(),
  ...glassBounds(windowOf(event))
}));

// dir: 1 = in, -1 = out, 0 = back to the display's default
ipcMain.handle('zoom:step', (event, dir) => {
  const w = windowOf(event);
  return w ? stepZoom(w, dir) : 1;
});

ipcMain.on('win:minimize', (event) => windowOf(event)?.minimize());
ipcMain.on('win:maximize', (event) => {
  const w = windowOf(event);
  if (!w) return;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});
ipcMain.on('win:close', (event) => windowOf(event)?.close());
// The one accelerator worth keeping from the menu that was removed: it is not a
// key any shell wants, and having no way in to the developer tools would be a
// step back from what the default menu gave.
ipcMain.on('win:devtools', (event) => {
  const wc = windowOf(event)?.webContents;
  if (!wc) return;
  if (wc.isDevToolsOpened()) wc.closeDevTools();
  else wc.openDevTools({ mode: 'detach' }); // detached: docking it resizes the panes
});
ipcMain.on('win:new', () => createWindow());

ipcMain.handle('theme:save', (_e, theme) => {
  fs.writeFileSync(THEME_FILE, JSON.stringify(theme, null, 2));
  return true;
});

ipcMain.handle('keys:get', () => readKeys() || []);

// ---------- notifications ----------
// Only ever raised when the window doesn't have focus. Inside Frost the tab dot
// already tells you, and a toast for something you're looking at is noise.

function notifySettings() {
  const configured = (readTheme() || {}).notify;
  return { ...DEFAULT_THEME.notify, ...(configured || {}) };
}

function notify({ title, body, agentId }) {
  if (!liveWindows().length || anyWindowFocused() || !Notification.isSupported()) return;
  const toast = new Notification({
    title,
    body,
    icon: NOTIFY_ICON_FILE
  });
  toast.on('click', () => {
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

// ---------- opening things out of the terminal ----------
// Terminal output is untrusted: it's whatever a program, a repo, or a remote
// host printed. So nothing here is ever handed to a shell, and only schemes
// that can't launch a local handler are opened.

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

ipcMain.handle('shell:openExternal', async (_e, target) => {
  let url;
  try {
    url = new URL(String(target));
  } catch {
    return false;
  }
  // file:, and anything registered to an application (ms-msdt:, steam:, ...),
  // would turn a line of terminal output into a way to start a program
  if (!SAFE_SCHEMES.has(url.protocol)) return false;
  await shell.openExternal(url.href);
  return true;
});

// Editor command as an argv template; {file} {line} {column} are substituted as
// whole arguments, never spliced into a string that a shell would parse.
//
// `app` is the real executable to look for. What's on PATH is usually a shim —
// VS Code installs an extensionless `bin/code` next to `Code.exe` — and Node
// can't spawn a shim without going through a shell, which is exactly what we're
// avoiding. So each editor also says which .exe to find alongside it.
const EDITOR_CANDIDATES = [
  { exe: 'code', app: 'Code.exe', args: ['--goto', '{file}:{line}:{column}'] },
  { exe: 'code-insiders', app: 'Code - Insiders.exe', args: ['--goto', '{file}:{line}:{column}'] },
  { exe: 'cursor', app: 'Cursor.exe', args: ['--goto', '{file}:{line}:{column}'] },
  { exe: 'windsurf', app: 'Windsurf.exe', args: ['--goto', '{file}:{line}:{column}'] },
  { exe: 'subl', app: 'subl.exe', args: ['{file}:{line}:{column}'] },
  { exe: 'idea', app: 'idea64.exe', args: ['--line', '{line}', '{file}'] },
  { exe: 'nvim-qt', app: 'nvim-qt.exe', args: ['--', '+{line}', '{file}'] }
];

// Walks from whatever is on PATH to something spawnable.
function resolveExecutable(name, appExe) {
  if (/[\\/]/.test(name)) return fs.existsSync(name) ? name : null;
  const hit = whichExe(name);
  if (hit && /\.exe$/i.test(hit)) return hit;
  if (!hit) return null;
  const dir = path.dirname(hit);
  for (const rel of [path.join('..', appExe || name + '.exe'), appExe || name + '.exe']) {
    const candidate = path.resolve(dir, rel);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

let editorCache = null;

function resolveEditor() {
  const configured = readTheme()?.editor;
  if (typeof configured === 'string' && configured.trim()) {
    // split on whitespace, honouring "quoted paths with spaces"
    const parts = configured.match(/"[^"]+"|\S+/g) || [];
    if (parts.length) {
      const [name, ...args] = parts.map((p) => p.replace(/^"|"$/g, ''));
      // a template with no placeholder still needs the file appended
      if (!args.some((a) => a.includes('{file}'))) args.push('{file}');
      const exe = resolveExecutable(name);
      if (exe) return { exe, args };
      return false;
    }
  }
  if (editorCache !== null) return editorCache;
  editorCache = false;
  for (const candidate of EDITOR_CANDIDATES) {
    const exe = resolveExecutable(candidate.exe, candidate.app);
    if (exe) {
      editorCache = { exe, args: candidate.args };
      break;
    }
  }
  return editorCache;
}

// Turns a candidate found in terminal output into an absolute path, but only if
// it actually exists as a file. Existence is the filter that keeps ordinary
// words from being underlined as links.
function resolveTarget(cwd, candidate) {
  if (!candidate || candidate.length > 400) return null;
  // Legal in a Windows filename but shell metacharacters, so a file could be
  // named to inject if anything downstream ever reaches a command line.
  if (/[\0<>|"*?&^%`$]/.test(candidate)) return null;
  let target = candidate;
  if (target.startsWith('~/') || target.startsWith('~\\')) {
    target = path.join(app.getPath('home'), target.slice(2));
  } else if (/^\/[a-zA-Z]\//.test(target)) {
    // msys/Git Bash style: /c/dev/x -> C:\dev\x
    target = target[1] + ':' + target.slice(2);
  }
  const base = cwd && fs.existsSync(cwd) ? cwd : startDir();
  const abs = path.resolve(base, target);
  try {
    return fs.statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

// ---------- images dropped or pasted into a pane ----------

// A terminal carries text, so an image has to become a path before it can be
// handed to anything — and a path is what an agent in the pane wants anyway.
// A file dragged out of Explorer already has one; an image dragged out of a
// browser or pasted as a bitmap does not, so it is written here first and the
// path to that copy is what gets typed.
const IMAGE_DIR = path.join(app.getPath('temp'), 'frost-images');
const IMAGE_TTL = 24 * 60 * 60 * 1000;
const IMAGE_MAX = 32 * 1024 * 1024;
const IMAGE_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg'
};

function saveImage(buf, ext) {
  if (!buf || !buf.length || buf.length > IMAGE_MAX) return null;
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  // Nothing else ever deletes these and they are whole screenshots, so the
  // folder is swept on the way in rather than left to grow for the life of the
  // machine. A day is long enough that a path already typed into a prompt and
  // not yet sent still opens.
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(IMAGE_DIR)) {
      const stale = path.join(IMAGE_DIR, name);
      try {
        if (now - fs.statSync(stale).mtimeMs > IMAGE_TTL) fs.unlinkSync(stale);
      } catch {}
    }
  } catch {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const abs = path.join(IMAGE_DIR, `image-${stamp}${ext}`);
  fs.writeFileSync(abs, buf);
  return abs;
}

// An image dragged out of a browser arrives as a URL rather than a file. The
// renderer cannot fetch it — its CSP is default-src 'self', deliberately — so
// the download happens here, and only for what a drop could plausibly have
// produced: an image content type, at a size worth putting on a prompt line.
ipcMain.handle('image:fromUrl', async (_e, url) => {
  if (typeof url !== 'string' || url.length > 8192) return null;
  try {
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',');
      if (comma < 0) return null;
      const head = url.slice(0, comma);
      const mime = head.slice(5).split(';')[0].toLowerCase();
      if (!IMAGE_EXT[mime]) return null;
      const body = url.slice(comma + 1);
      const buf = /;base64/i.test(head)
        ? Buffer.from(body, 'base64')
        : Buffer.from(decodeURIComponent(body), 'utf8');
      return saveImage(buf, IMAGE_EXT[mime]);
    }
    if (!/^https?:\/\//i.test(url)) return null;
    const res = await net.fetch(url);
    if (!res.ok) return null;
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_EXT[mime]) return null;
    return saveImage(Buffer.from(await res.arrayBuffer()), IMAGE_EXT[mime]);
  } catch {
    return null;
  }
});

// Ctrl+V with a screenshot on the clipboard. Chromium's async clipboard API
// would need a permission prompt and misses formats Windows apps actually
// write; Electron's clipboard reads the same DIB the Snipping Tool puts there.
ipcMain.handle('image:fromClipboard', () => {
  try {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    return saveImage(img.toPNG(), '.png');
  } catch {
    return null;
  }
});

ipcMain.handle('paths:resolve', (_e, { cwd, candidates }) => {
  const out = {};
  for (const candidate of Array.isArray(candidates) ? candidates.slice(0, 64) : []) {
    const abs = resolveTarget(cwd, candidate);
    if (abs) out[candidate] = abs;
  }
  return out;
});

ipcMain.handle('paths:open', (_e, { cwd, target, line, column }) => {
  const abs = resolveTarget(cwd, target);
  if (!abs) return { error: 'not found: ' + target };
  const editor = resolveEditor();
  if (!editor) {
    // no editor on PATH: let Windows decide what opens it
    shell.openPath(abs);
    return { opened: 'shell' };
  }
  const args = editor.args.map((a) =>
    a
      .replace('{file}', abs)
      .replace('{line}', String(Math.max(1, line || 1)))
      .replace('{column}', String(Math.max(1, column || 1)))
  );
  try {
    // no shell, argv only — a path from terminal output must never be parsed
    // as a command line
    const child = spawn(editor.exe, args, { detached: true, stdio: 'ignore', shell: false });
    // spawn reports failure asynchronously, and an unhandled 'error' here takes
    // the whole main process down
    child.on('error', () => shell.openPath(abs));
    child.unref();
    return { opened: path.basename(editor.exe) };
  } catch (e) {
    shell.openPath(abs);
    return { opened: 'shell', error: String(e) };
  }
});

ipcMain.handle('session:get', (event) => {
  const w = windowOf(event);
  const mine = w && pendingLayouts.get(w.frostId);
  if (w) pendingLayouts.delete(w.frostId); // restored once, not on every reload
  return { tabs: mine?.tabs || [], activeTab: mine?.activeTab || 0 };
});

ipcMain.on('session:layout', (event, layout) => {
  const w = windowOf(event);
  if (!w) return;
  if (layout && Array.isArray(layout.tabs)) sessionLayouts.set(w.frostId, layout);
  else sessionLayouts.delete(w.frostId);
  saveWindowStateSoon();
});

ipcMain.on('theme:openFile', (_e, which) => {
  shell.openPath(which === 'css' ? CSS_FILE : which === 'keys' ? KEYS_FILE : THEME_FILE);
});

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
  autoUpdater.on('update-downloaded', (info) => {
    readyVersion = info?.version || null;
    setUpdateState({ stage: 'ready', latest: readyVersion, percent: 100, message: '' });
  });
  autoUpdater.on('error', (err) => {
    // Offline is the common case, and it reads as a stack trace otherwise
    const raw = String(err?.message || err || 'unknown error');
    const offline = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|net::/i.test(raw);
    // A release cut before this feature existed carries the exes but no
    // latest.yml, and the 404 that produces says nothing a reader can act on
    const noInfo = /404|latest\.yml/i.test(raw);
    setUpdateState({
      stage: 'error',
      percent: 0,
      message: offline
        ? 'No connection to GitHub.'
        : noInfo
          ? 'The newest release carries no update info — see the releases page.'
          : raw.split('\n')[0]
    });
  });
  updater = autoUpdater;
  return updater;
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
  flushWindowState();
  quitting = true;
  // isSilent: the installer runs without asking anything, since the user just
  // answered the only question it would have. isForceRunAfter brings Frost back,
  // which is the whole point of restarting rather than waiting for the next quit.
  try {
    getUpdater().quitAndInstall(true, true);
  } catch (e) {
    setUpdateState({ stage: 'error', message: String(e?.message || e) });
  }
});

// --- app lifecycle ---

// A shell context-menu click on a second folder should land in the window
// already open, not start a rival process that fights over window.json.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const target = focusedWindow();
    if (!target) return;
    if (target.isMinimized()) target.restore();
    target.focus();
    const dir = dirFromArgv(argv);
    if (dir) target.webContents.send('session:openDir', dir);
  });
}

app.whenReady().then(() => {
  // A run from source is launched by electron.exe, so Windows identifies the
  // taskbar button as Electron's and paints Electron's logo whatever icon the
  // window carries. An id of its own breaks that association and sends Windows
  // back to the window icon, which is Frost's. Dev only — a packaged build is
  // identified by its own executable and must stay that way, for the reason
  // below.
  if (!app.isPackaged) app.setAppUserModelId('dev.azekyoo.frost.source');

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
  const saved = restoring && !dirFromArgv(process.argv) ? readWindowState() : [];
  createWindow({ isPrimary: true, restore: saved[0] || null });
  for (const entry of saved.slice(1, 8)) createWindow({ restore: entry });

  watchConfig();
  initUpdates();
});

app.on('before-quit', () => {
  clearInterval(updateTimer);
  if (ghostWin && !ghostWin.isDestroyed()) ghostWin.destroy();
  flushWindowState();
  quitting = true; // after the flush: closing windows must not rewrite it
});

app.on('window-all-closed', () => {
  for (const p of ptys.values()) {
    try { p.kill(); } catch {}
  }
  ptys.clear();
  app.quit();
});
