const { ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('@lydell/node-pty');
const stalls = require('../../stalls');

const { DEFAULT_THEME, readTheme } = require('../config');
const { PS_SPARE_HISTORY, bashRc, psStartup, whichExe } = require('../../platform');
// macOS only: Windows exports no zshFiles, and a 'zsh' profile there falls back to 'none'
const { zshFiles } = require('../../platform');
const { agentByPty, agents } = require('../agents/state');
const { agentEnded } = require('../agents/agents');
const { hookSettingsFile } = require('../agents/hooks');
const { detachedPtys, ptyMeta, ptyOwners, ptys, sendToOwner } = require('./registry');
const { findProfile, shellCwd } = require('../profiles');
const { late } = require('../../late');
const { claimSpare, noteTyped, spareFilter, spareGone, spareWatch } = late(require('./spares'), ['claimSpare', 'noteTyped', 'spareFilter', 'spareGone', 'spareWatch']);
const { STATUS_DIR } = require('../../env');
const { runsClaude } = require('../../core/agents');

let ptyCounter = 0;

// Every shell started that hasn't reported its exit yet — including those whose
// tab is already closed and who are still winding down (a claude saving its
// session), which `ptys` has forgotten. See endAllPtys.
const unexited = new Set();

// zsh reads its startup files from ZDOTDIR: a folder of Frost's own, whose
// files load the user's and then add the hooks (platform/darwin).
function zshDotDir(withClaude) {
  const dir = path.join(STATUS_DIR, withClaude ? 'frost-zsh-agent' : 'frost-zsh');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(zshFiles(withClaude))) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

function bashRcFile(withClaude) {
  const f = path.join(STATUS_DIR, withClaude ? 'frost-bashrc-agent' : 'frost-bashrc');
  fs.writeFileSync(f, bashRc(withClaude));
  return f;
}

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
// Bash draws the marker from PROMPT_COMMAND, just before readline takes the
// terminal, and Git Bash's readline throws away input that arrived before it
// did: the command is typed a moment after the marker instead.
const RUN_AFTER_PROMPT_MS = 150;

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
  if (!runsClaude(ta.run)) return releaseTypeAhead(id);
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
  if (ta.stage === 'shell' && data.includes('\x1b]133;A')) {
    clearTimeout(ta.timer);
    ta.timer = setTimeout(() => typeRun(id), RUN_AFTER_PROMPT_MS);
  }
  else if (ta.stage === 'claude' && data.includes('\x1b[?1004h')) releaseTypeAhead(id);
}

