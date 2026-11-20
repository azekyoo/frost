const { app, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { UTF8_PATHS, gitRun } = require('./git');
const { peekMarks } = require('./peek');
const { resolveEditor } = require('./open');
const { startDir } = require('./profiles');

// Turns a candidate found in terminal output into an absolute path, but only if
// it actually exists as a file. Existence is the filter that keeps ordinary
// words from being underlined as links.
// A path starting with two slashes is a network share (\\host\share), and a
// stat on one sends Windows looking for that host over SMB, which can take
// seconds. Terminal text is full of them that aren't paths at all (// comments,
// the tail of a URL), and a stat held up like that is what froze the main
// thread long enough for Windows to kill Frost. So they are never looked up.
const isUnc = (p) => /^[\\/]{2}/.test(p);

// The absolute path a candidate names, or null if it can't be one. String work
// only: whether it exists is the caller's question.
function targetPath(base, candidate) {
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
  if (isUnc(target)) return null;
  const abs = path.resolve(base, target);
  return isUnc(abs) ? null : abs;
}

function resolveTarget(cwd, candidate) {
  const base = cwd && !isUnc(cwd) && fs.existsSync(cwd) ? cwd : startDir();
  const abs = targetPath(base, candidate);
  if (!abs) return null;
  try {
    return fs.statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

// Async lookups for paths:resolve, which asks about dozens of words on every
// hover: a slow disk (network drive, sleeping USB) waits off the main thread
// instead of freezing the app.
async function statAsync(abs) {
  try {
    return await fs.promises.stat(abs);
  } catch {
    return null;
  }
}

async function baseDirAsync(cwd) {
  if (cwd && !isUnc(cwd) && (await statAsync(cwd))?.isDirectory()) return cwd;
  return startDir();
}

// A bare file name ("I created logo.png") that isn't in the shell's folder is
// looked up by name across the repo the folder is in: an agent names the files
// it made without their folder as often as with it. One match is a link; two
// or more is no link, since a guess would open the wrong file.
//
// The repo's file list (git's, so gitignored output is left out) is kept per
// repo and rebuilt when a name misses — at most every few seconds, so a file
// written a moment ago is found without every miss running git again.
const NAME_INDEX_TTL = 3000;
const NAME_INDEX_MAX = 300000;
const nameIndexes = new Map(); // repo root (lowercased) -> { names, at, pending }
const repoRoots = new Map(); // folder (lowercased) -> repo root, or '' outside git

async function repoRootCached(dir) {
  const key = dir.toLowerCase();
  if (!repoRoots.has(key)) {
    const top = await gitRun(dir, ['rev-parse', '--show-toplevel']);
    repoRoots.set(key, top.ok ? path.normalize(top.stdout.trim()) : '');
  }
  return repoRoots.get(key);
}

function buildNameIndex(root) {
  const entry = nameIndexes.get(root.toLowerCase()) || { names: new Map(), at: 0, pending: null };
  nameIndexes.set(root.toLowerCase(), entry);
  if (!entry.pending) {
    entry.pending = gitRun(root, [...UTF8_PATHS, 'ls-files', '--cached', '--others', '--exclude-standard', '-z']).then((ls) => {
      const names = new Map();
      for (const rel of ls.stdout.split('\0').slice(0, NAME_INDEX_MAX)) {
        if (!rel) continue;
        const name = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase();
        const list = names.get(name);
        list ? list.push(rel) : names.set(name, [rel]);
      }
      entry.names = names;
      entry.at = Date.now();
      entry.pending = null;
      return entry;
    });
  }
  return entry.pending;
}

async function findInRepo(cwd, name) {
  if (/[\\/]/.test(name) || /[\0<>|"*?&^%`$:]/.test(name)) return null;
  const base = cwd && !isUnc(cwd) && (await statAsync(cwd))?.isDirectory() ? cwd : null;
  const root = base && (await repoRootCached(base));
  if (!root) return null;
  let entry = nameIndexes.get(root.toLowerCase());
  if (!entry || !entry.at) entry = await buildNameIndex(root);
  let hits = entry.names.get(name.toLowerCase());
  if (!hits && Date.now() - entry.at > NAME_INDEX_TTL) {
    entry = await buildNameIndex(root);
    hits = entry.names.get(name.toLowerCase());
  }
  if (!hits || hits.length !== 1) return null;
  const abs = path.join(root, hits[0]);
  // null when deleted since the list was taken
  return (await statAsync(abs))?.isFile() ? abs : null;
}

// A name a listing cut short to fit its column ("CHANGEL…"): the one file in
// the folder whose name starts that way. With several ("packag…") there is no
// guessing which: { dir } instead, for the folder to be searched for them.
async function resolveCut(dir, candidate) {
  if (!candidate.endsWith('…') || /[\0<>|"*?&^%`$\\/]/.test(candidate)) return null;
  const start = candidate.slice(0, -1).toLowerCase();
  try {
    const hits = (await fs.promises.readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isFile() && d.name.toLowerCase().startsWith(start));
    if (hits.length === 1) return path.join(dir, hits[0].name);
    return hits.length > 1 ? { dir } : null;
  } catch {
    return null;
  }
}

async function resolveFile(base, candidate) {
  const abs = targetPath(base, candidate);
  return abs && (await statAsync(abs))?.isFile() ? abs : null;
}

// A folder named in output ("assets", "src/renderer") — only where it stands,
// never searched for: a word naming some folder deep in the repo is prose.
async function resolveFolder(base, candidate) {
  const abs = targetPath(base, candidate);
  return abs && (await statAsync(abs))?.isDirectory() ? abs : null;
}

// Files under `paths`, folders under `dirs`, names cut short that several files
// start with under `cuts` (their folder), each keyed by the text asked about.
// Every disk lookup here is async: it runs on each hover, and one sync stat
// that hung is what got Frost killed as not responding.
ipcMain.handle('paths:resolve', async (_e, { cwd, candidates }) => {
  const paths = {};
  const dirs = {};
  const cuts = {};
  const list = Array.isArray(candidates) ? candidates.slice(0, 64) : [];
  const base = await baseDirAsync(cwd);
  await Promise.all(
    list.map(async (candidate) => {
      if (typeof candidate !== 'string') return;
      if (candidate.endsWith('…')) {
        const hit = await resolveCut(base, candidate);
        if (typeof hit === 'string') paths[candidate] = hit;
        else if (hit) cuts[candidate] = hit.dir;
        return;
      }
      // the repo is searched by name only for something named like a file:
      // every word of prose would otherwise send git through the repo
      const named = /\.[A-Za-z]\w{0,9}$/.test(candidate);
      const abs = (await resolveFile(base, candidate)) || (named ? await findInRepo(cwd, candidate) : null);
      if (abs) paths[candidate] = abs;
      else {
        const dir = await resolveFolder(base, candidate);
        if (dir) dirs[candidate] = dir;
      }
    })
  );
  return { paths, dirs, cuts };
});

const OS_APP_EXT = new Set([
  '.mp4', '.mov', '.mkv', '.avi', '.webm', '.wmv', '.m4v',
  '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.heic',
  '.pdf', '.docx', '.xlsx', '.pptx', '.zip', '.7z',
]);

// Explorer opened on the file's folder with the file selected
ipcMain.handle('paths:reveal', async (_e, { cwd, target }) => {
  const abs = resolveTarget(cwd, target);
  if (abs) {
    shell.showItemInFolder(abs);
    return { opened: 'explorer' };
  }
  const dir = safeDir(target);
  if (!dir) return { error: 'not found: ' + target };
  const err = await shell.openPath(dir);
  return err ? { error: err } : { opened: 'explorer' };
});

// an absolute folder path that exists, with nothing in it a command line
// could misread
function safeDir(target) {
  if (typeof target !== 'string' || target.length > 400 || /[\0<>|"*?&^%`$]/.test(target)) return null;
  if (!path.isAbsolute(target)) return null;
  try {
    return fs.statSync(target).isDirectory() ? path.resolve(target) : null;
  } catch {
    return null;
  }
}

// a whole folder in the editor: just the folder as its one argument, which
// code, cursor, subl and friends all take as "open this as a workspace"
ipcMain.handle('paths:openDir', (_e, { target }) => {
  const dir = safeDir(target);
  if (!dir) return { error: 'not found: ' + target };
  const editor = resolveEditor();
  if (!editor) {
    shell.openPath(dir);
    return { opened: 'explorer' };
  }
  try {
    const child = spawn(editor.exe, [dir], { detached: true, stdio: 'ignore', shell: false });
    child.on('error', () => shell.openPath(dir));
    child.unref();
    return { opened: path.basename(editor.exe) };
  } catch (e) {
    shell.openPath(dir);
    return { opened: 'explorer', error: String(e) };
  }
});

ipcMain.handle('paths:open', async (_e, { cwd, target, line, column }) => {
  const abs = resolveTarget(cwd, target);
  if (!abs) {
    // a folder git lists as one untracked entry: no editor opens that, Explorer
    // does. resolveTarget stays files-only, since it also decides which words
    // in terminal output become links.
    const dir = typeof target === 'string' && !/[\0<>|"*?&^%`$]/.test(target) && cwd ? path.resolve(cwd, target) : null;
    try {
      if (dir && fs.statSync(dir).isDirectory()) {
        const err = await shell.openPath(dir);
        return err ? { error: err } : { opened: 'explorer' };
      }
    } catch {}
    return { error: 'not found: ' + target };
  }
  // media and documents mean nothing in a code editor: the app Windows has
  // registered for them (a player, a viewer) is what the click is asking for
  if (OS_APP_EXT.has(path.extname(abs).toLowerCase())) {
    const err = await shell.openPath(abs);
    return err ? { error: err } : { opened: 'shell' };
  }
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

// What the peek viewer shows. Only text it can draw comes back; anything else
// (a video, a binary, a file too big to scroll through) answers with why not,
// and the renderer falls back to paths:open, which knows where those go.
const PEEK_MAX = 2 * 1024 * 1024;

ipcMain.handle('paths:read', async (_e, { cwd, target }) => {
  const abs = resolveTarget(cwd, target);
  if (!abs) return { error: 'not found: ' + target };
  if (OS_APP_EXT.has(path.extname(abs).toLowerCase())) return { skip: 'media' };
  try {
    const { size } = await fs.promises.stat(abs);
    if (size > PEEK_MAX) return { skip: 'large' };
    const buf = await fs.promises.readFile(abs);
    // the same test git uses: a NUL in the first 8000 bytes means binary
    if (buf.subarray(0, 8000).includes(0)) return { skip: 'binary' };
    return { path: abs, text: buf.toString('utf8'), marks: await peekMarks(abs) };
  } catch (e) {
    return { error: String(e.message || e) };
  }
});

Object.assign(module.exports, {
  isUnc,
  targetPath,
  resolveTarget,
  statAsync,
  baseDirAsync,
  NAME_INDEX_TTL,
  NAME_INDEX_MAX,
  nameIndexes,
  repoRoots,
  repoRootCached,
  buildNameIndex,
  findInRepo,
  resolveCut,
  resolveFile,
  resolveFolder,
  OS_APP_EXT,
  safeDir,
  PEEK_MAX
});
