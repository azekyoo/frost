// The peek viewer: a file named in terminal output, shown over the pane it was
// clicked in, so looking at code doesn't mean leaving Frost for an editor. The
// repo it belongs to is listed beside it, so the next file is one click away.

// ---------- peek viewer ----------

// Past this, plain text: highlighting a file this size stalls the UI for longer
// than the look it was opened for.
const PEEK_HIGHLIGHT_MAX = 300 * 1024;
// top padding of the code, in px; the line band is positioned against it
const PEEK_PAD = 12;
// the terminal palette the highlighting is drawn in, so code reads in the
// same colours as everything else on screen
const PEEK_ANSI = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'brightBlack', 'brightYellow'];
const PEEK_MD = /\.(md|markdown|mdx)$/i;
const PEEK_STATUS = { M: 'Modified', U: 'Untracked', A: 'Added', D: 'Deleted' };

const peek = {
  root: null, // the overlay element, built on first use
  opts: null, // what was asked for: { cwd, target, line }
  file: null, // absolute path on screen, or null before one is picked
  text: '',
  marks: null,
  mode: 'source', // markdown only: 'preview' | 'source'
  tree: null, // { root, git, files, status, top }
  openDirs: new Map(), // tree root (lowercased) -> Set of expanded folder paths
  // per tab or session (see homeKey), per tree root (lowercased): the file
  // last shown there
  lastFile: new Map(),
  // The folder Peek was opened for (the session's, the shell's), and whose it
  // is: a normal tab's, or an agent session's. Each remembers the folder it
  // browsed to with Folder…, so reopening goes back there; a button leads home.
  home: null,
  homeKey: null,
  browsedFrom: new Map(), // tab, or 'session:<id>' -> folder browsed to
  returnTo: null
};

const peekDirname = (p) => p.replace(/[\\/][^\\/]*$/, '');
const peekNorm = (p) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const peekInside = (abs, root) => peekNorm(abs).startsWith(peekNorm(root) + '\\');

// Media, binaries and very large files can't be shown here; paths:open already
// knows where those go (their Windows app, or the editor).
function openOutside(opts) {
  api.openPath(opts).then((res) => {
    if (res?.error && !res.opened) toast(res.error, { error: true });
  });
}

// `home` only from a terminal: there it is the shell's folder. A file picked in
// Peek's own tree keeps the home it had.
async function peekPath(opts, home) {
  const res = await api.readPath(opts);
  if (home !== undefined && typeof res?.text === 'string') {
    peek.home = home || null;
    peek.homeKey = peekKeyFor(state.activeTab);
  }
  // not something to show here (media, binary, a folder git lists as one
  // untracked entry): paths:open sends it on, and says so if it's missing
  if (typeof res?.text !== 'string') return openOutside(opts);
  // the tree follows the file: another repo is listed before showing it; the
  // same repo is shown at once and its badges catch up after, since listing a
  // repo is the slow part of a click
  const sameRepo = peek.tree && peekInside(res.path, peek.tree.root);
  if (!sameRepo) {
    const tree = await api.peekTree(peekDirname(res.path));
    peek.tree = tree?.files ? peekBuildTree(tree) : null;
    peekStartIndex(peek.tree);
  } else if (peek.tree.lazy) {
    // a file found by search may sit in folders not listed yet
    await peekLoadFolderOf(res.path);
  }
  showPeek(opts, res);
  if (sameRepo) peekRefreshTree();
}

