const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile, spawnSync } = require('child_process');
const stalls = require('../stalls');

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

// Shells disagree on how to spell a directory: PowerShell reports
// C:\dev\repo, the bash wrapper's `pwd -W` reports C:/dev/repo. Same place, and
// comparing them as strings meant one repo could appear twice — once live, once
// as a resumable session.
function canonPath(p) {
  if (!p) return p;
  return path.resolve(String(p).trim()).replace(/[\\/]+$/, '');
}

// One git for both answers: starting git costs ~80ms on Windows, and this runs
// on the process every terminal's input and output passes through. The
// --abbrev-ref applies to the HEAD after it only, so the commit comes first.
function gitInfoRaw(cwd) {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (r.status !== 0) return { git: false, branch: null, baseCommit: null };
  const [hash, branch] = (r.stdout || '').split(/\r?\n/).map((s) => s.trim());
  return {
    git: true,
    branch: branch || 'HEAD',
    baseCommit: hash || 'HEAD'
  };
}
const gitInfo = stalls.timed('git info', gitInfoRaw);

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

// Taken without holding up the process: every terminal's input and output
// passes through here, and the snapshot is several gits.
function gitRun(cwd, args, env) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      resolve({ ok: !err, stdout: stdout || '' })
    );
  });
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
function repoRootOfRaw(p) {
  const dir = nearestDir(p);
  if (!dir) return null;
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 && r.stdout.trim() ? canonPath(r.stdout.trim()) : null;
}
const repoRootOf = stalls.timed('git root', repoRootOfRaw);

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

Object.assign(module.exports, {
  branchCache,
  findGitDir,
  branchFor,
  canonPath,
  gitInfoRaw,
  gitInfo,
  UTF8_PATHS,
  unquotePath,
  gitRun,
  nearestDir,
  repoRootOfRaw,
  repoRootOf,
  within,
  commitAt
});
