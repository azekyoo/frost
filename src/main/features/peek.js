const { ipcMain } = require('electron');
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');

const { UTF8_PATHS, gitRun } = require('./git');

// The file's uncommitted changes, as an editor's gutter shows them: measured
// against the last commit, not an agent's session snapshot, since the viewer is
// opened from any pane and the commit is the one baseline every file has.
// { added: [[from, to]...], deleted: [{ after, count }...] }, or null outside a
// repo. A changed line counts as added: what is on screen is the new text.
async function peekMarks(abs) {
  const dir = path.dirname(abs);
  const name = path.basename(abs);
  // side by side: each is a git start-up on Windows, and a click waits on both
  const [st, diff] = await Promise.all([
    gitRun(dir, [...UTF8_PATHS, 'status', '--porcelain', '--', name]),
    gitRun(dir, [...UTF8_PATHS, 'diff', '--no-color', '--no-ext-diff', '-U0', 'HEAD', '--', name])
  ]);
  if (!st.ok) return null;
  if (st.stdout.startsWith('??')) return { added: [[1, Number.MAX_SAFE_INTEGER]], deleted: [] };
  if (!diff.ok) return null;
  const marks = { added: [], deleted: [] };
  for (const m of diff.stdout.matchAll(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldCount = m[1] === undefined ? 1 : +m[1];
    const start = +m[2];
    const newCount = m[3] === undefined ? 1 : +m[3];
    if (newCount) marks.added.push([start, start + newCount - 1]);
    // with nothing added in its place, +start is the line the gap follows
    else if (oldCount) marks.deleted.push({ after: start, count: oldCount });
  }
  return marks;
}

// The viewer's file tree. In a repo: every file git would show you — tracked,
// plus untracked ones that are not ignored, so node_modules and build output
// stay out — with what has changed in each since the last commit. Outside one,
// a plain walk that skips the usual heavy folders.
const TREE_MAX = 50000;
const TREE_SKIP = new Set(['node_modules', '.git', '__pycache__', '.venv']);

// One folder's entries, paths relative to root. Links are left out: a junction
// like AppData's "Application Data" points back up and would loop.
async function listDir(root, rel) {
  const files = [];
  const dirs = [];
  let entries = [];
  try {
    entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {}
  for (const e of entries) {
    const child = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (!TREE_SKIP.has(e.name)) dirs.push(child);
    } else if (e.isFile()) files.push(child);
  }
  return { files, dirs };
}

// Everything under root, for the search box of a folder outside git. Run in
// the background after the viewer is up: a home folder takes seconds.
async function walkTree(root) {
  const files = [];
  const dirs = [];
  const queue = [''];
  while (queue.length && files.length < TREE_MAX) {
    const level = await listDir(root, queue.shift());
    files.push(...level.files);
    dirs.push(...level.dirs);
    queue.push(...level.dirs);
  }
  return { files, dirs };
}

// a folder path from the renderer, kept inside the root it names
function treeRel(root, rel) {
  if (typeof root !== 'string' || typeof rel !== 'string' || !path.isAbsolute(root)) return null;
  const abs = path.resolve(root, rel);
  const back = path.relative(root, abs);
  return back.startsWith('..') || path.isAbsolute(back) ? null : back.replace(/\\/g, '/');
}

ipcMain.handle('peek:dir', (_e, { root, rel }) => {
  const safe = treeRel(root, rel);
  return safe === null ? { files: [], dirs: [] } : listDir(root, safe);
});

ipcMain.handle('peek:index', (_e, { root }) => (treeRel(root, '') === null ? null : walkTree(root)));

// porcelain XY -> one letter, as editors badge files: U new, A staged new,
// D deleted, M anything else changed
function treeStatus(stdout) {
  const status = {};
  const parts = stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    // a rename or copy is followed by the path it came from
    if (xy[0] === 'R' || xy[0] === 'C') i++;
    status[entry.slice(3)] =
      xy === '??' ? 'U' : xy.includes('D') ? 'D' : xy[0] === 'A' ? 'A' : 'M';
  }
  return status;
}

ipcMain.handle('peek:tree', async (_e, { dir }) => {
  if (typeof dir !== 'string' || !dir) return { error: 'no folder' };
  let start = path.resolve(dir);
  try {
    if (!fs.statSync(start).isDirectory()) start = path.dirname(start);
  } catch {
    return { error: 'not found: ' + dir };
  }
  const top = await gitRun(start, ['rev-parse', '--show-toplevel']);
  // outside git, one level now and the rest as folders are opened: listing a
  // whole home folder up front held the viewer for a second or more
  if (!top.ok || !top.stdout.trim()) return { root: start, git: false, lazy: true, ...(await listDir(start, '')), status: {} };
  const root = path.normalize(top.stdout.trim());
  const [ls, st] = await Promise.all([
    gitRun(root, [...UTF8_PATHS, 'ls-files', '--cached', '--others', '--exclude-standard', '-z']),
    gitRun(root, [...UTF8_PATHS, 'status', '--porcelain', '-z', '--untracked-files=all'])
  ]);
  const status = treeStatus(st.stdout);
  // a staged deletion has left the index, but it is still a change to show
  const files = new Set(ls.stdout.split('\0').filter(Boolean));
  for (const [p, s] of Object.entries(status)) if (s === 'D') files.add(p);
  return { root, git: true, files: [...files].slice(0, TREE_MAX), status };
});

// Live refresh: the file open in a window's viewer is watched, so an agent
// writing to it shows up as it happens. One file per window, dropped when the
// viewer closes or the window goes.
const peekWatchers = new Map(); // webContents id -> { file, watcher, timer }
const peekHooked = new Set(); // webContents ids already told to unwatch on close

function peekUnwatch(id) {
  const w = peekWatchers.get(id);
  if (!w) return;
  clearTimeout(w.timer);
  w.watcher.close().catch(() => {});
  peekWatchers.delete(id);
}

ipcMain.on('peek:watch', (event, file) => {
  const contents = event.sender;
  const id = contents.id;
  if (peekWatchers.get(id)?.file === file) return;
  peekUnwatch(id);
  if (typeof file !== 'string' || !file || !path.isAbsolute(file)) return;
  const rec = { file, timer: null };
  // an agent's write can land as several events in a row; one refresh covers them
  rec.watcher = chokidar.watch(file, { ignoreInitial: true }).on('all', () => {
    clearTimeout(rec.timer);
    rec.timer = setTimeout(() => {
      if (!contents.isDestroyed()) contents.send('peek:changed', file);
    }, 150);
  });
  peekWatchers.set(id, rec);
  if (!peekHooked.has(id)) {
    peekHooked.add(id);
    contents.once('destroyed', () => {
      peekUnwatch(id);
      peekHooked.delete(id);
    });
  }
});

Object.assign(module.exports, {
  peekMarks,
  TREE_MAX,
  TREE_SKIP,
  listDir,
  walkTree,
  treeRel,
  treeStatus,
  peekWatchers,
  peekHooked,
  peekUnwatch
});