// a lazy tree lists folders on demand: the ones down to this file, listed
async function peekLoadFolderOf(abs) {
  const rel = abs.slice(peek.tree.root.replace(/[\\/]+$/, '').length + 1).replace(/\\/g, '/');
  await peekLoadPath(rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
}

// The tree re-listed in place: new files, fresh badges, scroll kept. A lazy
// tree has no badges, and re-listing it would fold away what was unfolded.
async function peekRefreshTree() {
  const rootDir = peek.tree?.root;
  if (!rootDir || peek.tree.lazy) return;
  const tree = await api.peekTree(rootDir);
  if (!tree?.files || peek.tree?.root !== rootDir || !peek.root?.classList.contains('open')) return;
  peek.tree = peekBuildTree(tree);
  const box = peek.root.querySelector('.peek-tree');
  const top = box.scrollTop;
  peekRenderTree();
  box.scrollTop = top;
}

// the clicked row lit at once, before the file has been read
function peekSelectRow(row) {
  row.parentElement?.querySelectorAll('.peek-row.selected').forEach((r) => r.classList.remove('selected'));
  row.classList.add('selected');
}

// The Files button's way in, and Ctrl+Shift+E's: the folder they are for, or
// the one last browsed to from it with Folder…
async function peekBrowseHome(home, tab = state.activeTab) {
  if (!home) return toast('No folder here to browse', { error: true });
  peek.home = home;
  peek.homeKey = peekKeyFor(tab);
  const away = peek.browsedFrom.get(peek.homeKey);
  // a folder since deleted or unplugged is forgotten, and home shown instead
  if (away && (await peekBrowse(away, { quiet: true }))) return;
  peek.browsedFrom.delete(peek.homeKey);
  return peekBrowse(home);
}

// The files last shown, by repo, for whoever's Peek this is: two tabs in one
// repo each come back to their own.
function peekLastFiles() {
  const key = peek.homeKey || 'none';
  if (!peek.lastFile.has(key)) peek.lastFile.set(key, new Map());
  return peek.lastFile.get(key);
}

// A name cut short that more than one file starts with (packag…): the
// folder's tree, searched for that start, to pick from.
async function peekCutName(dir, start, home) {
  peek.home = home || null;
  peek.homeKey = peekKeyFor(state.activeTab);
  if (!(await peekBrowse(dir))) return;
  peek.filter.input.value = start;
  peek.filter.input.dispatchEvent(new Event('input'));
  peek.filter.input.focus();
}

// Whose Peek it is: in the agent tab, the session selected there, so two
// sessions in one repo browse apart; elsewhere the tab itself.
function peekKeyFor(tab) {
  if (tab?.kind !== 'agents') return tab || null;
  const agent = globalAgents.get(tab.selected);
  return agent ? 'session:' + (agent.sessionId || agent.id) : tab;
}

// The way back home shows only while the tree is somewhere else: a home inside
// the tree's root (a repo's subfolder) is home.
function peekSyncHome() {
  const btn = peek.root?.querySelector('.peek-home');
  if (!btn) return;
  const root = peek.tree?.root;
  const away = !!(peek.home && root && peekNorm(peek.home) !== peekNorm(root) && !peekInside(peek.home, root));
  btn.hidden = !away;
  if (!away) return;
  const name = peek.home.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '');
  btn.querySelector('span').textContent = name;
  btn.title = 'Back to ' + peek.home;
}

// A tree with nothing open yet, or the file last shown in it. False when the
// folder couldn't be listed.
async function peekBrowse(dir, { quiet = false } = {}) {
  if (!dir) {
    toast('No folder here to browse', { error: true });
    return false;
  }
  const tree = await api.peekTree(dir);
  if (!tree?.files) {
    if (!quiet) toast(tree?.error || 'Could not list ' + dir, { error: true });
    return false;
  }
  peek.tree = peekBuildTree(tree);
  // back where it was left: the file last shown in this repo, if still readable
  const last = peekLastFiles().get(peekNorm(peek.tree.root));
  const res = last && (await api.readPath({ cwd: peekDirname(last), target: last }));
  if (typeof res?.text === 'string') {
    if (peek.tree.lazy) await peekLoadFolderOf(res.path);
    showPeek({ cwd: peekDirname(res.path), target: res.path }, res);
  } else showPeek(null, null);
  peekStartIndex(peek.tree);
  return true;
}

