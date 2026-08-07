const {
  app,
  BrowserWindow,
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
  minContrast: 4.5,
  gpuRenderer: true,
  autoDetectAgents: true,
  restoreSession: true,
  notify: { agentBlocked: true, agentDone: true, commandSeconds: 20 },
  agentLayout: { rail: 210, diff: 340 },
  copyOnSelect: true,
  unicodeVersion: '11',
  tint: 'rgba(0, 0, 0, 0.00)',
  accent: '#80a8ff',
  padding: 14,
  cornerRadius: 13,
  windowRadius: 12,
  font: {
    family: '"Cascadia Mono", Consolas, monospace',
    size: 14,
    lineHeight: 1.25
  },
  cursor: { style: 'bar', blink: true },
  terminal: {
    foreground: '#cccccc',
    cursor: '#ffffff',
    selectionBackground: 'rgba(255, 255, 255, 0.30)',
    black: '#0c0c0c',
    red: '#c50f1f',
    green: '#13a10e',
    yellow: '#c19c00',
    blue: '#0037da',
    magenta: '#881798',
    cyan: '#3a96dd',
    white: '#cccccc',
    brightBlack: '#767676',
    brightRed: '#e74856',
    brightGreen: '#16c60c',
    brightYellow: '#f9f1a5',
    brightBlue: '#3b78ff',
    brightMagenta: '#b4009e',
    brightCyan: '#61d6d6',
    brightWhite: '#f2f2f2'
  }
};

let win = null;
let ptyCounter = 0;
const ptys = new Map();
// A shell belongs to the window that asked for it, so its output must go there
// and nowhere else.
const ptyOwners = new Map(); // ptyId -> WebContents

function sendToOwner(id, channel, payload) {
  const owner = ptyOwners.get(id);
  if (owner && !owner.isDestroyed()) owner.send(channel, payload);
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
    return hits.find((h) => /\.exe$/i.test(h)) || hits[0];
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
  return BrowserWindow.getFocusedWindow() || (win && !win.isDestroyed() ? win : liveWindows()[0]) || null;
}

const anyWindowFocused = () => liveWindows().some((w) => w.isFocused());

function glassBounds(target) {
  const w = target && !target.isDestroyed() ? target : win;
  if (!w) return { bounds: null, display: null };
  return { bounds: w.getContentBounds(), display: screen.getDisplayMatching(w.getBounds()).bounds };
}

function applyWindowTheme(theme) {
  if (!theme) return;
  // The acrylic/mica base layer follows the app's color mode:
  // light mode = whitish frost, dark mode = dark smoke.
  nativeTheme.themeSource = theme.colorMode || 'dark';
  const material = theme.material || 'acrylic';
  for (const w of liveWindows()) {
    if (w.isFramelessMode) continue;
    try {
      w.setBackgroundMaterial(material === 'acrylic-always' ? 'acrylic' : material);
    } catch {}
    try {
      w.setTitleBarOverlay({
        color: '#00000000',
        symbolColor: theme.terminal?.foreground || '#ffffff',
        height: 38
      });
    } catch {}
  }
}

// ---------- window + session state ----------
// window.json is written continuously rather than on close, so a crash or a
// kill still leaves the last layout on disk.

let sessionLayout = null; // last { tabs, activeTab } the renderer reported
let sessionTimer = null;

