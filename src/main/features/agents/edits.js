// Which files an agent has edited, and in which repos — read from its
// transcript's tool calls and from the touch hook — so the diff panel can show
// that agent's work rather than everything that changed in the folder.
const fs = require('fs');
const path = require('path');

const { STATUS_DIR } = require('../../env');
const { canonPath, commitAt, gitInfo, nearestDir, repoRootOf, within } = require('../git');
const { agents } = require('./state');
const { scanTranscripts, transcriptPaths } = require('./sessions');
const { bashPaths } = require('./hooks');
const { late } = require('../../late');
const { diffSelection, diffSoon, selectDiff } = late(require('./diff'), ['diffSelection', 'diffSoon', 'selectDiff']);
const { snapshotBaseAsync } = late(require('./agents'), ['snapshotBaseAsync']);

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

Object.assign(module.exports, {
  addExtraRepo,
  extraRepoFor,
  EDIT_TOOLS,
  earlyEdit,
  addRel,
  namedFiles,
  scanTranscriptEdits,
  touchRead,
  touchedPaths
});
