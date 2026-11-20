const { ipcMain } = require('electron');
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const stalls = require('../../stalls');

const { CONFIG_DIR } = require('../../env');
const { UTF8_PATHS, repoRootOf, unquotePath } = require('../git');
const { agents } = require('./state');
const { broadcast } = require('../windows/registry');
const { late } = require('../../late');
const { scanTranscriptEdits } = late(require('./agents'), ['scanTranscriptEdits']);

let diffTimer = null;

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
const diffSelection = () => diffSel;
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
  diffTimer = setTimeout(stalls.timed('diff', runDiff), 400);
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
      diffTimer = setTimeout(stalls.timed('diff', runDiff), 400);
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
  // its snapshot still being taken: left out, and this runs again when it lands
  if (rec.git && !rec.ready) {
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
    // a repo whose snapshot is on its way is not "no git": say nothing yet
    if (rec.ready) return;
    broadcast('agent:diff', { key: 'agent:' + agentId, patch: '', status: '', nogit: true, extra: [] });
    return;
  }
  watchDiff({ key: 'agent:' + agentId, mode, repos });
}

ipcMain.on('agents:selectDiff', (_e, payload) => {
  const { agentId, mode } = payload || {};
  selectDiff(agentId, mode);
});

Object.assign(module.exports, {
  diffSelection,
  NOISY_DIRS,
  NOISY_RE,
  inConfigDir,
  isNoisyPath,
  gitOut,
  diffWatchers,
  UNTRACKED_CARDS,
  UNTRACKED_FILE_MAX,
  UNTRACKED_STAT_MAX,
  untrackedText,
  diffRoots,
  splitUntracked,
  newFilePatch,
  recRoot,
  sharedFiles,
  runDiff,
  diffSoon,
  watchDiff,
  startDiffWatcher,
  selectDiff
});
