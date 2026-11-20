const { app, ipcMain } = require('electron');
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const stalls = require('../../stalls');

const { DEFAULT_THEME, readAgentsCfg, readTheme } = require('../config');
const { UTF8_PATHS, canonPath, commitAt, gitInfo, gitRun, nearestDir, repoRootOf, within } = require('../git');
const { agentByPty, agents } = require('./state');
const { broadcast, liveWindows } = require('../windows/registry');
const { notify, notifySettings } = require('../notify');
const { refreshAgentTitles, scanTranscripts, transcriptPaths } = require('./sessions');
const { late } = require('../../late');
const { diffSelection, diffSoon, selectDiff } = late(require('./diff'), ['diffSelection', 'diffSoon', 'selectDiff']);
const { primaryWindow } = require('../windows/registry');
const { resetTitleScan } = require('./sessions');

let agentCounter = 0;
let STATUS_DIR = null;
const statusDir = () => STATUS_DIR;

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
    // starting from a copy of the real index keeps its stat cache: only
    // changed files get re-hashed
    try {
      await fs.promises.copyFile(real.stdout.trim(), tmp);
    } catch {
      // without the real index to start from, the snapshot would be empty and
      // every file would read as added; HEAD is the honest fallback
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
  const rec = {
    ptyId,
    cwd,
    // HEAD until the snapshot lands: it takes several gits, half a second and
    // more, and this runs on the process every terminal's input and output
    // passes through. The diff waits for it on `ready`, as for an extra repo.
    baseCommit: info.baseCommit,
    untrackedAtStart: null,
    ready: null,
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
  if (info.git) {
    rec.ready = snapshotBaseAsync(cwd, info.baseCommit).then((snap) => {
      rec.baseCommit = snap.base;
      rec.untrackedAtStart = snap.untracked;
      rec.ready = null;
      const diffSel = diffSelection();
      if (diffSel?.agentId === agentId && agents.get(agentId) === rec) selectDiff(agentId, diffSel.mode);
    });
  }
  const name = path.basename(cwd);
  const win = primaryWindow();
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
// What Claude should know about the terminal it is printing into. Ctrl+click
// turns a path into a Peek, but only one that reaches the screen intact:
// markdown eats a backslash before punctuation outside backticks, and a colon
// glued to the end makes a name no file has. Kept short, every session pays
// for it.
const FROST_CONTEXT =
  'This terminal is Frost. The user can Ctrl+click a file path in your output to open it in ' +
  "Frost's viewer. For that to work, write every file path you show as a full absolute path " +
  'inside backticks, followed by a space or the end of the line, never by a colon or other ' +
  'punctuation glued to it. Outside backticks, markdown drops a backslash before punctuation ' +
  '(\\.claude shows as .claude), and a glued character makes a name no file has.\n';

// SessionStart prints are read by Claude as context. Read from a file rather
// than inlined, so the text needs no escaping for the shell running the hook.
function contextHook() {
  const file = path.join(STATUS_DIR, 'frost-context.txt');
  if (!fs.existsSync(file)) fs.writeFileSync(file, FROST_CONTEXT);
  const fwd = file.replace(/\\/g, '/');
  return `node -e "process.stdout.write(require('fs').readFileSync('${fwd}','utf8'))"`;
}

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
  const diffSel = diffSelection();
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
        const diffSel = diffSelection();
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
      // Also tells Claude how to print paths so they stay clickable here.
      SessionStart: [
        {
          hooks: [
            { type: 'command', command: sessionIdHook(agentId) },
            { type: 'command', command: contextHook() }
          ]
        }
      ],
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
    .on('all', stalls.timed('agent status file', (_ev, file) => {
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
        resetTitleScan();
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
    }));
  // each step labelled, so a freeze in the tick names the one that held it
  const statuses = stalls.timed('statuses', broadcastStatuses);
  const titles = stalls.timed('titles', refreshAgentTitles);
  const edits = stalls.timed('transcript edits', scanTranscriptEdits);
  setInterval(stalls.timed('status tick', () => {
    statuses();
    titles();
    const diffSel = diffSelection();
    if (diffSel) edits(diffSel.agentId);
  }), 1500);
}

ipcMain.handle('agents:getConfig', () => readAgentsCfg());

ipcMain.handle('agents:spawn', async (_e, { spacePath }) => {
  const cwd = canonPath(spacePath);
  if (!cwd || !fs.existsSync(cwd)) return { error: 'That folder no longer exists: ' + spacePath };
  // any folder will do; outside git there is just no branch and no diff
  const info = gitInfo(cwd);
  const branch = info.branch || '(no git)';

  // with auto-detect on, the session wrapper handles hooks + registration, and
  // takes its own snapshot when claude starts: none is needed here
  const autoDetect = (readTheme() || DEFAULT_THEME).autoDetectAgents !== false;
  if (autoDetect) {
    return { agentId: null, cwd, branch, git: info.git, run: 'claude' };
  }
  // otherwise pre-register the agent and pass the settings file explicitly.
  // Waited on, not blocked on: several gits, and every terminal's input and
  // output passes through this process.
  const snap = info.git ? await snapshotBaseAsync(cwd, info.baseCommit) : { base: null, untracked: new Set() };
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

Object.assign(module.exports, {
  statusDir,
  snapshotBaseAsync,
  registerDetected,
  agentEnded,
  effectiveStatus,
  broadcastStatuses,
  sessionIdHook,
  FROST_CONTEXT,
  contextHook,
  blockedHook,
  bashPaths,
  TOUCH_HOOK_SRC,
  touchHook,
  addExtraRepo,
  extraRepoFor,
  EDIT_TOOLS,
  earlyEdit,
  addRel,
  namedFiles,
  scanTranscriptEdits,
  touchRead,
  touchedPaths,
  readSessionId,
  hookSettingsFile,
  initAgentInfra
});
