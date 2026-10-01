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
const { spawn, spawnSync, execFile } = require('child_process');
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
  // finally, because Ctrl+C stops the function too, and a plain next line
  // would never run
  'try { & $exe --settings $env:FROST_HOOKS @args } ' +
  'finally { Set-Content -LiteralPath $env:FROST_LAUNCH -Value ("end|" + (Get-Location).Path) -Encoding UTF8 } ' +
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

// A pane opened to run a command — New session, a resume — types it once its
// shell is up, and that takes a moment. Whatever was typed in that moment used
// to land on the same line and break the command, so claude never started.
// It is held instead, and handed over once claude is drawing its own prompt:
// the question typed early still reaches it.
const typeAhead = new Map(); // ptyId -> { run, stage: 'shell' | 'claude', held: [], timer }
// A shell without Frost's prompt hook gives no sign it is ready: the old guess.
const RUN_UNMARKED_MS = 1500;
// One with the hook whose first prompt never shows: type the command anyway.
const RUN_MARKED_CAP_MS = 10000;
// claude that never draws (not installed, a typo in a profile): give the keys
// back to the shell rather than swallow them.
const HOLD_CAP_MS = 15000;

function holdForRun(id, run, marked) {
  const ta = { run, stage: 'shell', held: [], timer: null };
  typeAhead.set(id, ta);
  ta.timer = setTimeout(() => typeRun(id), marked ? RUN_MARKED_CAP_MS : RUN_UNMARKED_MS);
}

function typeRun(id) {
  const ta = typeAhead.get(id);
  if (!ta || ta.stage !== 'shell') return;
  clearTimeout(ta.timer);
  ta.stage = 'claude';
  try {
    ptys.get(id)?.write(ta.run + '\r');
  } catch {}
  ta.timer = setTimeout(() => releaseTypeAhead(id), HOLD_CAP_MS);
}

function releaseTypeAhead(id) {
  const ta = typeAhead.get(id);
  if (!ta) return;
  clearTimeout(ta.timer);
  typeAhead.delete(id);
  if (!ta.held.length) return;
  try {
    ptys.get(id)?.write(ta.held.join(''));
  } catch {}
}

// The shell's first prompt is the moment to type; claude switching on focus
// reporting — no shell does — is the moment its prompt takes keys.
function watchTypeAhead(id, data) {
  const ta = typeAhead.get(id);
  if (!ta) return;
  if (ta.stage === 'shell' && data.includes('\x1b]133;A')) typeRun(id);
  else if (ta.stage === 'claude' && data.includes('\x1b[?1004h')) releaseTypeAhead(id);
}

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
    // The shell only prompts again once claude has exited. That catches the
    // exits the wrapper never reports: on Windows a double Ctrl+C reaches the
    // shell too, which abandons the wrapper before its "end" line runs.
    // Only for launches the wrapper announced: those register once claude is
    // already running, after the prompt it was typed at. One pre-registered
    // with auto-detect off exists before its shell's first prompt.
    if (rec?.announced && data.includes('\x1b]133;A')) {
      const agentId = [...agents].find(([, r]) => r === rec)?.[0];
      if (agentId) agentEnded(agentId);
    }
    watchTypeAhead(id, data);
    sendToOwner(id, 'pty:data', { id, data });
  });
  p.onExit(({ exitCode }) => {
    clearTimeout(typeAhead.get(id)?.timer);
    typeAhead.delete(id);
    ptys.delete(id);
    sendToOwner(id, 'pty:exit', { id, exitCode });
    ptyOwners.delete(id);
    ptyMeta.delete(id);
  });
  // both dialects draw the 133;A prompt marker, with or without the wrapper
  if (run) holdForRun(id, run, dialect !== 'none');
  return { id, profileId: profile.id, profileName: profile.name };
}

ipcMain.handle('pty:create', (event, opts) => spawnShell({ ...opts, owner: event.sender }));

ipcMain.handle('profiles:list', () =>
  getProfiles().map(({ id, name, agentWrapper }) => ({ id, name, agentWrapper: agentWrapper || 'none' }))
);