function peekBuild() {
  const root = document.createElement('div');
  root.id = 'peek';
  root.innerHTML = `
    <div class="peek-box">
      <header class="peek-head">
        <b class="peek-root"></b>
        <button class="peek-btn peek-pick" type="button" title="Open another folder">
          <svg viewBox="0 0 16 16"><path d="M1.75 4.25a1.5 1.5 0 0 1 1.5-1.5h2.6l1.5 1.75h5.4a1.5 1.5 0 0 1 1.5 1.5v5.75a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5z" /></svg><span>Folder&hellip;</span>
        </button>
        <button class="peek-btn peek-home" type="button" hidden>
          <svg viewBox="0 0 16 16"><path d="M6.25 4 2.75 7.5 6.25 11M3 7.5h6.75a3.5 3.5 0 0 1 0 7H8.5" /></svg><span></span>
        </button>
        <span class="peek-crumbs"></span>
        <div class="peek-modes" hidden>
          <button class="peek-mode" type="button" data-mode="preview">Preview</button>
          <button class="peek-mode" type="button" data-mode="source">Source</button>
        </div>
        <button class="peek-btn peek-reveal" type="button" title="Show in File Explorer">
          <svg viewBox="0 0 16 16"><path d="M1.75 4.25a1.5 1.5 0 0 1 1.5-1.5h2.6l1.5 1.75h5.4a1.5 1.5 0 0 1 1.5 1.5v5.75a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5zM8 7.25v3.5M6.25 9 8 10.75 9.75 9" /></svg><span>Show in Explorer</span>
        </button>
        <button class="peek-btn peek-editor" type="button" title="Open in editor (Ctrl+Shift+click)">
          <svg viewBox="0 0 16 16"><path d="M9.25 2.75h4v4M13.25 2.75 7.5 8.5M11.25 9.5v2.75a1 1 0 0 1-1 1h-6.5a1 1 0 0 1-1-1v-6.5a1 1 0 0 1 1-1H6.5" /></svg><span>Open in editor</span>
        </button>
        <button class="peek-btn peek-close" type="button" title="Close (Esc)">
          <svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" /></svg>
        </button>
      </header>
      <div class="peek-main">
        <aside class="peek-side">
          <div class="peek-side-search">
            <input class="pane-search-input peek-filter" type="text" placeholder="Search files (Ctrl+P)" spellcheck="false" />
          </div>
          <div class="peek-tree"></div>
        </aside>
        <div class="peek-body" tabindex="-1">
          <div class="peek-lines">
            <div class="peek-marks"></div>
            <div class="peek-band"></div>
            <div class="peek-gutter"></div>
            <pre class="peek-code"><code></code></pre>
          </div>
          <article class="peek-md" hidden></article>
          <div class="peek-empty" hidden>Pick a file on the left</div>
        </div>
        <div class="peek-mini" hidden>
          <canvas></canvas>
          <div class="peek-mini-view"></div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(root);

  root.addEventListener('mousedown', (ev) => {
    if (ev.target === root) closePeek();
  });
  root.querySelector('.peek-close').addEventListener('click', closePeek);
  // with no file open, both act on the folder the tree shows
  root.querySelector('.peek-reveal').addEventListener('click', () => {
    const target = peek.file || peek.tree?.root;
    if (!target) return;
    api.revealPath({ cwd: peekDirname(target), target }).then((res) => {
      if (res?.error && !res.opened) toast(res.error, { error: true });
    });
  });
  root.querySelector('.peek-editor').addEventListener('click', () => {
    if (!peek.file) {
      const dir = peek.tree?.root;
      if (!dir) return;
      closePeek();
      api.openDir({ target: dir }).then((res) => {
        if (res?.error && !res.opened) toast(res.error, { error: true });
      });
      return;
    }
    const opts = { cwd: peekDirname(peek.file), target: peek.file, line: peek.opts?.line };
    closePeek();
    openOutside(opts);
  });
  root.querySelector('.peek-pick').addEventListener('click', async () => {
    const dir = await api.pickDir();
    if (!dir) return;
    if (peek.home && peek.homeKey) {
      if (peekNorm(dir) === peekNorm(peek.home)) peek.browsedFrom.delete(peek.homeKey);
      else peek.browsedFrom.set(peek.homeKey, dir);
    }
    peekBrowse(dir);
  });
  root.querySelector('.peek-home').addEventListener('click', () => {
    if (!peek.home) return;
    if (peek.homeKey) peek.browsedFrom.delete(peek.homeKey);
    peekBrowse(peek.home);
  });
  root.querySelectorAll('.peek-mode').forEach((b) =>
    b.addEventListener('click', () => {
      peek.mode = b.dataset.mode;
      peekRenderFile();
    })
  );
  root.querySelector('.peek-md').addEventListener('click', peekMdLink);

  const body = root.querySelector('.peek-body');
  const mini = root.querySelector('.peek-mini');
  body.addEventListener('scroll', peekMiniView, { passive: true });
  new ResizeObserver(() => peekDrawMini()).observe(mini);
  // press or drag on the minimap: that part of the file, centred
  const seek = (ev) => {
    const m = peek.mini;
    if (!m) return;
    const y = ev.clientY - mini.getBoundingClientRect().top;
    const line = y / m.lineH;
    body.scrollTop = PEEK_PAD + line * m.lh - body.clientHeight / 2;
  };
  mini.addEventListener('pointerdown', (ev) => {
    mini.setPointerCapture(ev.pointerId);
    seek(ev);
  });
  mini.addEventListener('pointermove', (ev) => {
    if (mini.hasPointerCapture(ev.pointerId)) seek(ev);
  });
  peekBuildFind(root);
  peekWireFilter(root);
  root.addEventListener('keydown', (ev) => {
    const plainCtrl = ev.ctrlKey && !ev.shiftKey && !ev.altKey;
    const key = ev.key.toLowerCase();
    const inInput = ev.target.tagName === 'INPUT';
    if (ev.key === 'Escape') peekEscape();
    else if (plainCtrl && key === 'f') peekOpenFind();
    else if (plainCtrl && key === 'p') {
      const filter = root.querySelector('.peek-filter');
      filter.focus();
      filter.select();
    }
    // the file, not the whole window: select-all is for copying what's shown
    else if (plainCtrl && key === 'a' && !inInput) {
      const md = root.querySelector('.peek-md');
      const range = document.createRange();
      range.selectNodeContents(md.hidden ? root.querySelector('.peek-code code') : md);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } else return;
    ev.preventDefault();
    ev.stopPropagation();
  });
  return root;
}

