const { ipcMain } = require('electron');
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const stalls = require('../../stalls');

const { DEFAULT_THEME, readAgentsCfg, readTheme } = require('../config');
const { UTF8_PATHS, canonPath, gitInfo, gitRun } = require('../git');
const { STATUS_DIR } = require('../../env');
const { agentByPty, agents } = require('./state');
const { broadcast, liveWindows } = require('../windows/registry');
const { notify, notifySettings } = require('../notify');
const { refreshAgentTitles } = require('./sessions');
const { late } = require('../../late');
const { diffSelection, diffSoon, selectDiff } = late(require('./diff'), ['diffSelection', 'diffSoon', 'selectDiff']);
const { primaryWindow } = require('../windows/registry');
const { resetTitleScan } = require('./sessions');
const { effectiveStatus } = require('../../core/agents');
const { readSessionId, hookSettingsFile } = require('./hooks');
const { scanTranscriptEdits, touchedPaths } = require('./edits');

let agentCounter = 0;

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

function initAgentInfra() {
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
  snapshotBaseAsync,
  registerDetected,
  agentEnded,
  broadcastStatuses,
  initAgentInfra
});