ipcMain.on('pty:input', (_e, { id, data }) => {
  const ta = typeAhead.get(id);
  if (ta) {
    ta.held.push(data);
    return;
  }
  const p = ptys.get(id);
  if (p) p.write(data);
  const rec = agentByPty.get(id);
  // Claude Code turns on focus reporting, so clicking into its pane sends
  // ESC[I / ESC[O. That is not an answer to anything, and counting it as one
  // flipped a blocked agent to working just for being looked at.
  if (rec && data.replace(/\x1b\[[IO]/g, '')) rec.lastInput = Date.now();
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
  clearTimeout(typeAhead.get(id)?.timer);
  typeAhead.delete(id);
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
// An agent is a Claude Code session running in one of Frost's panes. Status
// comes from Claude Code hooks (injected via a per-agent --settings file, the
// user's own config is never touched) plus an output-activity heuristic.

const agents = new Map(); // agentId -> { ptyId, cwd, sessionId, title, lastData, lastInput, hook, hookT, status }
const agentByPty = new Map(); // ptyId -> same record
let agentCounter = 0;
let STATUS_DIR = null;
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

// What the tracked files looked like when the session started, uncommitted
// edits included, as a tree object. Diffing against HEAD instead would count
// work that was already lying around as the session's own. Untracked files stay
// out of the tree — git diff can't see them, so they would read as deleted —
// and are remembered by name instead, to be left out of the list. The
// tree is built in a throwaway index, so the real index and files are never
// touched; it hangs off no ref, and git's gc collects it in time.
// git spells a path with non-ASCII in it — 音.txt — as octal escapes in
// quotes unless told not to. Names with spaces or quotes stay quoted either
// way; unquotePath reads those. The same setting has to be used everywhere
// status lines are compared, or the snapshot and the diff disagree.
const UTF8_PATHS = ['-c', 'core.quotePath=false'];

function unquotePath(p) {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const esc = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  const body = Buffer.from(p.slice(1, -1), 'utf8');
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== 92) {
      bytes.push(body[i]);
      continue;
    }
    const c = String.fromCharCode(body[i + 1]);
    if (/[0-7]/.test(c)) {
      bytes.push(parseInt(body.toString('latin1', i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(esc[c] ?? body[i + 1]);
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function snapshotBase(cwd, head) {
  const untracked = new Set();
  const st = spawnSync('git', ['-C', cwd, ...UTF8_PATHS, 'status', '--porcelain'], { encoding: 'utf8' });
  for (const line of (st.stdout || '').split(/\r?\n/)) {
    if (line.startsWith('??')) untracked.add(line);
  }
  if (st.status !== 0 || !st.stdout.trim()) return { base: head, untracked };
  const tmp = path.join(STATUS_DIR, `idx-${process.pid}-${Date.now()}`);
  try {
    const real = spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'index'], {
      encoding: 'utf8'
    });
    // starting from a copy of the real index keeps its stat cache: only
    // changed files get re-hashed
    try {
      fs.copyFileSync((real.stdout || '').trim(), tmp);
    } catch {
      // without the real index to start from, the snapshot would be empty and
      // every file would read as added; HEAD is the honest fallback
      return { base: head, untracked };
    }
    const env = { ...process.env, GIT_INDEX_FILE: tmp };
    const add = spawnSync('git', ['-C', cwd, 'add', '-u'], { encoding: 'utf8', env });
    if (add.status !== 0) return { base: head, untracked };
    const tree = spawnSync('git', ['-C', cwd, 'write-tree'], { encoding: 'utf8', env });
    const hash = (tree.stdout || '').trim();
    return tree.status === 0 && hash ? { base: hash, untracked } : { base: head, untracked };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// snapshotBase without holding up the process: taken for a repo an agent
// reaches into mid-session, while every terminal's output passes through here.
function gitRun(cwd, args, env) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      resolve({ ok: !err, stdout: stdout || '' })
    );
  });
}

async function snapshotBaseAsync(cwd, head) {
  const untracked = new Set();
  const st = await gitRun(cwd, [...UTF8_PATHS, 'status', '--porcelain']);
  for (const line of st.stdout.split(/\r?\n/)) {
    if (line.startsWith('??')) untracked.add(line);
  }
  if (!st.ok || !st.stdout.trim()) return { base: head, untracked };
  const tmp = path.join(STATUS_DIR, `idx-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  try {
    const real = await gitRun(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    try {
      await fs.promises.copyFile(real.stdout.trim(), tmp);
    } catch {
      return { base: head, untracked };
    }
    const env = { ...process.env, GIT_INDEX_FILE: tmp };
    if (!(await gitRun(cwd, ['add', '-u'], env)).ok) return { base: head, untracked };
    const tree = await gitRun(cwd, ['write-tree'], env);
    const hash = tree.stdout.trim();
    return tree.ok && hash ? { base: hash, untracked } : { base: head, untracked };
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
}

function registerDetected(agentId, rawCwd) {
  const cwd = canonPath(rawCwd);
  const ptyId = agentId.slice(3); // 'pty<N>' -> '<N>'
  const info = gitInfo(cwd);
  const snap = info.git ? snapshotBase(cwd, info.baseCommit) : { base: null, untracked: new Set() };
  const rec = {
    ptyId,
    cwd,
    baseCommit: snap.base,
    untrackedAtStart: snap.untracked,
    startedAt: Date.now(),
    snapAt: Date.now(),
    git: info.git,
    lastData: Date.now(),
    lastInput: 0,
    hook: null,
    hookT: 0,
    status: 'working',
    exited: false,
    // the SessionStart hook can land before the launch file does
    sessionId: readSessionId(agentId),
    announced: true
  };
  agents.set(agentId, rec);
  agentByPty.set(ptyId, rec);
  const name = path.basename(cwd);
  if (win) {
    broadcast('agent:detected', {
      agentId,
      ptyId,
      cwd,
      name,
      branch: info.branch || '(no git)',
      git: info.git,
      sessionId: rec.sessionId
    });
  }
}

// claude is gone from this pane, however it went: the wrapper said so, or the
// shell drew a prompt again underneath it.
function agentEnded(agentId) {
  const rec = agents.get(agentId);
  if (rec) {
    agents.delete(agentId);
    agentByPty.delete(rec.ptyId);
  }
  try { fs.unlinkSync(path.join(STATUS_DIR, 'sid-' + agentId)); } catch {}
  broadcast('agent:ended', { agentId });
}

function effectiveStatus(rec) {
  if (rec.exited) return 'exited';
  // Claude Code's hooks report the turn's real state, so they win over the
  // output heuristic. Typing only invalidates "blocked" — answering the prompt
  // is what unblocks it — while "done" holds until the next prompt is sent.
  if (rec.hook === 'blocked' && rec.hookT > rec.lastInput) return 'blocked';
  // answered: working again, with the same staleness rule, since typing into
  // it without a turn following would otherwise leave it "working" for good
  if (rec.hook === 'working' || rec.hook === 'blocked') {
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
    const name = rec.title || (rec.cwd ? path.basename(rec.cwd) : 'agent');
    if (s === 'blocked' && settings.agentBlocked !== false) {
      notify({ title: `${name} needs you`, body: 'The agent is waiting on an answer.', agentId: id });
    } else if (s === 'done' && settings.agentDone !== false) {
      notify({ title: `${name} is done`, body: 'The agent finished its turn.', agentId: id });
    }
  }
}

// The hook's stdin is a JSON object carrying session_id. No double quotes, $
// or backticks inside the script: the shell running it sees it inside "...".
function sessionIdHook(agentId) {
  const file = path.join(STATUS_DIR, 'sid-' + agentId).replace(/\\/g, '/');
  return (
    `node -e "let d='';process.stdin.on('data',(c)=>d+=c).on('end',()=>{` +
    `try{require('fs').writeFileSync('${file}',JSON.parse(d).session_id)}catch(e){}})"`
  );
}

// Notification fires for questions and permission prompts, which really do
// need you, but also a minute into any idle wait ("Claude is waiting for your
// input"). That one is not blocked — the turn is over — so it leaves the status
// alone rather than flipping a done agent to blocked.
function blockedHook(statusFile) {
  return (
    `node -e "let d='';process.stdin.on('data',(c)=>d+=c).on('end',()=>{let j={};try{j=JSON.parse(d)}catch(e){}` +
    `if(j.notification_type==='idle_prompt'||/waiting for your input/i.test(j.message||''))return;` +
    `require('fs').writeFileSync('${statusFile}','blocked')})"`
  );
}

// The folders a shell command reaches into: where it cd's or points git -C,
// and any absolute path it names. A guess — a command can build a path at run
// time — but agents spell theirs out. MSYS paths (/c/dev) become C:\dev. Also
// runs inside the hook script, pasted there as source, so it requires its own
// modules.
function bashPaths(cmd, cwd) {
  const path = require('path');
  const out = [];
  const add = (p) => {
    p = p.replace(/^["']|["']$/g, '');
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
    if (m) p = m[1].toUpperCase() + ':' + (m[2] || '/');
    if (/^~([\\/]|$)/.test(p)) p = require('os').homedir() + p.slice(1);
    out.push(path.resolve(cwd, p));
  };
  const arg = `("[^"]+"|'[^']+'|[^\\s;&|)]+)`;
  for (const m of cmd.matchAll(new RegExp(`(?:^|[\\s;&|(])(?:cd|pushd)\\s+${arg}`, 'g'))) add(m[1]);
  for (const m of cmd.matchAll(new RegExp(`\\bgit\\s+-C\\s+${arg}`, 'g'))) add(m[1]);
  for (const m of cmd.matchAll(/"([A-Za-z]:[\\/][^"]*)"/g)) add(m[1]);
  for (const m of cmd.matchAll(/(?:^|[\s'=(])((?:[A-Za-z]:[\\/]|\/[a-zA-Z]\/)[^\s"'`;|&<>()]*)/g)) add(m[1]);
  return out;
}

// Runs before every file edit and shell command, so the common case — nothing
// outside the agent's own folder — returns without a word. Anything else is
// appended to tp-<agent>, and the hook waits (capped) for main to write the
// matching acks, which it does once each path's repo has a base snapshot. A
// file, not the inline node -e the other hooks use: the wait loop has no
// business inside shell quoting.
const TOUCH_HOOK_SRC = `
const fs = require('fs');
const path = require('path');
${bashPaths.toString()}
const [dir, agentId] = process.argv.slice(2);
let d = '';
process.stdin.on('data', (c) => (d += c)).on('end', () => {
  let j = {};
  try { j = JSON.parse(d); } catch {}
  const input = j.tool_input || {};
  if (!j.cwd) return;
  const bash = j.tool_name === 'Bash';
  const targets = bash
    ? bashPaths(String(input.command || ''), j.cwd)
    : [input.file_path || input.notebook_path].filter(Boolean).map((t) => path.resolve(j.cwd, t));
  const outside = [...new Set(targets)].filter((p) => {
    const rel = path.relative(j.cwd, p);
    return rel.startsWith('..') || path.isAbsolute(rel);
  });
  if (!outside.length) return;
  const acks = [];
  let lines = '';
  for (const p of outside) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    acks.push(path.join(dir, 'ta-' + agentId + '-' + id));
    lines += id + '|' + p + (bash ? '|bash' : '') + '\\n';
  }
  try { fs.appendFileSync(path.join(dir, 'tp-' + agentId), lines); } catch { return; }
  const nap = new Int32Array(new SharedArrayBuffer(4));
  const until = Date.now() + 10000;
  let left = acks;
  while (left.length && Date.now() < until) {
    left = left.filter((a) => {
      if (!fs.existsSync(a)) return true;
      try { fs.unlinkSync(a); } catch {}
      return false;
    });
    if (left.length) Atomics.wait(nap, 0, 0, 25);
  }
});
`;

function touchHook(agentId) {
  const script = path.join(STATUS_DIR, 'frost-touch-hook.js');
  if (!fs.existsSync(script)) fs.writeFileSync(script, TOUCH_HOOK_SRC);
  const fwd = (s) => s.replace(/\\/g, '/');
  return `node "${fwd(script)}" "${fwd(STATUS_DIR)}" ${agentId}`;
}

// The folder a path is in, or is: it may not exist yet — a Write creating a
// file in a new folder — so the nearest one that does.
function nearestDir(p) {
  let dir = p;
  while (!fs.existsSync(dir)) {
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  try {
    return fs.statSync(dir).isFile() ? path.dirname(dir) : dir;
  } catch {
    return null;
  }
}

// The repo a path lives in, file or folder.
function repoRootOf(p) {
  const dir = nearestDir(p);
  if (!dir) return null;
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 && r.stdout.trim() ? canonPath(r.stdout.trim()) : null;
}

const within = (dir, p) => {
  const rel = path.relative(dir, p);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};

// Where HEAD pointed at a moment in the past: the newest reflog entry from
// before it, else the last commit made before it.
function commitAt(root, ms) {
  const opts = { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 };
  const log = spawnSync('git', ['-C', root, 'reflog', 'show', '-n', '5000', '--date=unix', '--format=%H %gd', 'HEAD'], opts);
  for (const line of (log.stdout || '').split(/\r?\n/)) {
    const m = /^([0-9a-f]{40,64}) HEAD@\{(\d+)\}$/.exec(line.trim());
    if (m && +m[2] * 1000 <= ms) return m[1]; // newest first
  }
  const before = spawnSync('git', ['-C', root, 'rev-list', '-1', `--before=${Math.floor(ms / 1000)}`, 'HEAD'], opts);
  return (before.stdout || '').trim() || null;
}

// A repo other than the agent's own, first seen being edited, joins the
// agent's diff. Reported by the hook, it is snapshotted now, before the edit
// the hook is holding back. Found in the transcript (`since`), the edit has
// long happened: the base is where HEAD was when the session began, and only
// the files the session touched are shown, since whatever else was
// uncommitted there then can't be told apart from its work.
// A repo only a shell command pointed at (`bash`) may just have been read —
// an ls, a grep — so it stays out of sight (`quiet`) until its diff has
// something in it; a shell command names no files either, so all of the repo
// is shown.
// True when the diff has something new to show.
function addExtraRepo(rec, p, { since = null, bash = false } = {}) {
  rec.extraRepos ||= new Map(); // root (lowercased) -> { cwd, name, branch, base, untrackedAtStart, touched?, quiet? }
  for (const x of rec.extraRepos.values()) {
    if (!within(x.cwd, p)) continue;
    if (bash) return false;
    let news = false;
    if (x.quiet) {
      x.quiet = false; // edited by name: its work, whatever the diff says yet
      news = true;
    }
    if (!x.touched) return news;
    const rel = path.relative(x.cwd, p).replace(/\\/g, '/');
    if (x.touched.has(rel)) return news;
    x.touched.add(rel);
    return true;
  }
  if (rec.root === undefined) rec.root = rec.git ? repoRootOf(rec.cwd) : null;
  if (rec.root && within(rec.root, p)) return false;
  // a folder's repo is asked once: the same files come up again and again
  rec.rootOf ||= new Map();
  const dir = nearestDir(p);
  if (!dir) return false;
  if (!rec.rootOf.has(dir.toLowerCase())) rec.rootOf.set(dir.toLowerCase(), repoRootOf(dir));
  const root = rec.rootOf.get(dir.toLowerCase());
  if (!root) return false; // outside any repo: nothing git could diff
  const info = gitInfo(root);
  if (!info.git) return false;
  const entry = { cwd: root, name: path.basename(root), branch: info.branch, quiet: bash, startedAt: since || Date.now() };
  if (since) {
    entry.base = commitAt(root, since) || info.baseCommit;
    entry.untrackedAtStart = null;
    if (!bash) entry.touched = new Set([path.relative(root, p).replace(/\\/g, '/')]);
  } else {
    // out of the diff until the snapshot lands; the hook waits on `ready`
    entry.base = info.baseCommit;
    entry.untrackedAtStart = null;
    entry.ready = snapshotBaseAsync(root, info.baseCommit).then((snap) => {
      entry.base = snap.base;
      entry.untrackedAtStart = snap.untracked;
      entry.ready = null;
    });
  }
  rec.extraRepos.set(root.toLowerCase(), entry);
  return true;
}

function extraRepoFor(rec, p) {
  for (const x of rec.extraRepos?.values() || []) if (within(x.cwd, p)) return x;
  return null;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// A transcript line from before this pane started, in a session whose own
// repo is to be diffed from its real start (a resume).
function earlyEdit(rec, j) {
  return Boolean(rec.earlyBase && rec.root) && (Date.parse(j?.timestamp) || 0) < rec.snapAt;
}

// rec[key]: a set of paths in the agent's own repo, from its top.
// touchedMain is every file the session's transcript names, which is what
// its Session diff keeps to while another agent works in the same repo;
// earlyTouched the ones from before a resume.
function addRel(rec, key, abs) {
  rec[key] ||= new Set();
  const rel = path.relative(rec.root, abs).replace(/\\/g, '/');
  if (rec[key].has(rel)) return false;
  rec[key].add(rel);
  return true;
}

// Files in the repo a shell command names — a script that rewrites
// src/app.js names it as a plain word, and no tool call says so. Reads are
// caught too, which costs nothing: a file read and left alone has no diff.
function namedFiles(cmd, cwd, root) {
  const out = new Set();
  for (const m of cmd.matchAll(/[\w.~:\\/-]*[\w-]\.[A-Za-z0-9]{1,8}\b/g)) {
    const word = m[0].replace(/^\/([a-zA-Z])\//, '$1:/');
    const abs = canonPath(path.resolve(cwd, word));
    if (!within(root, abs) || out.has(abs)) continue;
    try {
      if (fs.statSync(abs).isFile()) out.add(abs);
    } catch {}
  }
  return out;
}

// Edits the hook never saw — made before this pane's claude started, as in a
// resumed session — are still in the transcript. Read from where the last
// read stopped, a chunk at a time and off the main thread's back, and only
// for the agent whose diff is on screen; a line is parsed only if it could
// be a file edit.
async function scanTranscriptEdits(agentId) {
  const rec = agents.get(agentId);
  if (!rec?.sessionId || rec.scanning) return;
  let s = rec.editScan;
  if (!s || s.sessionId !== rec.sessionId) {
    let file = transcriptPaths.get(rec.sessionId);
    if (!file && Date.now() - (rec.scanMissT || 0) > 10000) {
      rec.scanMissT = Date.now(); // a session that hasn't written one yet
      scanTranscripts();
      file = transcriptPaths.get(rec.sessionId);
    }
    if (!file) return;
    s = rec.editScan = { sessionId: rec.sessionId, file, offset: 0, since: null };
  }
  rec.scanning = true;
  if (rec.root === undefined) rec.root = rec.git ? repoRootOf(rec.cwd) : null;
  let changed = false;
  try {
    const fh = await fs.promises.open(s.file, 'r');
    try {
      const size = (await fh.stat()).size;
      let buf = Buffer.alloc(1024 * 1024);
      while (s.offset < size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - s.offset), s.offset);
        if (!bytesRead) break;
        const end = buf.lastIndexOf(0x0a, bytesRead - 1) + 1; // whole lines only
        if (!end) {
          // one line longer than the buffer — a Write of a big file does it
          if (bytesRead < buf.length || buf.length >= 64 * 1024 * 1024) break;
          buf = Buffer.alloc(buf.length * 2);
          continue;
        }
        // A tool call from the last few seconds is left for the next read: the
        // hook, when it is there, is still snapshotting that repo properly, and
        // getting there first would settle for the worse base below.
        let pos = 0;
        let held = false;
        while (pos < end) {
          const nl = buf.indexOf(0x0a, pos);
          const line = buf.toString('utf8', pos, nl);
          if (!s.since && line.includes('"timestamp"')) {
            try {
              const t = Date.parse(JSON.parse(line).timestamp);
              if (t) s.since = t;
              // Resumed: the snapshot is from when this pane started, so what
              // the session did before then reads as lying around already.
              // Files the transcript names from then are compared with where
              // HEAD was at its real start (see earlyTouched), and untracked
              // ones count if modified since it. Only named ones: mtime says
              // when a file changed, not which session changed it.
              if (t && rec.git && rec.snapAt && t < rec.snapAt) {
                if (rec.root === undefined) rec.root = repoRootOf(rec.cwd);
                if (rec.root) rec.earlyBase = commitAt(rec.root, t) || null;
                rec.realStart = t;
                changed = true;
              }
            } catch {}
          }
          let j = null;
          if (line.includes('"tool_use"') && /"(file|notebook)_path"|"name":"Bash"/.test(line)) {
            try {
              j = JSON.parse(line);
            } catch {}
          }
          if (j && Date.now() - (Date.parse(j.timestamp) || 0) < 5000) {
            held = true;
            break;
          }
          pos = nl + 1;
          const content = j?.message?.content;
          if (!Array.isArray(content)) continue;
          const since = s.since || Date.now();
          const at = j.cwd || rec.cwd;
          for (const c of content) {
            if (c?.type !== 'tool_use') continue;
            if (c.name === 'Bash') {
              if (rec.root) {
                const early = earlyEdit(rec, j);
                for (const p of namedFiles(String(c.input?.command || ''), at, rec.root)) {
                  if (addRel(rec, 'touchedMain', p)) changed = true;
                  if (early && addRel(rec, 'earlyTouched', p)) changed = true;
                }
              }
              for (const p of bashPaths(String(c.input?.command || ''), at)) {
                if (addExtraRepo(rec, canonPath(p), { since, bash: true })) changed = true;
              }
              continue;
            }
            if (!EDIT_TOOLS.has(c.name)) continue;
            const target = c.input?.file_path || c.input?.notebook_path;
            if (!target) continue;
            const abs = canonPath(path.resolve(at, target));
            // An edit in its own repo from before this pane started, as in a
            // resumed session: the snapshot taken then already holds it, so
            // it would never show. Named here, it is diffed from the
            // session's real start instead. Changes made by shell commands
            // then name no file and stay out of reach.
            if (rec.root && within(rec.root, abs)) {
              if (addRel(rec, 'touchedMain', abs)) changed = true;
              if (earlyEdit(rec, j) && addRel(rec, 'earlyTouched', abs)) changed = true;
              continue;
            }
            if (addExtraRepo(rec, abs, { since })) changed = true;
          }
        }
        s.offset += pos;
        if (held) break;
      }
    } finally {
      await fh.close();
    }
  } catch {
  } finally {
    rec.scanning = false;
  }
  if (changed && diffSel?.agentId === agentId) selectDiff(agentId, diffSel.mode);
}

// tp-<agent> only grows; how far each has been read is kept by file, since a
// claude relaunched in the same pane is a new record but the same file.
const touchRead = new Map(); // file -> bytes read

function touchedPaths(agentId, file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return;
  }
  const from = touchRead.get(file) || 0;
  const end = buf.lastIndexOf(0x0a) + 1; // whole lines only
  if (end <= from) return;
  touchRead.set(file, end);
  const rec = agents.get(agentId);
  for (const line of buf.toString('utf8', from, end).split('\n')) {
    const [id, p, kind] = line.split('|');
    if (!id || !p) continue;
    const ack = () => {
      try { fs.writeFileSync(path.join(STATUS_DIR, 'ta-' + agentId + '-' + id), ''); } catch {}
    };
    let added = false;
    let ready = null;
    try {
      const file = canonPath(p);
      added = Boolean(rec) && addExtraRepo(rec, file, { bash: kind === 'bash' });
      ready = rec && extraRepoFor(rec, file)?.ready;
    } catch {}
    // the hook holds the edit back until the repo's snapshot is taken
    Promise.resolve(ready)
      .catch(() => {})
      .then(() => {
        ack();
        if (added && diffSel?.agentId === agentId) selectDiff(agentId, diffSel.mode);
      });
  }
  // the one before this has run by now, and may have changed a repo no
  // watcher covers
  diffSoon(agentId);
}

function readSessionId(agentId) {
  try {
    return fs.readFileSync(path.join(STATUS_DIR, 'sid-' + agentId), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function hookSettingsFile(agentId) {
  const statusFile = path.join(STATUS_DIR, 'st-' + agentId).replace(/\\/g, '/');
  const write = (s) => `node -e "require('fs').writeFileSync('${statusFile}','${s}')"`;
  const cfg = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: write('working') }] }],
      Notification: [{ hooks: [{ type: 'command', command: blockedHook(statusFile) }] }],
      Stop: [{ hooks: [{ type: 'command', command: write('done') }] }],
      // Which Claude Code session this pane is running, so the sessions list can
      // show it as live instead of offering to resume it a second time. Fires
      // again on /clear and on resume, which is when the id changes.
      SessionStart: [{ hooks: [{ type: 'command', command: sessionIdHook(agentId) }] }],
      // A file edit or shell command reaching outside the agent's folder, so
      // another repo's changes can join its diff. Before rather than after:
      // the hook waits for that repo to be snapshotted, and the first change is
      // part of the diff.
      PreToolUse: [
        {
          matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash',
          hooks: [{ type: 'command', command: touchHook(agentId) }]
        }
      ]
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
    .watch(STATUS_DIR, {
      ignoreInitial: true,
      // Every writer here truncates before it writes, and an event fired in
      // between reads an empty file and is ignored — with the event for the
      // real write sometimes never following. That lost "end" (an exited
      // claude left listed as an agent) and "done" (stuck on working). Waiting
      // for the size to settle costs ~60ms and reads the finished file.
      awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 15 }
    })
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
        diffSoon(agentId);
        return;
      }
      if (base.startsWith('tp-')) {
        touchedPaths(base.slice(3), file);
        return;
      }
      if (base.startsWith('sid-')) {
        const agentId = base.slice(4);
        const rec = agents.get(agentId);
        const sessionId = readSessionId(agentId);
        if (!rec || !sessionId || rec.sessionId === sessionId) return;
        rec.sessionId = sessionId;
        rec.title = null;
        lastTitleScan = 0;
        broadcast('agent:session', { agentId, sessionId });
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
          agentEnded(agentId);
        }
      }
    });
  setInterval(() => {
    broadcastStatuses();
    refreshAgentTitles();
    if (diffSel) scanTranscriptEdits(diffSel.agentId);
  }, 1500);
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

ipcMain.handle('agents:spawn', (_e, { spacePath }) => {
  const cwd = canonPath(spacePath);
  if (!cwd || !fs.existsSync(cwd)) return { error: 'That folder no longer exists: ' + spacePath };
  // any folder will do; outside git there is just no branch and no diff
  const info = gitInfo(cwd);
  const branch = info.branch || '(no git)';
  const snap = info.git ? snapshotBase(cwd, info.baseCommit) : { base: null, untracked: new Set() };

  // with auto-detect on, the session wrapper handles hooks + registration;
  // otherwise pre-register the agent and pass the settings file explicitly
  const autoDetect = (readTheme() || DEFAULT_THEME).autoDetectAgents !== false;
  if (autoDetect) {
    return { agentId: null, cwd, branch, git: info.git, run: 'claude' };
  }
  const agentId = 'ag-' + ++agentCounter;
  const settingsFile = hookSettingsFile(agentId);
  agents.set(agentId, {
    ptyId: null,
    cwd,
    baseCommit: snap.base,
    untrackedAtStart: snap.untracked,
    startedAt: Date.now(),
    snapAt: Date.now(),
    git: info.git,
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
    git: info.git,
    run: `claude --settings "${settingsFile}"`
  };
});

// ---------- Claude Code sessions ----------
// Claude Code keeps one transcript per session under
// ~/.claude/projects/<mangled cwd>/<session id>.jsonl. Frost only reads them:
// the newest few, and only their ends — a transcript runs to megabytes, but the
// cwd sits near the top and the title near the bottom.

// The screenshot tool points this at a sandbox, so the sessions list in a
// README image can only ever show the demo repo. claude itself keeps the real
// directory — its login lives there.
const CLAUDE_DIR =
  SHOT?.claudeDir || process.env.CLAUDE_CONFIG_DIR || path.join(require('os').homedir(), '.claude');
const CLAUDE_PROJECTS = path.join(CLAUDE_DIR, 'projects');
const SESSION_LIMIT = 15;
const sessionCache = new Map(); // file -> { mtimeMs, info }
const transcriptPaths = new Map(); // session id -> transcript file

function readSlice(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function jsonLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      out.push(JSON.parse(line));
    } catch {} // the cut at either end of a slice
  }
  return out;
}

function readClaudeSession(file, size) {
  const head = jsonLines(readSlice(file, 0, Math.min(size, 64 * 1024)));
  const tailStart = Math.max(0, size - 256 * 1024);
  const tail = tailStart ? jsonLines(readSlice(file, tailStart, size - tailStart)) : head;
  const first = head.find((l) => l.cwd);
  if (!first) return null; // nothing but bookkeeping, never really started
  let custom = null;
  let ai = null;
  let prompt = null;
  let branch = first.gitBranch || null;
  for (const l of tail) {
    if (l.type === 'custom-title' && l.customTitle) custom = l.customTitle;
    else if (l.type === 'ai-title' && l.aiTitle) ai = l.aiTitle;
    else if (l.type === 'last-prompt' && l.lastPrompt) prompt = l.lastPrompt;
    if (l.gitBranch) branch = l.gitBranch;
  }
  // /rename also leaves the name beside the transcript, which outlasts the
  // lines scrolling out of the tail on a long session
  try {
    const side = JSON.parse(fs.readFileSync(file.slice(0, -6) + path.sep + 'custom-title.json', 'utf8'));
    if (side.customTitle) custom = side.customTitle;
  } catch {}
  // a name the user gave it beats the one Claude Code made up
  const name = custom || ai || (prompt || '').split(/\r?\n|\r/)[0].trim() || null;
  return { cwd: canonPath(first.cwd), title: name, branch };
}

// Cached by mtime, so asking again about a transcript that hasn't been written
// to costs one stat. `maxAge` lets a caller take a parse that recent even if
// the file has moved on since: a working session's transcript changes on every
// line claude writes, and re-reading it on each status tick buys nothing.
function sessionInfo(file, st, maxAge = 0) {
  let cached = sessionCache.get(file);
  const fresh = cached && (cached.mtimeMs === st.mtimeMs || Date.now() - cached.readAt < maxAge);
  if (!fresh) {
    let info = null;
    try {
      info = readClaudeSession(file, st.size);
    } catch {}
    cached = { mtimeMs: st.mtimeMs, readAt: Date.now(), info };
    sessionCache.set(file, cached);
  }
  return cached.info;
}

function scanTranscripts() {
  const files = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(CLAUDE_PROJECTS, d.name);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const file = path.join(dir, n);
      try {
        const st = fs.statSync(file);
        const id = n.slice(0, -6);
        transcriptPaths.set(id, file);
        files.push({ file, id, st });
      } catch {}
    }
  }
  return files;
}

// Claude Code registers every running process in ~/.claude/sessions/<pid>.json
// — session id, cwd, and the name /rename gave it. It is not a documented
// format, so anything unexpected just means "nothing known to be running".
// A file whose process is gone is left over from a crash, and doesn't count.
function runningClaudeSessions() {
  const running = new Map(); // session id -> { pid, name, custom }
  const dir = path.join(CLAUDE_DIR, 'sessions');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return running;
  }
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (!s.sessionId || !s.pid) continue;
      try {
        process.kill(s.pid, 0); // signal 0 only asks whether it exists
      } catch (e) {
        if (e.code === 'ESRCH') continue;
      }
      running.set(s.sessionId, { pid: s.pid, name: s.name || null, custom: s.nameSource === 'user' });
    } catch {}
  }
  return running;
}

// `exclude` is what already shows as a live agent, left out before counting so
// the list still holds SESSION_LIMIT rows however many are running.
function listClaudeSessions(exclude = []) {
  const skip = new Set(exclude);
  const running = runningClaudeSessions();
  const files = scanTranscripts().sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const out = [];
  for (const f of files) {
    if (out.length >= SESSION_LIMIT) break;
    if (skip.has(f.id)) continue;
    const info = sessionInfo(f.file, f.st);
    if (!info) continue;
    const live = running.get(f.id);
    out.push({
      id: f.id,
      ...info,
      title: (live?.custom && live.name) || info.title || path.basename(info.cwd),
      lastActive: f.st.mtimeMs,
      exists: fs.existsSync(info.cwd),
      // open in some other terminal, or another Frost: resuming it here too
      // would put two processes on one transcript
      runningElsewhere: Boolean(live)
    });
  }
  return out;
}

ipcMain.handle('claude:sessions', (_e, exclude) => listClaudeSessions(exclude));

// Every folder claude has run in, newest first, for New session to offer. It
// reaches past the sessions list's cut-off, but only reads the top of each
// transcript — the cwd is on its first lines — and never again for the same
// file, since where a session ran doesn't change.
const FOLDER_LIMIT = 30;
const transcriptCwds = new Map(); // file -> cwd, or null for one that never started

function transcriptCwd(file, size) {
  if (transcriptCwds.has(file)) return transcriptCwds.get(file);
  let cwd = null;
  try {
    const first = jsonLines(readSlice(file, 0, Math.min(size, 64 * 1024))).find((l) => l.cwd);
    if (first) cwd = canonPath(first.cwd);
  } catch {}
  // an empty one may simply not have been written to yet; ask again next time
  if (cwd || size > 0) transcriptCwds.set(file, cwd);
  return cwd;
}

function recentClaudeFolders() {
  const files = scanTranscripts().sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const seen = new Set();
  const out = [];
  for (const f of files) {
    if (out.length >= FOLDER_LIMIT) break;
    const cwd = transcriptCwd(f.file, f.st.size);
    const key = String(cwd || '').toLowerCase();
    if (!cwd || seen.has(key)) continue;
    seen.add(key);
    if (fs.existsSync(cwd)) out.push(cwd);
  }
  return out;
}

ipcMain.handle('claude:folders', () => recentClaudeFolders());

// What a live agent should be called: the name you gave it with /rename, else
// the title Claude Code made up. Checked on the status tick, so a rename shows
// up within a couple of seconds wherever the agent is named.
function sessionTitle(sessionId, running) {
  const live = running.get(sessionId);
  if (live?.custom && live.name) return live.name;
  let file = transcriptPaths.get(sessionId);
  if (!file) {
    scanTranscripts();
    file = transcriptPaths.get(sessionId);
  }
  if (!file) return null;
  try {
    // a /rename arrives through `running` above; only Claude Code's own title
    // waits on this, and it is written once per session
    return sessionInfo(file, fs.statSync(file), 10000)?.title || null;
  } catch {
    transcriptPaths.delete(sessionId);
    return null;
  }
}

let lastTitleScan = 0;
function refreshAgentTitles() {
  if (Date.now() - lastTitleScan < 2000) return;
  lastTitleScan = Date.now();
  const live = [...agents].filter(([, rec]) => rec.sessionId && !rec.exited);
  if (!live.length) return;
  const running = runningClaudeSessions();
  for (const [agentId, rec] of live) {
    const title = sessionTitle(rec.sessionId, running);
    if (!title || title === rec.title) continue;
    rec.title = title;
    broadcast('agent:title', { agentId, title });
  }
}

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
// Run from source, Frost keeps its config in the repo it is being worked on,
// and every save there would recompute the diff of the agent working on it.
const inConfigDir = (p) => {
  const rel = path.relative(CONFIG_DIR, p);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};
const isNoisyPath = (p) => NOISY_RE.test(p) || inConfigDir(p);

// Async, because the pty streams pass through this process: a git that blocks
// it on a big repo holds every terminal's output and keystrokes until it ends.
function gitOut(cwd, args, maxBuffer = 1024 * 1024) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...UTF8_PATHS, ...args], { encoding: 'utf8', maxBuffer, windowsHide: true }, (_err, stdout) =>
      resolve(stdout || '')
    );
  });
}

// One diff view at a time, keyed so the renderer can tell whose diff arrived.
// `key` identifies the agent whose diff it is; `repos` are its own folder
// (main) and any other repo it has edited files in.
let diffView = null; // { key, mode, repos: [{ main?, cwd, name?, branch?, base, hideUntracked }] }
let diffSel = null; // { agentId, mode } — what the panel last asked for
const diffWatchers = new Map(); // cwd -> watcher, or null while one is being started
let diffRunning = false;
let diffAgain = false;

const UNTRACKED_CARDS = 200; // shown as new files; past it, listed by name
const UNTRACKED_FILE_MAX = 512 * 1024; // bigger than this is listed by name
const UNTRACKED_STAT_MAX = 5000; // pre-session untracked files checked for edits
const untrackedText = new Map(); // abs path -> { mtimeMs, size, text }
const diffRoots = new Map(); // cwd -> its repo's top folder, which status paths are relative to

// A new file the session made is its work even before anyone runs git add, but
// git diff can't see it. So untracked files are split: the session's own are
// turned into "new file" patches, drawn like any added file, and the rest stay
// the folded list they were. The session's own are the ones not there at the
// start, whatever lies inside a folder that wasn't, and any older untracked
// file modified since the session began — git folds a whole untracked folder
// into one line, and a file written into a folder that was already untracked
// hides behind that line otherwise. mtime rather than a watcher: the watcher
// only runs while the panel shows this agent, and would miss the rest.
// Returns the patch to append and the status lines left for the folded list.
async function splitUntracked(r, raw, mode) {
  const lines = raw.split(/\r?\n/).filter((l) => l.startsWith('??'));
  const hide = r.hideUntracked;
  // The snapshot folds an untracked folder into one line, while a status
  // limited to some files lists them one by one: a file is as old as the
  // folder it sits in.
  const hidden = hide && new Set([...hide].map((l) => unquotePath(l.slice(3).trim())));
  const inSnapshot = (l) => {
    const p = unquotePath(l.slice(3).trim());
    if (hidden.has(p)) return true;
    for (let i = p.indexOf('/'); i > -1 && i < p.length - 1; i = p.indexOf('/', i + 1)) {
      if (hidden.has(p.slice(0, i + 1))) return true;
    }
    return false;
  };
  const fresh = [];
  const old = [];
  for (const l of lines) {
    // no snapshot: files the transcript named are the session's; otherwise
    // nothing can be told apart but by mtime
    const isOld = hide ? inSnapshot(l) : !r.only?.size;
    (isOld ? old : fresh).push(l);
  }
  if (!diffRoots.has(r.cwd)) diffRoots.set(r.cwd, repoRootOf(r.cwd) || r.cwd);
  const root = diffRoots.get(r.cwd);
  const rel = (l) => unquotePath(l.slice(3).trim());
  const dirs = [...fresh, ...old].filter((l) => rel(l).endsWith('/'));
  const freshDirs = new Set(fresh.filter((l) => dirs.includes(l)).map(rel));
  let inDirs = [];
  if (dirs.length && dirs.length <= 300) {
    const out = await gitOut(
      root,
      ['ls-files', '--others', '--exclude-standard', '--', ...dirs.map((l) => ':(literal)' + rel(l))],
      16 * 1024 * 1024
    );
    inDirs = out.split(/\r?\n/).filter(Boolean).map(unquotePath);
  }
  const underFresh = (f) => {
    for (const d of freshDirs) if (f.startsWith(d)) return true;
    return false;
  };
  const candidates = []; // [rel, known to be the session's]
  for (const l of fresh) if (!rel(l).endsWith('/')) candidates.push([rel(l), true]);
  for (const f of inDirs) candidates.push([f, underFresh(f)]);
  for (const l of old) if (!rel(l).endsWith('/')) candidates.push([rel(l), false]);

  const since = r.startedAt || Infinity;
  let statted = 0;
  const mine = [];
  await Promise.all(
    candidates.map(async ([f, known]) => {
      // named by the transcript from before a resume: its own if changed
      // since the session really began, not just since the pane did
      const from = r.realStart && r.early?.has(f) ? r.realStart : since;
      if (!known && (from === Infinity || ++statted > UNTRACKED_STAT_MAX)) return;
      try {
        const st = await fs.promises.stat(path.join(root, f));
        if (!st.isFile() || (!known && st.mtimeMs < from)) return;
        mine.push({ f, st });
      } catch {}
    })
  );
  mine.sort((a, b) => (a.f < b.f ? -1 : 1));

  const cards = [];
  const byName = [];
  for (const m of mine) {
    if (cards.length < UNTRACKED_CARDS && m.st.size <= UNTRACKED_FILE_MAX) cards.push(m);
    else byName.push('?? ' + m.f);
  }
  const patches = await Promise.all(cards.map((m) => newFilePatch(root, m.f, m.st)));

  // the session view never listed what was untracked before it; the working
  // tree view does, folded, less what was drawn above
  const drawn = new Set(cards.map((m) => m.f));
  const keep = (l) => !drawn.has(rel(l));
  const rest = [...(mode === 'uncommitted' || !hide ? old.filter(keep) : []), ...fresh.filter((l) => keep(l) && !freshDirs.has(rel(l)))];
  // a new folder whose files didn't all fit is still worth pointing at
  for (const d of freshDirs) {
    if (!cards.some((m) => m.f.startsWith(d))) rest.push('?? ' + d);
  }
  // unquoted for the list, whose rows open the file by this name
  const listed = [...rest.map((l) => '?? ' + rel(l)), ...byName];
  return { patch: patches.join(''), status: [...new Set(listed)].join('\n'), root };
}

// What git diff --no-index /dev/null <file> prints, without a git per file:
// a session can make a few hundred, and this runs on every save.
async function newFilePatch(cwd, f, st) {
  const abs = path.join(cwd, f);
  const hit = untrackedText.get(abs);
  let text;
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    text = hit.text;
  } else {
    let buf;
    try {
      buf = await fs.promises.readFile(abs);
    } catch {
      return '';
    }
    const head = `diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n`;
    // git's own test for binary: a NUL in the first 8000 bytes
    if (buf.subarray(0, 8000).includes(0)) {
      text = head + `Binary files /dev/null and b/${f} differ\n`;
    } else {
      const body = buf.toString('utf8').split(/\r?\n/);
      if (body[body.length - 1] === '') body.pop();
      text = head + (body.length ? `@@ -0,0 +1,${body.length} @@\n` + body.map((l) => '+' + l).join('\n') + '\n' : '');
    }
    if (untrackedText.size > 2000) untrackedText.clear();
    untrackedText.set(abs, { mtimeMs: st.mtimeMs, size: st.size, text });
  }
  return text;
}

function recRoot(rec) {
  if (rec.root === undefined) rec.root = rec.git ? repoRootOf(rec.cwd) : null;
  return rec.root;
}

// The files this agent's Session should keep to, when another live agent is
// in the same repo; null when it has the repo to itself (or has named more
// files than a command line holds), and the whole diff is its own.
function sharedFiles(rec) {
  const root = rec && recRoot(rec);
  if (!root) return null;
  const other = [...agents.values()].some(
    (o) => o !== rec && !o.exited && o.git && recRoot(o)?.toLowerCase() === root.toLowerCase()
  );
  if (!other) return null;
  const list = [...(rec.touchedMain || [])];
  return list.length <= 300 ? list : null;
}

// One git at a time: changes landing mid-run ask for a single rerun after it,
// rather than stacking a git per burst.
async function runDiff() {
  if (diffRunning) {
    diffAgain = true;
    return;
  }
  const view = diffView;
  if (!view) return;
  diffRunning = true;
  try {
    const { key, mode, repos } = view;
    let surfaced = false;
    const results = await Promise.all(
      repos.map(async (r) => {
        // session = everything since the base commit (survives the agent
        // committing); uncommitted = working tree vs HEAD only
        const target = mode === 'uncommitted' ? 'HEAD' : r.base;
        // a repo found in the transcript shows only the files the session
        // touched; past a few hundred the command line would run out first
        const only = r.only?.size && r.only.size <= 300 ? ['--', ...[...r.only].map((p) => ':(literal)' + p)] : [];
        // another live agent works in the same repo: this one's Session keeps
        // to the files its own transcript names, or it would show the other's
        // work as well. Uncommitted is the working tree, whoever changed it.
        const mine = r.main && mode !== 'uncommitted' ? sharedFiles(r.agent) : null;
        let patch;
        let raw;
        const early = mode !== 'uncommitted' && r.earlyBase && r.early?.size && r.early.size <= 300 ? [...r.early] : null;
        if (mine) {
          const spec = (list) => ['--', ...list.map((p) => ':(top,literal)' + p)];
          const before = mine.filter((p) => early?.includes(p));
          const after = mine.filter((p) => !early?.includes(p));
          const [a, b, st] = await Promise.all([
            before.length ? gitOut(r.cwd, ['diff', r.earlyBase, ...spec(before)], 16 * 1024 * 1024) : '',
            after.length ? gitOut(r.cwd, ['diff', target, ...spec(after)], 16 * 1024 * 1024) : '',
            mine.length ? gitOut(r.cwd, ['status', '--porcelain', '-uall', ...spec(mine)]) : ''
          ]);
          patch = a + b;
          raw = st;
        } else if (early) {
          // resumed: what it edited before this pane started, from its real
          // start; everything else from the snapshot, as usual
          const [before, rest] = await Promise.all([
            gitOut(r.cwd, ['diff', r.earlyBase, '--', ...early.map((p) => ':(top,literal)' + p)], 16 * 1024 * 1024),
            gitOut(r.cwd, ['diff', target, '--', ...early.map((p) => ':(top,exclude,literal)' + p)], 16 * 1024 * 1024)
          ]);
          patch = before + rest;
        } else {
          patch = await gitOut(r.cwd, ['diff', target, ...only], 16 * 1024 * 1024);
        }
        raw ??= await gitOut(r.cwd, ['status', '--porcelain', ...(only.length ? ['-uall'] : []), ...only]);
        // untracked before the session began: not its work
        const sinceStart = r.hideUntracked?.size
          ? raw.split(/\r?\n/).filter((l) => !r.hideUntracked.has(l)).join('\n')
          : raw;
        const split = await splitUntracked(r, raw, mode);
        const status = [...raw.split(/\r?\n/).filter((l) => l && !l.startsWith('??')), split.status].filter(Boolean).join('\n');
        // a repo a shell command only pointed at shows once the session has
        // changed something in it, and stays from then on
        const src = r.src;
        if (src?.quiet) {
          const sessionPatch = mode === 'uncommitted' ? await gitOut(r.cwd, ['diff', '--name-only', r.base]) : patch;
          if (sessionPatch.trim() || sinceStart.trim() || split.patch) {
            src.quiet = false;
            surfaced = true;
          }
        }
        return { main: r.main, cwd: r.cwd, name: r.name, branch: r.branch, patch: patch + split.patch, status, root: split.root, quiet: src?.quiet };
      })
    );
    // switched agent or mode while git ran: this answer is for a view that's gone
    if (view !== diffView) return;
    const main = results.find((r) => r.main);
    const extra = results.filter((r) => !r.main && !r.quiet).map(({ main: _m, quiet: _q, ...r }) => r);
    broadcast('agent:diff', { key, patch: main?.patch || '', status: main?.status || '', root: main?.root, nogit: !main, extra });
    if (surfaced) watchDiff(view); // now worth a watcher of its own
  } finally {
    diffRunning = false;
    if (diffAgain) {
      diffAgain = false;
      runDiff();
    }
  }
}

// The selected agent did something — a turn began or ended, a tool is about to
// run — that may have changed a repo no watcher covers.
function diffSoon(agentId) {
  if (diffSel?.agentId !== agentId) return;
  clearTimeout(diffTimer);
  diffTimer = setTimeout(runDiff, 400);
}

function watchDiff(view) {
  clearTimeout(diffTimer);
  diffView = view?.repos.length ? view : null;
  // Watching a repo means walking it first, so a watcher is kept for as long
  // as its folder stays in the view; clicking between agents, or between
  // Session and Uncommitted, only changes what the next diff asks git.
  // A repo still quiet goes unwatched: a grep into a big one would otherwise
  // walk all of it for nothing. The agent's turns ask for a diff instead
  // (diffSoon), which is when a shell command there would have changed it.
  const want = new Set((diffView?.repos || []).filter((r) => !r.src?.quiet).map((r) => r.cwd));
  for (const [cwd, w] of diffWatchers) {
    if (want.has(cwd)) continue;
    w?.close();
    diffWatchers.delete(cwd); // also calls off a watcher still being started
  }
  if (!diffView) return;
  runDiff();
  for (const cwd of want) {
    if (diffWatchers.has(cwd)) continue; // watching it, or about to
    diffWatchers.set(cwd, null);
    startDiffWatcher(cwd);
  }
}

// Whatever the repo gitignores can't appear in its diff, and it is where the
// bulk usually is: a CMake build tree alone can be tens of thousands of files,
// each one walked and watched for nothing. The fixed list above still covers a
// build folder made after the watch began.
async function startDiffWatcher(cwd) {
  const listed = await gitOut(cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'], 16 * 1024 * 1024);
  if (!diffWatchers.has(cwd) || diffWatchers.get(cwd)) return; // moved on while git ran
  const gitIgnored = new Set(
    listed
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => path.join(cwd, l.replace(/\/$/, '')).toLowerCase())
  );
  // a path is ignored if it, or a folder above it, is listed
  const ignoredByGit = (p) => {
    const rel = path.relative(cwd, p);
    if (!rel || rel.startsWith('..')) return false;
    let at = cwd;
    for (const part of rel.split(path.sep)) {
      at = path.join(at, part);
      if (gitIgnored.has(at.toLowerCase())) return true;
    }
    return false;
  };
  const watcher = chokidar
    .watch(cwd, {
      ignored: (p) => isNoisyPath(p) || ignoredByGit(p),
      ignoreInitial: true,
      depth: 8
    })
    .on('all', () => {
      clearTimeout(diffTimer);
      diffTimer = setTimeout(runDiff, 400);
    });
  diffWatchers.set(cwd, watcher);
}

function selectDiff(agentId, mode) {
  const rec = agentId && agents.get(agentId);
  diffSel = rec ? { agentId, mode } : null;
  if (!rec) {
    watchDiff(null);
    return;
  }
  const repos = [];
  if (rec.git) {
    repos.push({
      main: true,
      cwd: rec.cwd,
      base: rec.baseCommit,
      hideUntracked: rec.untrackedAtStart,
      startedAt: rec.startedAt,
      early: rec.earlyTouched,
      earlyBase: rec.earlyBase,
      realStart: rec.realStart,
      agent: rec
    });
  }
  for (const x of rec.extraRepos?.values() || []) {
    if (x.ready) continue; // its snapshot is still being taken
    repos.push({
      cwd: x.cwd,
      name: x.name,
      branch: x.branch,
      base: x.base,
      hideUntracked: x.untrackedAtStart,
      startedAt: x.startedAt,
      only: x.touched,
      src: x
    });
  }
  scanTranscriptEdits(agentId); // calls back here if it finds another repo
  if (!repos.length) {
    watchDiff(null);
    broadcast('agent:diff', { key: 'agent:' + agentId, patch: '', status: '', nogit: true, extra: [] });
    return;
  }
  watchDiff({ key: 'agent:' + agentId, mode, repos });
}

ipcMain.on('agents:selectDiff', (_e, payload) => {
  const { agentId, mode } = payload || {};
  selectDiff(agentId, mode);
});

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

ipcMain.handle('paths:open', async (_e, { cwd, target, line, column }) => {
  const abs = resolveTarget(cwd, target);
  if (!abs) {
    // a folder git lists as one untracked entry: no editor opens that, Explorer
    // does. resolveTarget stays files-only, since it also decides which words
    // in terminal output become links.
    const dir = typeof target === 'string' && !/[\0<>|"*?&^%`$]/.test(target) && cwd ? path.resolve(cwd, target) : null;
    try {
      if (dir && fs.statSync(dir).isDirectory()) {
        const err = await shell.openPath(dir);
        return err ? { error: err } : { opened: 'explorer' };
      }
    } catch {}
    return { error: 'not found: ' + target };
  }
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
