const { ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const stalls = require('../../stalls');

const { SHOT } = require('../../env');
const { agentByPty, agents } = require('./state');
const { broadcast } = require('../windows/registry');
const { canCheckProc, processStartTimes } = require('../../platform');
const { canonPath } = require('../git');

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
function sessionInfoRaw(file, st, maxAge = 0) {
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
const sessionInfo = stalls.timed('read transcript', sessionInfoRaw);

function scanTranscriptsRaw() {
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
const scanTranscripts = stalls.timed('scan transcripts', scanTranscriptsRaw);

// Claude Code registers every running process in ~/.claude/sessions/<pid>.json
// — session id, cwd, and the name /rename gave it. It is not a documented
// format, so anything unexpected just means "nothing known to be running".
// A file whose process is gone is left over from a crash, and doesn't count.
//
// Nor does one whose pid is alive but belongs to someone else now: a file left
// behind by a shutdown outlives its claude, and after a reboot Windows hands
// the same pid to svchost or whatever starts first. Claude Code writes the
// process's creation time beside the pid (`procStart`, a FILETIME), so the
// owner of that pid now has to have started at that same instant.
function readClaudeRegistry() {
  const out = [];
  const dir = path.join(CLAUDE_DIR, 'sessions');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (!s.sessionId || !Number.isInteger(s.pid) || s.pid <= 0) continue;
      try {
        process.kill(s.pid, 0); // signal 0 only asks whether it exists
      } catch (e) {
        if (e.code === 'ESRCH') continue;
      }
      out.push(s);
    } catch {}
  }
  return out;
}

// "pid:procStart" -> { ours, at }: whether the process now holding that pid is
// the one that wrote the file. A no is final — that claude is gone for good —
// while a yes is asked again after a while, in case it has since died and its
// pid been reused.
const procChecks = new Map();
const PROC_RECHECK_MS = 60000;
const procKey = (s) => `${s.pid}:${s.procStart}`;

let procCheckRun = null;
async function checkClaudeProcessesNow() {
  const now = Date.now();
  const due = readClaudeRegistry().filter((s) => {
    if (!canCheckProc(s)) return false;
    const c = procChecks.get(procKey(s));
    return !c || (c.ours && now - c.at > PROC_RECHECK_MS);
  });
  if (!due.length) return;
  const starts = await processStartTimes([...new Set(due.map((s) => s.pid))]);
  for (const s of due) {
    // a failed lookup proves nothing: trust the pid as before, ask later
    const ours = starts ? starts.get(s.pid) === s.procStart : true;
    procChecks.set(procKey(s), { ours, at: Date.now() });
  }
}

// Settles every registry file not looked at yet before resolving, so whatever
// asks next sees the truth; ones only due for a recheck are redone in the
// background, without holding the caller up.
function checkClaudeProcesses() {
  const unknown = readClaudeRegistry().some((s) => canCheckProc(s) && !procChecks.has(procKey(s)));
  if (!procCheckRun) {
    procCheckRun = checkClaudeProcessesNow().finally(() => {
      procCheckRun = null;
    });
  }
  return unknown ? procCheckRun : Promise.resolve();
}

function runningClaudeSessionsRaw() {
  const running = new Map(); // session id -> { pid, name, custom }
  for (const s of readClaudeRegistry()) {
    // not looked at yet counts as running, as it did before the check existed
    if (canCheckProc(s) && procChecks.get(procKey(s))?.ours === false) continue;
    running.set(s.sessionId, { pid: s.pid, name: s.name || null, custom: s.nameSource === 'user' });
  }
  return running;
}
const runningClaudeSessions = stalls.timed('running sessions', runningClaudeSessionsRaw);

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

ipcMain.handle('claude:sessions', async (_e, exclude) => {
  await checkClaudeProcesses();
  return listClaudeSessions(exclude);
});

// Removes a session from disk: its transcript, and the folder beside it that
// holds its subagents and /rename name. To the Recycle Bin, so a wrong click
// can still be undone. Refused while a claude has it open, which would just
// write the transcript back.
ipcMain.handle('claude:delete-session', async (_e, id) => {
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) return { error: 'Not a session id' };
  if (!transcriptPaths.has(id)) scanTranscripts();
  const file = transcriptPaths.get(id);
  if (!file) return { error: 'Session not found' };
  await checkClaudeProcesses();
  if (runningClaudeSessions().has(id)) return { error: 'This session is open somewhere — end it first' };
  try {
    await shell.trashItem(file);
  } catch (e) {
    return { error: `Couldn't delete the session: ${e.message}` };
  }
  const side = file.slice(0, -6);
  if (fs.existsSync(side)) await shell.trashItem(side).catch(() => {});
  transcriptPaths.delete(id);
  sessionCache.delete(file);
  return { ok: true };
});