// owner is the window the output belongs to. It can be null, for a shell that
// exists before any pane does — nothing does that today, and the buffering
// below is what a tab in flight between windows relies on.
function spawnShell({ cols, rows, cwd, run, profileId, owner, spare }) {
  const id = String(++ptyCounter);
  if (owner) ptyOwners.set(id, owner);
  // No owner yet: whatever the shell prints in the meantime is held, by the
  // same buffer a tab in flight between windows uses, and replayed on claim.
  else detachedPtys.set(id, { chunks: [], bytes: 0 });
  const profile = findProfile(profileId);
  const autoDetect = (readTheme() || DEFAULT_THEME).autoDetectAgents !== false;
  // agentWrapper names the shell dialect: it decides both how the `claude`
  // wrapper is written and how the cwd hook is installed. 'none' = neither.
  const dialect = profile.agentWrapper === 'zsh' && !zshFiles ? 'none' : profile.agentWrapper || 'none';
  const withClaude = autoDetect && dialect !== 'none';
  let args = Array.isArray(profile.args) ? [...profile.args] : [];
  // ConPTY passes no TERM of its own, and node-pty's `name` is a no-op on
  // Windows, so a program launched here sees no hint that the terminal can do
  // more than sixteen colours and downgrades its palette: Claude Code's status
  // bar loses its gradients. Frost knows what it renders, so it says so. Set
  // before profile.env, which is the user's to override.
  const inherited = { ...process.env };
  // macOS: started from Terminal.app, Frost would pass on Terminal's identity,
  // and the system's zshrc/bashrc would then keep Terminal's per-window history
  // files for it. Frost says who it is instead.
  if (process.platform === 'darwin') {
    delete inherited.TERM_SESSION_ID;
    delete inherited.TERM_PROGRAM_VERSION;
    inherited.TERM_PROGRAM = 'Frost';
  }
  let env = { ...inherited, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...(profile.env || {}) };
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
    if (dialect === 'zsh') {
      // the profile's own args stay (-l): zsh is told where to start through
      // ZDOTDIR, and where the user's files are through FROST_USER_ZDOTDIR
      env.FROST_USER_ZDOTDIR = env.ZDOTDIR || os.homedir();
      env.ZDOTDIR = zshDotDir(withClaude);
    } else {
      args =
        dialect === 'bash'
          ? ['--rcfile', bashRcFile(withClaude), '-i']
          : ['-NoLogo', '-NoExit', '-Command', psStartup(withClaude) + (spare ? '; ' + PS_SPARE_HISTORY : '')];
    }
  }
  const startCwd = shellCwd(profile, cwd);
  // Detected WSL profiles start in the Linux home (`--cd ~`), which threw away
  // the folder a tab was asked for: `frost <dir>`, "Open Frost here", --run.
  // wsl.exe takes an absolute Windows path for --cd. Only an explicit folder
  // replaces it, and only the stock `~`: a plain new tab still opens at home,
  // and a --cd the user wrote into the profile is theirs.
  if (cwd && startCwd === cwd && /^wsl(\.exe)?$/i.test(path.basename(profile.shell || ''))) {
    const i = args.indexOf('--cd');
    if (i !== -1 && args[i + 1] === '~') args[i + 1] = cwd;
  }
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
  unexited.add(p);
  p.onExit(() => unexited.delete(p));
  ptyMeta.set(id, { profileId: profile.id, profileName: profile.name });
  p.onData(stalls.timed('pty data', (data) => {
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
    spareWatch(id, data);
    const shown = spareFilter(id, data);
    if (shown) sendToOwner(id, 'pty:data', { id, data: shown });
  }));
  p.onExit(stalls.timed('pty exit', ({ exitCode }) => {
    clearTimeout(typeAhead.get(id)?.timer);
    typeAhead.delete(id);
    spareGone(id);
    ptys.delete(id);
    sendToOwner(id, 'pty:exit', { id, exitCode });
    ptyOwners.delete(id);
    ptyMeta.delete(id);
  }));
  // both dialects draw the 133;A prompt marker, with or without the wrapper
  if (run) holdForRun(id, run, dialect !== 'none');
  return { id, profileId: profile.id, profileName: profile.name };
}

ipcMain.handle('pty:create', (event, opts) => claimSpare(event.sender, opts) || spawnShell({ ...opts, owner: event.sender }));

ipcMain.on('pty:input', (_e, { id, data }) => {
  noteTyped();
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

// macOS: node-pty reports a shell's exit by calling back into JavaScript, and
// one that lands while Node is shutting down aborts the app ("Frost quit
// unexpectedly" on every quit). So before quitting, every shell still going is
// ended and its exit waited for; one that won't go within `ms` is killed
// outright, which it can't outlast. Resolves once none is left, or soon after.
function endAllPtys(ms = 1500) {
  const left = [...unexited];
  if (!left.length) return Promise.resolve();
  const gone = Promise.all(left.map((p) => new Promise((resolve) => p.onExit(() => resolve()))));
  for (const p of left) {
    try {
      p.kill();
    } catch {}
  }
  const wait = (t) => new Promise((resolve) => setTimeout(resolve, t));
  return Promise.race([
    gone,
    wait(ms).then(() => {
      for (const p of unexited) {
        try {
          process.kill(p.pid, 'SIGKILL');
        } catch {}
      }
      return Promise.race([gone, wait(500)]);
    })
  ]);
}

Object.assign(module.exports, {
  bashRcFile,
  endAllPtys,
  zshDotDir,
  typeAhead,
  RUN_UNMARKED_MS,
  RUN_MARKED_CAP_MS,
  HOLD_CAP_MS,
  RUN_AFTER_PROMPT_MS,
  holdForRun,
  typeRun,
  releaseTypeAhead,
  watchTypeAhead,
  spawnShell
});
