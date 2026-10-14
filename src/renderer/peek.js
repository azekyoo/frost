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
  lastFile: new Map(), // tree root (lowercased) -> absolute path last shown there
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

async function peekPath(opts) {
  const res = await api.readPath(opts);
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

// The palette's way in, and the folder button's: a tree with nothing open yet.
async function peekBrowse(dir) {
  if (!dir) return toast('No folder here to browse', { error: true });
  const tree = await api.peekTree(dir);
  if (!tree?.files) return toast(tree?.error || 'Could not list ' + dir, { error: true });
  peek.tree = peekBuildTree(tree);
  // back where it was left: the file last shown in this repo, if still readable
  const last = peek.lastFile.get(peekNorm(peek.tree.root));
  const res = last && (await api.readPath({ cwd: peekDirname(last), target: last }));
  if (typeof res?.text === 'string') {
    if (peek.tree.lazy) await peekLoadFolderOf(res.path);
    showPeek({ cwd: peekDirname(res.path), target: res.path }, res);
  } else showPeek(null, null);
  peekStartIndex(peek.tree);
}

function peekBuild() {
  const root = document.createElement('div');
  root.id = 'peek';
  root.innerHTML = `
    <div class="peek-box">
      <header class="peek-head">
        <b class="peek-root"></b>
        <button class="peek-btn peek-pick" type="button" title="Open another folder">Folder&hellip;</button>
        <span class="peek-crumbs"></span>
        <div class="peek-modes" hidden>
          <button class="peek-mode" type="button" data-mode="preview">Preview</button>
          <button class="peek-mode" type="button" data-mode="source">Source</button>
        </div>
        <button class="peek-btn peek-editor" type="button" title="Open in editor (Ctrl+Shift+click)">Open in editor</button>
        <button class="peek-btn peek-close" type="button" title="Close (Esc)">&#x2715;</button>
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
  root.querySelector('.peek-editor').addEventListener('click', () => {
    if (!peek.file) return;
    const opts = { cwd: peekDirname(peek.file), target: peek.file, line: peek.opts?.line };
    closePeek();
    openOutside(opts);
  });
  root.querySelector('.peek-pick').addEventListener('click', async () => {
    const dir = await api.pickDir();
    if (dir) peekBrowse(dir);
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

// ---------- find in file ----------
// The terminal's find bar, same look and same Aa / ab / .* options (one set for
// the whole app, as there). Matches are painted with the CSS highlight API
// rather than by wrapping them in elements, so the highlighted code and the
// rendered markdown are searched as they are, without being rebuilt.

const PEEK_FIND_MAX = 5000;

function peekBuildFind(root) {
  const bar = document.createElement('div');
  bar.className = 'pane-search peek-find';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'pane-search-input';
  input.placeholder = 'Find';
  input.spellcheck = false;
  const count = document.createElement('span');
  count.className = 'pane-search-count';
  const mkBtn = (text, title, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', fn);
    return b;
  };
  const toggles = SEARCH_TOGGLES.map(({ key, label, title }) => {
    const b = mkBtn(label, title, () => {
      searchOptions[key] = !searchOptions[key];
      applySearchOptions(); // the panes' bars show the same set
      peekSyncToggles();
      peekFindRun(false);
    });
    b.className = 'pane-search-toggle';
    b.addEventListener('mousedown', (ev) => ev.preventDefault()); // keep the caret in the box
    return b;
  });
  bar.append(
    input,
    ...toggles,
    count,
    mkBtn('▲', 'Previous match (Shift+Enter)', () => peekFindStep(-1)),
    mkBtn('▼', 'Next match (Enter)', () => peekFindStep(1)),
    mkBtn('×', 'Close (Esc)', peekCloseFind)
  );
  root.querySelector('.peek-main').appendChild(bar);
  peek.find = { bar, input, count, toggles, ranges: [], lines: [], index: -1 };

  input.addEventListener('input', () => peekFindRun(true));
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') peekFindStep(ev.shiftKey ? -1 : 1);
    else if (ev.key === 'Escape') peekCloseFind();
    else if (ev.altKey && !ev.ctrlKey && !ev.shiftKey && SEARCH_TOGGLES.some((t) => t.code === ev.code)) {
      const hit = SEARCH_TOGGLES.find((t) => t.code === ev.code);
      searchOptions[hit.key] = !searchOptions[hit.key];
      applySearchOptions();
      peekSyncToggles();
      peekFindRun(false);
    } else return;
    ev.preventDefault();
    ev.stopPropagation(); // Esc closes the bar, not the whole viewer
  });
}

function peekSyncToggles() {
  peek.find.toggles.forEach((b, i) => b.classList.toggle('on', Boolean(searchOptions[SEARCH_TOGGLES[i].key])));
}

function peekOpenFind() {
  if (!peek.file) return;
  const { bar, input } = peek.find;
  peekSyncToggles();
  bar.classList.add('open');
  // a selection in the file is the likeliest thing to look for
  const sel = window.getSelection().toString();
  if (sel && !sel.includes('\n')) input.value = sel;
  input.focus();
  input.select();
  peekFindRun(false);
}

function peekCloseFind() {
  const f = peek.find;
  if (!f) return;
  f.bar.classList.remove('open');
  peekClearFind();
  peek.root.querySelector('.peek-body').focus({ preventScroll: true });
}

function peekClearFind() {
  const f = peek.find;
  CSS.highlights.delete('peek-find');
  CSS.highlights.delete('peek-find-active');
  f.ranges = [];
  f.lines = [];
  f.index = -1;
  f.count.textContent = '';
  f.bar.classList.remove('bad');
  peekDrawMini();
}

// What is on screen: the code, or the rendered markdown.
function peekFindTarget() {
  const md = peek.root.querySelector('.peek-md');
  return md.hidden ? peek.root.querySelector('.peek-code code') : md;
}

// keep: stay on the current match while it still matches (typing a longer query)
function peekFindRun(keep) {
  const f = peek.find;
  if (!f?.bar.classList.contains('open')) return;
  const before = f.ranges[f.index];
  const anchor = before ? { node: before.startContainer, offset: before.startOffset } : null;
  peekClearFind();
  const query = f.input.value;
  if (!query || !peek.file) return;
  let re;
  try {
    let src = searchOptions.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (searchOptions.wholeWord) src = `\\b(?:${src})\\b`;
    re = new RegExp(src, 'g' + (searchOptions.caseSensitive ? '' : 'i'));
  } catch {
    // half-typed regex: a search that cannot run yet, not an error
    f.bar.classList.add('bad');
    f.count.textContent = 'Bad pattern';
    return;
  }

  // the text nodes in order, so a match can span highlight.js's spans
  const target = peekFindTarget();
  const nodes = [];
  let text = '';
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n, start: text.length });
    text += n.data;
  }
  const locate = (pos, from) => {
    let i = from;
    while (i < nodes.length - 1 && nodes[i + 1].start <= pos) i++;
    return i;
  };
  const isCode = target.tagName === 'CODE';
  let ni = 0;
  let line = 1;
  let lineAt = 0;
  for (let m = re.exec(text); m && f.ranges.length < PEEK_FIND_MAX; m = re.exec(text)) {
    if (!m[0].length) {
      re.lastIndex++;
      continue;
    }
    const s = locate(m.index, ni);
    const e = locate(m.index + m[0].length - 1, s);
    ni = s;
    const range = document.createRange();
    range.setStart(nodes[s].node, m.index - nodes[s].start);
    range.setEnd(nodes[e].node, m.index + m[0].length - nodes[e].start);
    f.ranges.push(range);
    if (isCode) {
      for (let i = text.indexOf('\n', lineAt); i !== -1 && i < m.index; i = text.indexOf('\n', i + 1)) {
        line++;
        lineAt = i + 1;
      }
      f.lines.push(line);
    }
  }
  if (!f.ranges.length) {
    f.count.textContent = 'No results';
    return;
  }
  CSS.highlights.set('peek-find', new Highlight(...f.ranges));
  // the match just left, if it is still one; otherwise the first below the view
  let index = -1;
  if (keep && anchor) {
    index = f.ranges.findIndex(
      (r) => r.startContainer === anchor.node && r.startOffset === anchor.offset
    );
  }
  if (index < 0) {
    const top = peek.root.querySelector('.peek-body').getBoundingClientRect().top;
    index = Math.max(0, f.ranges.findIndex((r) => r.getBoundingClientRect().top >= top));
  }
  peekFindSelect(index);
  peekDrawMini();
}

function peekFindStep(dir) {
  const f = peek.find;
  if (!f.ranges.length) return peekFindRun(false);
  peekFindSelect((f.index + dir + f.ranges.length) % f.ranges.length);
}

function peekFindSelect(index) {
  const f = peek.find;
  f.index = index;
  const range = f.ranges[index];
  CSS.highlights.set('peek-find-active', new Highlight(range));
  f.count.textContent = `${index + 1}/${f.ranges.length}${f.ranges.length >= PEEK_FIND_MAX ? '+' : ''}`;
  // into view, centred, sideways too for a match far along a long line
  const body = peek.root.querySelector('.peek-body');
  const box = body.getBoundingClientRect();
  const r = range.getBoundingClientRect();
  if (r.top < box.top + 40 || r.bottom > box.bottom - 20) body.scrollTop += r.top - box.top - body.clientHeight / 2;
  const gutter = peek.root.querySelector('.peek-gutter').offsetWidth;
  if (r.left < box.left + gutter || r.right > box.right - 20) body.scrollLeft += r.left - box.left - body.clientWidth / 2;
}

// ---------- file tree ----------

// The flat list main sends, folded into folders. A folder is marked changed
// when anything under it is, so a change deep down is visible while collapsed.
// A repo arrives whole. A folder outside git arrives one level at a time
// (lazy): a folder's entries are fetched the first time it is unfolded, and
// `loaded` says whether that has happened.
function peekBuildTree({ root, git, files, dirs = [], status, lazy = false }) {
  const tree = { root, git, status, lazy, top: peekNode('', ''), files: [], dirs: [], index: null };
  tree.top.loaded = true;
  peekTreeAdd(tree, files, dirs);
  for (const p of Object.keys(status)) {
    let dir = tree.top;
    for (const part of p.split('/').slice(0, -1)) {
      dir = dir.dirs.get(part);
      if (!dir) break;
      dir.changed = true;
    }
  }
  return tree;
}

function peekNode(name, path) {
  return { name, path, dirs: new Map(), files: [], changed: false, loaded: false };
}

// files and folders (paths relative to the root) into the tree; tree.files and
// tree.dirs keep the flat lists the search box reads
function peekTreeAdd(tree, files, dirs) {
  const dirAt = (p) => {
    let d = tree.top;
    if (!p) return d;
    const parts = p.split('/');
    for (let i = 0; i < parts.length; i++) {
      if (!d.dirs.has(parts[i])) {
        const sub = parts.slice(0, i + 1).join('/');
        const node = peekNode(parts[i], sub);
        node.loaded = !tree.lazy;
        d.dirs.set(parts[i], node);
        tree.dirs.push(sub);
      }
      d = d.dirs.get(parts[i]);
    }
    return d;
  };
  for (const d of dirs) dirAt(d);
  for (const f of files) {
    const cut = f.lastIndexOf('/');
    dirAt(cut < 0 ? '' : f.slice(0, cut)).files.push({ name: f.slice(cut + 1), path: f });
    tree.files.push(f);
  }
}

function peekNodeAt(tree, rel) {
  let d = tree.top;
  for (const part of rel ? rel.split('/') : []) {
    d = d.dirs.get(part);
    if (!d) return null;
  }
  return d;
}

async function peekLoadDir(rel) {
  const tree = peek.tree;
  const node = tree && peekNodeAt(tree, rel);
  if (!tree?.lazy || !node || node.loaded) return;
  node.loaded = true;
  const got = await api.peekDir(tree.root, rel);
  if (peek.tree === tree) peekTreeAdd(tree, got.files, got.dirs);
}

// every folder down to relDir loaded, so a search result deep in a lazy tree
// can be shown in place
async function peekLoadPath(relDir) {
  if (!relDir) return;
  const parts = relDir.split('/');
  for (let i = 1; i <= parts.length; i++) await peekLoadDir(parts.slice(0, i).join('/'));
}

// The search box of a lazy tree needs every file, which is the slow listing:
// built after the viewer is up, and the results redrawn when it lands.
function peekStartIndex(tree) {
  if (!tree?.lazy) return;
  api.peekIndex(tree.root).then((index) => {
    if (peek.tree !== tree || !index) return;
    tree.index = index;
    if (peek.filter.input.value.trim()) peekRenderTree();
  });
}

// ---------- file search ----------
// Above the tree: type part of a name, get a flat list of files and folders,
// best matches first. Enter opens the top one; a folder is revealed in the tree.

const PEEK_FILTER_MAX = 200;

// lower is better; null is no match
function peekFilterScore(path, q) {
  const p = path.toLowerCase();
  const name = p.slice(p.lastIndexOf('/') + 1);
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  if (p.includes(q)) return 3;
  // letters in order anywhere ("pkjs" -> peek.js): only on the name, and only
  // from three letters, below which nearly every path matches
  return q.length >= 3 && fuzzy(name, q) ? 4 : null;
}

function peekFilterResults(query) {
  const q = query.trim().toLowerCase().replace(/\\/g, '/');
  const out = [];
  const add = (path, isDir) => {
    const score = peekFilterScore(path, q);
    if (score !== null) out.push({ path, isDir, score });
  };
  // a lazy tree searches its full listing once that has arrived
  const src = peek.tree.index || peek.tree;
  for (const d of src.dirs) add(d, true);
  for (const f of src.files) add(f, false);
  out.sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return out.slice(0, PEEK_FILTER_MAX);
}

function peekWireFilter(root) {
  const input = root.querySelector('.peek-filter');
  peek.filter = { input, active: 0 };
  input.addEventListener('input', () => {
    peek.filter.active = 0;
    peekRenderTree();
  });
  input.addEventListener('keydown', (ev) => {
    const rows = [...root.querySelectorAll('.peek-tree .peek-row.result')];
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (!rows.length) return;
      const n = rows.length;
      peek.filter.active = (peek.filter.active + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n;
      rows.forEach((r, i) => r.classList.toggle('active', i === peek.filter.active));
      rows[peek.filter.active].scrollIntoView({ block: 'nearest' });
    } else if (ev.key === 'Enter') {
      rows[peek.filter.active]?.click();
    } else return; // Esc is the viewer's, which peels one layer at a time
    ev.preventDefault();
    ev.stopPropagation();
  });
}

// Esc undoes the latest thing, wherever the focus is: the find bar, then the
// file search (back to the tree, unfolded to the open file), then the viewer.
// Results outlive a click on one, so several files can be opened from a search.
function peekEscape() {
  if (peek.find.bar.classList.contains('open')) return peekCloseFind();
  if (peek.filter.input.value) {
    peek.filter.input.value = '';
    peek.filter.active = 0;
    peekRenderTree();
    peek.root.querySelector('.peek-body').focus({ preventScroll: true });
    return;
  }
  closePeek();
}

// Shows a folder found by search in its place: search cleared, the folder and
// its parents unfolded, scrolled to.
async function peekReveal(dirPath) {
  await peekLoadPath(dirPath);
  peek.filter.input.value = '';
  const open = peekOpenDirs();
  const parts = dirPath.split('/');
  for (let i = 1; i <= parts.length; i++) open.add(parts.slice(0, i).join('/'));
  peekRenderTree();
  const row = [...peek.root.querySelectorAll('.peek-tree .peek-row.dir')].find((r) => r.dataset.path === dirPath);
  row?.scrollIntoView({ block: 'center' });
}

function peekRenderResults(box, current) {
  const tree = peek.tree;
  const results = peekFilterResults(peek.filter.input.value);
  const listing = tree.lazy && !tree.index;
  if (!results.length) {
    const none = document.createElement('p');
    none.className = 'peek-none';
    none.textContent = listing ? 'Still listing folders…' : 'No matching files';
    box.replaceChildren(none);
    return;
  }
  box.replaceChildren(
    ...results.map((r, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      const st = r.isDir ? null : tree.status[r.path];
      row.className =
        'peek-row result ' +
        (r.isDir ? 'dir' : 'file') +
        (st ? ' st-' + st : '') +
        (r.path === current ? ' selected' : '') +
        (i === peek.filter.active ? ' active' : '');
      const cut = r.path.lastIndexOf('/');
      const name = document.createElement('span');
      name.textContent = r.path.slice(cut + 1);
      row.appendChild(name);
      if (cut > 0) {
        const where = document.createElement('small');
        where.textContent = r.path.slice(0, cut);
        row.appendChild(where);
      }
      if (st) row.dataset.status = st;
      row.title = r.path;
      row.addEventListener('click', () => {
        if (r.isDir) peekReveal(r.path);
        else if (st !== 'D') {
          peekSelectRow(row);
          peekPath({ cwd: tree.root, target: r.path });
        }
      });
      return row;
    })
  );
  // results so far come from the folders already listed; say more are coming
  if (listing) {
    const note = document.createElement('p');
    note.className = 'peek-none';
    note.textContent = 'Still listing folders…';
    box.prepend(note);
  }
}

function peekOpenDirs() {
  const key = peekNorm(peek.tree.root);
  if (!peek.openDirs.has(key)) peek.openDirs.set(key, new Set());
  return peek.openDirs.get(key);
}

function peekRenderTree() {
  const box = peek.root.querySelector('.peek-tree');
  const tree = peek.tree;
  peek.root.querySelector('.peek-side').hidden = !tree;
  if (!tree) return;
  const rootName = tree.root.split(/[\\/]/).pop() || tree.root;
  peek.root.querySelector('.peek-root').textContent = rootName;
  peek.root.querySelector('.peek-root').title = tree.root;
  const current =
    peek.file && peekInside(peek.file, tree.root)
      ? peek.file.slice(tree.root.replace(/[\\/]+$/, '').length + 1).replace(/\\/g, '/')
      : null;
  const open = peekOpenDirs();
  // the file on screen is always findable in the tree
  if (current) {
    const parts = current.split('/');
    for (let i = 1; i < parts.length; i++) open.add(parts.slice(0, i).join('/'));
  }
  if (peek.filter.input.value.trim()) return peekRenderResults(box, current);
  const rows = [];
  const byName =(a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const walk = (dir, depth) => {
    for (const sub of [...dir.dirs.values()].sort(byName)) {
      const row = document.createElement('button');
      row.type = 'button';
      const isOpen = open.has(sub.path);
      row.className = 'peek-row dir' + (isOpen ? ' open' : '') + (sub.changed ? ' changed' : '');
      row.dataset.path = sub.path;
      row.style.setProperty('--depth', depth);
      row.textContent = sub.name;
      row.addEventListener('click', async () => {
        if (open.has(sub.path)) open.delete(sub.path);
        else {
          open.add(sub.path);
          await peekLoadDir(sub.path); // a lazy tree's folder, listed on first unfold
        }
        peekRenderTree();
      });
      rows.push(row);
      if (isOpen) walk(sub, depth + 1);
    }
    for (const f of [...dir.files].sort(byName)) {
      const row = document.createElement('button');
      row.type = 'button';
      const st = tree.status[f.path];
      row.className = 'peek-row file' + (st ? ' st-' + st : '') + (f.path === current ? ' selected' : '');
      row.style.setProperty('--depth', depth);
      row.textContent = f.name;
      if (st) {
        row.dataset.status = st;
        row.title = PEEK_STATUS[st];
      }
      if (st !== 'D') {
        row.addEventListener('click', () => {
          peekSelectRow(row);
          peekPath({ cwd: tree.root, target: f.path });
        });
      }
      rows.push(row);
    }
  };
  walk(tree.top, 0);
  box.replaceChildren(...rows);
  box.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
}

// ---------- file ----------

function peekLanguage(name) {
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.split('.').pop() : lower; // Makefile, Dockerfile
  return hljs.getLanguage(ext) ? ext : null;
}

// Uncommitted changes drawn as the diff panel draws them: added (and changed)
// lines tinted green, a red notch where lines were taken out.
function peekDrawMarks(marks, count, lh) {
  const layer = peek.root.querySelector('.peek-marks');
  const out = [];
  for (const [from, to] of marks?.added || []) {
    const end = Math.min(to, count);
    if (from > end) continue;
    const band = document.createElement('div');
    band.className = 'peek-add';
    band.style.top = PEEK_PAD + (from - 1) * lh + 'px';
    band.style.height = (end - from + 1) * lh + 'px';
    out.push(band);
  }
  for (const { after, count: gone } of marks?.deleted || []) {
    const notch = document.createElement('div');
    notch.className = 'peek-del';
    notch.style.top = PEEK_PAD + Math.min(after, count) * lh + 'px';
    notch.title = gone === 1 ? '1 line deleted' : `${gone} lines deleted`;
    out.push(notch);
  }
  layer.replaceChildren(...out);
}

// ---------- minimap ----------
// The whole file squeezed into the strip's height, so its shape and where the
// changes sit can be read at a glance. Lines are drawn as bars by indent and
// length, not as text: at a pixel or two a line, text is noise.
const PEEK_MINI_COLS = 120; // columns the strip's width stands for
const PEEK_MINI_MAX_LINE = 3; // px per line when the file is short

function peekDrawMini() {
  const m = peek.mini;
  const box = peek.root?.querySelector('.peek-mini');
  if (!m || !box || box.hidden) return;
  const canvas = box.querySelector('canvas');
  const w = box.clientWidth;
  const h = box.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  m.lineH = Math.min(PEEK_MINI_MAX_LINE, h / m.count);
  const barH = Math.max(m.lineH * 0.7, 0.5);
  const colW = (w - 12) / PEEK_MINI_COLS;
  const css = getComputedStyle(peek.root);
  const fg = css.getPropertyValue('--fg').trim() || '#ffffff';

  for (const [from, to] of m.marks?.added || []) {
    const end = Math.min(to, m.count);
    if (from > end) continue;
    const y = (from - 1) * m.lineH;
    const hh = Math.max((end - from + 1) * m.lineH, 2);
    ctx.fillStyle = 'rgba(32, 224, 112, 0.22)';
    ctx.fillRect(0, y, w, hh);
    ctx.fillStyle = 'rgba(32, 224, 112, 0.9)';
    ctx.fillRect(0, y, 3, hh);
  }

  ctx.globalAlpha = 0.32;
  ctx.fillStyle = fg;
  for (let i = 0; i < m.count; i++) {
    const text = m.lines[i] || '';
    const len = Math.min(PEEK_MINI_COLS, text.replace(/\t/g, '    ').trimEnd().length);
    if (!len) continue;
    const indent = Math.min(len, text.replace(/\t/g, '    ').search(/\S/));
    ctx.fillRect(6 + indent * colW, i * m.lineH, (len - indent) * colW, barH);
  }
  ctx.globalAlpha = 1;

  ctx.fillStyle = 'rgba(255, 59, 78, 0.95)';
  for (const { after } of m.marks?.deleted || []) {
    ctx.fillRect(0, Math.min(after, m.count) * m.lineH - 1, w, 2);
  }
  if (m.line) {
    ctx.fillStyle = css.getPropertyValue('--accent').trim() || '#7aa2f7';
    ctx.fillRect(0, (m.line - 1) * m.lineH, w, Math.max(m.lineH, 2));
  }
  // find matches, as ticks on the right edge: where in the file they are
  ctx.fillStyle = '#ffb84d';
  for (const l of peek.find?.lines || []) ctx.fillRect(w - 9, (l - 1) * m.lineH, 9, Math.max(m.lineH, 2));
  peekMiniView();
}

// the box around what the code view currently shows
function peekMiniView() {
  const m = peek.mini;
  if (!m?.lineH) return;
  const body = peek.root.querySelector('.peek-body');
  const view = peek.root.querySelector('.peek-mini-view');
  const first = Math.max(0, (body.scrollTop - PEEK_PAD) / m.lh);
  const shown = body.clientHeight / m.lh;
  view.style.top = first * m.lineH + 'px';
  view.style.height = Math.max(shown * m.lineH, 6) + 'px';
}

function peekRenderCode(name, text, line) {
  const root = peek.root;
  const size = state.theme?.font?.size || 14;
  const lh = Math.round(size * 1.5);
  root.style.setProperty('--peek-size', size + 'px');
  root.style.setProperty('--peek-lh', lh + 'px');
  root.style.setProperty('--peek-pad', PEEK_PAD + 'px');

  const code = root.querySelector('.peek-code code');
  const lang = text.length <= PEEK_HIGHLIGHT_MAX && peekLanguage(name);
  if (lang) code.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  else code.textContent = text;
  // a final newline ends the last line rather than starting another
  const count = Math.max(1, text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
  root.querySelector('.peek-gutter').textContent = Array.from({ length: count }, (_, i) => i + 1).join('\n');
  peekDrawMarks(peek.marks, count, lh);

  line = Math.min(count, Math.max(0, line || 0));
  const band = root.querySelector('.peek-band');
  band.hidden = !line;
  band.style.top = PEEK_PAD + (line - 1) * lh + 'px';
  const body = root.querySelector('.peek-body');
  // the line a third of the way down, so what leads up to it is in view too
  body.scrollTop = line ? Math.max(0, PEEK_PAD + (line - 1) * lh - body.clientHeight / 3) : 0;
  body.scrollLeft = 0;
  peek.mini = { lines: text.split('\n'), count, lh, line, marks: peek.marks, lineH: 0 };
  peekDrawMini();
}

// Markdown arrives from any repo and is drawn inside a window that can type
// into terminals, so what marked produces is sanitised before it lands: no
// scripts, handlers, forms or styles that could reach past the page.
function peekRenderMarkdown(text) {
  const md = peek.root.querySelector('.peek-md');
  const html = marked.parse(text, { gfm: true });
  md.innerHTML = DOMPurify.sanitize(html, {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe'],
    FORBID_ATTR: ['style']
  });
  // relative images are relative to the file, not to Frost's own page
  const base = 'file:///' + peekDirname(peek.file).replace(/\\/g, '/') + '/';
  for (const img of md.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (src && !/^[a-z][\w+.-]*:/i.test(src)) img.src = new URL(src, base).href;
  }
  // fenced code in the same colours as a source file
  for (const code of md.querySelectorAll('pre code')) {
    const lang = /\blanguage-([\w+-]+)/.exec(code.className)?.[1];
    if (lang && hljs.getLanguage(lang)) {
      code.innerHTML = hljs.highlight(code.textContent, { language: lang, ignoreIllegals: true }).value;
    }
  }
  // GitHub-style anchors, so a table of contents can jump
  for (const h of md.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    h.id = h.textContent.trim().toLowerCase().replace(/[^\w\- ]+/g, '').replace(/ /g, '-');
  }
  peek.root.querySelector('.peek-body').scrollTop = 0;
}

// A click in rendered markdown never navigates the window: web links go to the
// browser, links to other files open them here, anchors scroll.
function peekMdLink(ev) {
  const a = ev.target.closest('a[href]');
  if (!a) return;
  ev.preventDefault();
  const href = a.getAttribute('href');
  if (/^(https?|mailto):/i.test(href)) return api.openExternal(href);
  if (href.startsWith('#')) {
    peek.root.querySelector('.peek-md').querySelector('#' + CSS.escape(href.slice(1)))?.scrollIntoView();
    return;
  }
  if (/^[a-z][\w+.-]*:/i.test(href)) return; // other schemes: nothing safe to do
  let target = href.split('#')[0];
  try {
    target = decodeURIComponent(target);
  } catch {}
  if (target) peekPath({ cwd: peekDirname(peek.file), target });
}

// keepScroll: a live refresh, which must leave the reader where they were
function peekRenderFile(keepScroll) {
  const root = peek.root;
  const body = root.querySelector('.peek-body');
  const at = keepScroll ? { top: body.scrollTop, left: body.scrollLeft } : null;
  const has = !!peek.file;
  const isMd = has && PEEK_MD.test(peek.file);
  const preview = isMd && peek.mode === 'preview';
  root.querySelector('.peek-empty').hidden = has;
  root.querySelector('.peek-lines').hidden = !has || preview;
  root.querySelector('.peek-md').hidden = !preview;
  root.querySelector('.peek-mini').hidden = !has || preview;
  if (!has || preview) peek.mini = null;
  root.querySelector('.peek-modes').hidden = !isMd;
  root.querySelectorAll('.peek-mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === peek.mode));
  root.querySelector('.peek-editor').disabled = !has;

  const name = has ? peek.file.split(/[\\/]/).pop() : '';
  // the tree already shows which file this is; without one, the name is all
  // there is to say where you are
  if (!peek.tree) {
    root.querySelector('.peek-root').textContent = name;
    root.querySelector('.peek-root').title = peek.file || '';
  }
  // where in the repo this file sits, folders dim and the file itself bright:
  // the tree can be scrolled away from it, and names repeat across folders
  const crumbs = root.querySelector('.peek-crumbs');
  const parts =
    has && peek.tree
      ? (peekInside(peek.file, peek.tree.root)
          ? peek.file.slice(peek.tree.root.replace(/[\\/]+$/, '').length + 1)
          : peek.file
        ).split(/[\\/]/)
      : [];
  crumbs.replaceChildren(
    ...parts.flatMap((part, i) => {
      const span = document.createElement('span');
      span.className = i === parts.length - 1 ? 'crumb file' : 'crumb';
      span.textContent = part;
      return i ? [Object.assign(document.createElement('i'), { textContent: '/' }), span] : [span];
    })
  );
  crumbs.title = peek.file || '';

  if (!has) {
    root.querySelector('.peek-code code').textContent = '';
    peek.find.bar.classList.remove('open'); // nothing left to search
    peekClearFind();
    return;
  }
  if (preview) peekRenderMarkdown(peek.text);
  else peekRenderCode(name, peek.text, peek.opts?.line);
  if (at) {
    body.scrollTop = at.top;
    body.scrollLeft = at.left;
    peekMiniView();
  }
  // an open find bar searches whatever is now on screen
  peekFindRun(false);
}

// The open file changed on disk (an agent writing to it): text, marks and the
// tree's badges brought up to date in place.
async function peekReload() {
  const file = peek.file;
  const res = await api.readPath({ cwd: peekDirname(file), target: file });
  // gone, or swapped for something unreadable: what is on screen stays
  if (peek.file !== file || typeof res?.text !== 'string') return;
  peek.text = res.text.replace(/\r\n?/g, '\n');
  peek.marks = res.marks || null;
  peekRenderFile(true);
  peekRefreshTree();
}

api.onPeekChanged((file) => {
  if (peek.root?.classList.contains('open') && peek.file && peekNorm(file) === peekNorm(peek.file)) peekReload();
});

function showPeek(opts, res) {
  const root = peek.root || (peek.root = peekBuild());
  if (!root.classList.contains('open')) peek.returnTo = document.activeElement;
  peek.opts = opts;
  peek.file = res?.path || null;
  // a CR left in would be drawn as a trailing space on every line
  peek.text = (res?.text || '').replace(/\r\n?/g, '\n');
  peek.marks = res?.marks || null;
  if (peek.file && peek.tree && peekInside(peek.file, peek.tree.root))
    peek.lastFile.set(peekNorm(peek.tree.root), peek.file);
  // markdown opens rendered, unless a line was asked for: that is the source
  peek.mode = opts?.line ? 'source' : 'preview';

  const ansi = state.theme?.terminal || {};
  for (const k of PEEK_ANSI) root.style.setProperty('--ansi-' + k, ansi[k] || '');

  root.classList.add('open');
  api.peekWatch(peek.file);
  peekRenderTree();
  peekRenderFile();
  root.querySelector('.peek-body').focus({ preventScroll: true });
}

function closePeek() {
  if (!peek.root?.classList.contains('open')) return;
  peek.root.classList.remove('open');
  api.peekWatch(null);
  peek.find.bar.classList.remove('open');
  peekClearFind();
  // a large file is memory
  peek.root.querySelector('.peek-code code').textContent = '';
  peek.root.querySelector('.peek-md').textContent = '';
  peek.text = '';
  peek.mini = null;
  const back = peek.returnTo;
  peek.returnTo = null;
  if (back?.isConnected) back.focus();
}
