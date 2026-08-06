const { app, BrowserWindow, ipcMain, shell, nativeTheme, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const chokidar = require('chokidar');
const pty = require('@lydell/node-pty');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');
const THEME_FILE = path.join(CONFIG_DIR, 'theme.json');
const CSS_FILE = path.join(CONFIG_DIR, 'theme.css');
const AGENTS_FILE = path.join(CONFIG_DIR, 'agents.json');
const SESSIONS_FILE = path.join(CONFIG_DIR, 'sessions.json');

const DEFAULT_THEME = {
  material: 'glass',
  colorMode: 'dark',
  glassBlur: 33,
  minContrast: 4.5,
  gpuRenderer: true,
  autoDetectAgents: true,
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

// ---------- shell profiles ----------
// A profile is { id, name, shell, args[], cwd?, env?, agentWrapper }.
// agentWrapper picks the shell dialect used to inject the `claude` wrapper:
// 'powershell' | 'bash' | 'none' (no agent auto-detect in that shell).

function whichExe(name) {
  const r = spawnSync('where.exe', [name], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout && r.stdout.trim()) {
    return r.stdout.trim().split(/\r?\n/)[0];
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

let currentMaterial = 'acrylic';

// Wallpaper for the 'glass' material — the app blurs it itself, DWM stays out.
function getWallpaperDataUrl() {
  try {
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

function glassBounds() {
  const bounds = win.getContentBounds();
  const display = screen.getDisplayMatching(win.getBounds()).bounds;
  return { bounds, display };
}

function applyWindowTheme(theme) {
  if (!win || !theme) return;
  const material = theme.material || 'acrylic';
  // The acrylic/mica base layer follows the app's color mode:
  // light mode = whitish frost, dark mode = dark smoke.
  nativeTheme.themeSource = theme.colorMode || 'dark';
  if (!win.isFramelessMode) {
    try {
      win.setBackgroundMaterial(material === 'acrylic-always' ? 'acrylic' : material);
    } catch {}
  }
  if (!win.isFramelessMode) {
    try {
      win.setTitleBarOverlay({
        color: '#00000000',
        symbolColor: theme.terminal?.foreground || '#ffffff',
        height: 38
      });
    } catch {}
  }
}

function createWindow() {
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

  win = new BrowserWindow(opts);
  win.isFramelessMode = glass;

  const sendBounds = () => {
    // skip while minimized: bounds are bogus (-16000) and would park the
    // glass wallpaper offscreen until the next move/resize
    if (win && win.isFramelessMode && !win.isMinimized()) {
      win.webContents.send('win:bounds', glassBounds());
    }
  };
  win.on('move', sendBounds);
  win.on('resize', sendBounds);
  win.on('restore', sendBounds);
  win.on('show', sendBounds);
  win.on('focus', sendBounds);

  // Windows dims/disables the acrylic backdrop when the window deactivates.
  // Re-applying the material right after blur makes DWM repaint it in its
  // active look — keeps the blur constant when unfocused.
  win.on('blur', () => {
    if (currentMaterial === 'acrylic-always') {
      try {
        win.setBackgroundMaterial('none');
        win.setBackgroundMaterial('acrylic');
      } catch {}
    }
  });

  currentMaterial = material;
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    win = null;
  });
}

function watchConfig() {
  let timer = null;
  chokidar
    .watch([THEME_FILE, CSS_FILE], { ignoreInitial: true })
    .on('all', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!win) return;
        const theme = readTheme();
        if (!theme) {
          win.webContents.send('theme:changed', { error: 'theme.json: invalid JSON — keeping previous theme' });
          return;
        }
        const crossesGlass =
          (theme.material === 'glass') !== (currentMaterial === 'glass');
        applyWindowTheme(theme);
        win.webContents.send('theme:changed', {
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

// Same wrapper for bash-family shells (Git Bash, MSYS). Sourced as the rc file
// so the user's own ~/.bashrc still loads. `type -P` skips functions, otherwise
// the wrapper would resolve to itself and recurse.
const BASH_WRAPPER = [
  '# Frost session rc — exists only inside terminals Frost spawns.',
  '[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc',
  '[ -f ~/.bashrc ] && . ~/.bashrc',
  'claude() {',
  '  local exe; exe=$(type -P claude) || exe=""',
  '  if [ -z "$exe" ]; then echo "claude not found" >&2; return 1; fi',
  '  local here; here=$(pwd -W 2>/dev/null || pwd)',
  '  printf "start|%s" "$here" > "$FROST_LAUNCH"',
  '  "$exe" --settings "$FROST_HOOKS" "$@"',
  '  printf "end|%s" "$here" > "$FROST_LAUNCH"',
  '}',
  ''
].join('\n');

function bashWrapperFile() {
  const f = path.join(STATUS_DIR, 'frost-bashrc');
  fs.writeFileSync(f, BASH_WRAPPER);
  return f;
}

ipcMain.handle('pty:create', (_e, { cols, rows, cwd, run, profileId }) => {
  const id = String(++ptyCounter);
  const profile = findProfile(profileId);
  const autoDetect = (readTheme() || DEFAULT_THEME).autoDetectAgents !== false;
  const wrapper = autoDetect ? profile.agentWrapper || 'none' : 'none';
  let args = Array.isArray(profile.args) ? [...profile.args] : [];
  let env = { ...process.env, ...(profile.env || {}) };
  if (wrapper !== 'none') {
    const agentId = 'pty' + id;
    const hooks = hookSettingsFile(agentId);
    const launch = path.join(STATUS_DIR, 'ln-' + agentId);
    if (wrapper === 'bash') {
      // bash eats backslashes in redirect targets — hand it msys-style paths
      env.FROST_HOOKS = hooks.replace(/\\/g, '/');
      env.FROST_LAUNCH = launch.replace(/\\/g, '/');
      args = ['--rcfile', bashWrapperFile(), '-i'];
    } else {
      env.FROST_HOOKS = hooks;
      env.FROST_LAUNCH = launch;
      args = ['-NoLogo', '-NoExit', '-Command', CLAUDE_WRAPPER];
    }
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
    if (rec) rec.lastData = Date.now();
    if (win) win.webContents.send('pty:data', { id, data });
  });
  p.onExit(({ exitCode }) => {
    ptys.delete(id);
    if (win) win.webContents.send('pty:exit', { id, exitCode });
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
  if (p && cols > 0 && rows > 0) p.resize(cols, rows);
});

ipcMain.on('pty:kill', (_e, { id }) => {
  const p = ptys.get(id);
  if (p) {
    ptys.delete(id);
    p.kill();
  }
});

ipcMain.handle('theme:get', () => ({
  theme: readTheme() || DEFAULT_THEME,
  css: readCss(),
  frameless: Boolean(win && win.isFramelessMode)
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

function readSessions() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function upsertSession(entry) {
  const sessions = readSessions().filter((s) => s.cwd !== entry.cwd);
  sessions.unshift(entry);
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

function registerDetected(agentId, cwd) {
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
    win.webContents.send('agent:detected', {
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
  if (rec.hook === 'blocked' && rec.hookT > rec.lastInput) return 'blocked';
  if (rec.hook === 'done' && rec.hookT > rec.lastInput) return 'done';
  return Date.now() - rec.lastData < 2500 ? 'working' : 'idle';
}

function broadcastStatuses() {
  if (!win) return;
  for (const [id, rec] of agents) {
    const s = effectiveStatus(rec);
    if (s !== rec.status) {
      rec.status = s;
      win.webContents.send('agent:status', { agentId: id, status: s });
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
          if (win) win.webContents.send('agent:ended', { agentId, sessions: readSessions() });
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

ipcMain.handle('dialog:pickDir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

ipcMain.handle('agents:getConfig', () => readAgentsCfg());

ipcMain.handle('agents:addSpace', async () => {
  const r = await dialog.showOpenDialog(win, {
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
  const sessions = readSessions().filter((s) => s.cwd !== cwd);
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  return sessions;
});

ipcMain.on('agents:track', (_e, { agentId, ptyId }) => {
  const rec = agents.get(agentId);
  if (!rec) return;
  rec.ptyId = ptyId;
  agentByPty.set(ptyId, rec);
});

ipcMain.on('agents:selectDiff', (_e, payload) => {
  if (diffWatcher) {
    diffWatcher.close();
    diffWatcher = null;
  }
  clearTimeout(diffTimer);
  const { agentId, mode } = payload || {};
  const rec = agentId && agents.get(agentId);
  if (!rec) return;
  if (!rec.git) {
    if (win) win.webContents.send('agent:diff', { agentId, patch: '', status: '', nogit: true });
    return;
  }
  const runDiff = () => {
    // session = everything since the agent started (survives commits);
    // uncommitted = working tree vs HEAD only
    const target = mode === 'uncommitted' ? 'HEAD' : rec.baseCommit;
    const d = spawnSync('git', ['-C', rec.cwd, 'diff', target], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    });
    const s = spawnSync('git', ['-C', rec.cwd, 'status', '--porcelain'], { encoding: 'utf8' });
    if (win) {
      win.webContents.send('agent:diff', {
        agentId,
        patch: d.stdout || '',
        status: s.stdout || ''
      });
    }
  };
  runDiff();
  diffWatcher = chokidar
    .watch(rec.cwd, {
      ignored: (p) => /node_modules|[\\/]\.git([\\/]|$)/.test(p),
      ignoreInitial: true,
      depth: 8
    })
    .on('all', () => {
      clearTimeout(diffTimer);
      diffTimer = setTimeout(runDiff, 400);
    });
});

ipcMain.on('diag:report', (_e, data) => {
  try {
    fs.writeFileSync(path.join(CONFIG_DIR, 'diag.json'), JSON.stringify(data, null, 2));
  } catch {}
});

ipcMain.handle('glass:info', () => ({
  wallpaper: getWallpaperDataUrl(),
  ...glassBounds()
}));

ipcMain.on('win:minimize', () => win?.minimize());
ipcMain.on('win:maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('win:close', () => win?.close());

ipcMain.handle('theme:save', (_e, theme) => {
  fs.writeFileSync(THEME_FILE, JSON.stringify(theme, null, 2));
  return true;
});

ipcMain.on('theme:openFile', (_e, which) => {
  shell.openPath(which === 'css' ? CSS_FILE : THEME_FILE);
});

// --- app lifecycle ---

app.whenReady().then(() => {
  ensureConfig();
  initAgentInfra();
  createWindow();
  watchConfig();
});

app.on('window-all-closed', () => {
  for (const p of ptys.values()) {
    try { p.kill(); } catch {}
  }
  ptys.clear();
  app.quit();
});