// Every folder claude has run in, newest first, for New session to offer. It
// reaches past the sessions list's cut-off, but only reads the top of each
// transcript — the cwd is on its first lines — and never again for the same
// file, since where a session ran doesn't change.
const FOLDER_LIMIT = 30;
const transcriptCwds = new Map(); // file -> cwd, or null for one that never started

// Read off the main process's back: opening a transcript is where the time
// goes, the first time after a start especially, with a cold disk cache and the
// virus scanner looking at every file opened, and every terminal's input and
// output waits behind this process while it reads.
async function transcriptCwd(file, size) {
  if (transcriptCwds.has(file)) return transcriptCwds.get(file);
  let cwd = null;
  let fh = null;
  try {
    fh = await fs.promises.open(file, 'r');
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, 0);
    // the cwd is on one of the first lines: stop parsing there
    for (const line of buf.toString('utf8', 0, bytesRead).split('\n')) {
      if (!line.startsWith('{') || !line.includes('"cwd"')) continue;
      try {
        const l = JSON.parse(line);
        if (l.cwd) {
          cwd = canonPath(l.cwd);
          break;
        }
      } catch {} // the cut at the end of the slice
    }
  } catch {
  } finally {
    await fh?.close().catch(() => {});
  }
  // an empty one may simply not have been written to yet; ask again next time
  if (cwd || size > 0) transcriptCwds.set(file, cwd);
  return cwd;
}

// Claude Code names each project folder after the directory its sessions ran
// in, so every transcript in one folder gives the same answer: only the newest
// of each is opened, rather than all of them. With fewer folders than the limit
// that used to be every transcript on disk, hundreds of files, and a freeze of
// seconds the first time New session was opened after a start.
async function recentClaudeFolders() {
  const files = scanTranscripts().sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const doneDirs = new Set();
  const seen = new Set();
  const out = [];
  for (const f of files) {
    if (out.length >= FOLDER_LIMIT) break;
    const dir = path.dirname(f.file);
    if (doneDirs.has(dir)) continue;
    const cwd = await transcriptCwd(f.file, f.st.size);
    // a session that never started says nothing: the next one in its folder may
    if (!cwd) continue;
    doneDirs.add(dir);
    const key = cwd.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (await fs.promises.access(cwd).then(() => true, () => false)) out.push(cwd);
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
const resetTitleScan = () => {
  lastTitleScan = 0;
};
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

Object.assign(module.exports, {
  resetTitleScan,
  CLAUDE_DIR,
  CLAUDE_PROJECTS,
  SESSION_LIMIT,
  sessionCache,
  transcriptPaths,
  readSlice,
  jsonLines,
  readClaudeSession,
  sessionInfoRaw,
  sessionInfo,
  scanTranscriptsRaw,
  scanTranscripts,
  readClaudeRegistry,
  procChecks,
  PROC_RECHECK_MS,
  procKey,
  checkClaudeProcessesNow,
  checkClaudeProcesses,
  runningClaudeSessionsRaw,
  runningClaudeSessions,
  listClaudeSessions,
  FOLDER_LIMIT,
  transcriptCwds,
  transcriptCwd,
  recentClaudeFolders,
  sessionTitle,
  refreshAgentTitles
});