function readWindowState() {
  try {
    return JSON.parse(fs.readFileSync(WINDOW_FILE, 'utf8'));
  } catch {
    return {};
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

function flushWindowState() {
  clearTimeout(sessionTimer);
  sessionTimer = null;
  if (!win) return;
  const prev = readWindowState();
  const layout = sessionLayout || { tabs: prev.tabs || [], activeTab: prev.activeTab || 0 };
  const out = { ...layout };
  if (!win.isMinimized()) {
    out.bounds = win.getNormalBounds();
    out.maximized = win.isMaximized();
  } else {
    out.bounds = prev.bounds;
    out.maximized = prev.maximized;
  }
  try {
    fs.writeFileSync(WINDOW_FILE, JSON.stringify(out, null, 2));
  } catch {}
}

function saveWindowStateSoon() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(flushWindowState, 500);
}

// Only one window may host the agent tab: agents are global, so a second one
// would render an identical list and both would fight over the diff watcher.
let agentWindow = null;

function createWindow({ isPrimary = false } = {}) {
  const theme = readTheme() || DEFAULT_THEME;
  const material = theme.material || 'acrylic';
  const alwaysOn = material === 'acrylic-always';
  const glass = material === 'glass';
  nativeTheme.themeSource = theme.colorMode || 'dark';

  const saved = readWindowState();
  const opts = {
    width: 1100,
    height: 700,
    minWidth: 480,
    minHeight: 300,
    show: false,
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  };

  if (glass) {
    // Truly transparent window; the renderer draws its own blurred wallpaper
    // and window buttons. No DWM backdrop involved at all.
    opts.transparent = true;
    opts.frame = false;
  } else {
    opts.backgroundMaterial = alwaysOn ? 'acrylic' : material;
    opts.titleBarStyle = 'hidden';
    opts.titleBarOverlay = {
      color: '#00000000',
      symbolColor: theme.terminal?.foreground || '#ffffff',
      height: 38
    };
  }

  // Only the primary window restores geometry; a second window is a deliberate
  // new surface and gets offset so it doesn't land exactly on the first.
  if (SHOT?.bounds) Object.assign(opts, SHOT.bounds);
  else if (isPrimary && boundsVisible(saved.bounds)) Object.assign(opts, saved.bounds);
  else if (!isPrimary) {
    const from = focusedWindow();
    if (from) {
      const b = from.getBounds();
      Object.assign(opts, { x: b.x + 34, y: b.y + 34, width: b.width, height: b.height });
    }
  }

  const w = new BrowserWindow(opts);
  w.isFramelessMode = glass;
  windows.add(w);
  if (isPrimary) win = w;

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

  if (isPrimary) {
    for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) {
      w.on(ev, saveWindowStateSoon);
    }
    w.on('close', flushWindowState);
  }

  currentMaterial = material;
  w.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  w.once('ready-to-show', () => {
    if (isPrimary && saved.maximized) w.maximize();
    w.show();
  });
  w.on('closed', () => {
    windows.delete(w);
    if (agentWindow === w) agentWindow = null;
    // hand primary status on, so the last window standing still saves its state
    if (win === w) win = liveWindows()[0] || null;
  });
  return w;
}

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
        const crossesGlass =
          (theme.material === 'glass') !== (currentMaterial === 'glass');
        applyWindowTheme(theme);
        broadcast('theme:changed', {
          theme,
          css: readCss(),
          notice: crossesGlass ? 'Restart the app to switch Glass mode on/off' : undefined
        });
        currentMaterial = theme.material || 'acrylic';
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

ipcMain.handle('pty:create', (event, { cols, rows, cwd, run, profileId }) => {
  const id = String(++ptyCounter);
  ptyOwners.set(id, event.sender);
  const profile = findProfile(profileId);
  const autoDetect = (readTheme() || DEFAULT_THEME).autoDetectAgents !== false;
  // agentWrapper names the shell dialect: it decides both how the `claude`
  // wrapper is written and how the cwd hook is installed. 'none' = neither.
  const dialect = profile.agentWrapper || 'none';
  const withClaude = autoDetect && dialect !== 'none';
  let args = Array.isArray(profile.args) ? [...profile.args] : [];
  let env = { ...process.env, ...(profile.env || {}) };
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
  const p = pty.spawn(profile.shell, args, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: startCwd,
    env
  });
  ptys.set(id, p);
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
});

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
  if (p) {
    ptys.delete(id);
    p.kill();
  }
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

ipcMain.on('win:minimize', (event) => windowOf(event)?.minimize());
ipcMain.on('win:maximize', (event) => {
  const w = windowOf(event);
  if (!w) return;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});
ipcMain.on('win:close', (event) => windowOf(event)?.close());
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
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png')
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

ipcMain.handle('session:get', () => {
  const s = readWindowState();
  return { tabs: Array.isArray(s.tabs) ? s.tabs : [], activeTab: s.activeTab || 0 };
});

ipcMain.on('session:layout', (_e, layout) => {
  sessionLayout = layout && Array.isArray(layout.tabs) ? layout : null;
  saveWindowStateSoon();
});

ipcMain.on('theme:openFile', (_e, which) => {
  shell.openPath(which === 'css' ? CSS_FILE : which === 'keys' ? KEYS_FILE : THEME_FILE);
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
  // Windows attributes toasts by this id, matching it against an installed
  // shortcut, so it has to equal electron-builder's appId. Only set when
  // packaged: a dev run has no such shortcut, and an id pointing at nothing
  // risks toasts being dropped rather than merely mislabelled. Dev
  // notifications are filed under Electron instead, which costs nothing.
  //
  // (This does not affect the taskbar icon. A dev run is electron.exe, and
  // Windows takes the taskbar icon from the executable — only a packaged build
  // shows Frost's own.)
  if (app.isPackaged) app.setAppUserModelId('dev.azekyoo.frost');
  ensureConfig();
  initAgentInfra();
  createWindow({ isPrimary: true });
  watchConfig();
});

app.on('before-quit', flushWindowState);

app.on('window-all-closed', () => {
  for (const p of ptys.values()) {
    try { p.kill(); } catch {}
  }
  ptys.clear();
  app.quit();
});
