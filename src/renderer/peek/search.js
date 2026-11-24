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

// A folder Ctrl+clicked in a terminal: its repo's tree, with the folder unfolded
// and in view. A folder outside any repo is the tree's own root.
async function peekFolder(dir, home) {
  peek.home = home || null;
  peek.homeKey = peekKeyFor(state.activeTab);
  await peekBrowse(dir);
  if (!peek.tree || !peek.root?.classList.contains('open')) return;
  const root = peek.tree.root.replace(/[\\/]+$/, '');
  if (!peekInside(dir, root)) return;
  const rel = dir.replace(/[\\/]+$/, '').slice(root.length + 1).replace(/\\/g, '/');
  await peekReveal(rel);
  const row = [...peek.root.querySelectorAll('.peek-tree .peek-row.dir')].find((r) => r.dataset.path === rel);
  if (row) peekSelectRow(row);
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
      row.dataset.key = 'd:' + sub.path;
      row.style.setProperty('--depth', depth);
      row.textContent = sub.name;
      row.addEventListener('click', async () => {
        if (open.has(sub.path)) open.delete(sub.path);
        else {
          open.add(sub.path);
          await peekLoadDir(sub.path); // a lazy tree's folder, listed on first unfold
        }
        peekTreeMotion(box, peekRenderTree);
      });
      rows.push(row);
      if (isOpen) walk(sub, depth + 1);
    }
    for (const f of [...dir.files].sort(byName)) {
      const row = document.createElement('button');
      row.type = 'button';
      const st = tree.status[f.path];
      row.className = 'peek-row file' + (st ? ' st-' + st : '') + (f.path === current ? ' selected' : '');
      row.dataset.key = 'f:' + f.path;
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

// A folder opening pushes the rows below it down and its contents drop in
// under it; closing pulls the rows below back up. Rows are matched across the
// rebuild by what they stand for, since every one is a new element.
const PEEK_TREE_MS = 160;

function peekTreeMotion(box, change) {
  const before = new Map(
    [...box.querySelectorAll('.peek-row')].map((r) => [r.dataset.key, r.getBoundingClientRect().top])
  );
  change();
  if (reduceMotion.matches || !before.size) return;
  for (const r of box.querySelectorAll('.peek-row')) {
    const was = before.get(r.dataset.key);
    if (was === undefined) {
      const a = r.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], {
        duration: PEEK_TREE_MS,
        easing: MOTION_EASE
      });
      a.id = 'motion-peek-row';
      continue;
    }
    const dy = was - r.getBoundingClientRect().top;
    if (Math.abs(dy) < 0.5) continue;
    const a = r.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], {
      duration: PEEK_TREE_MS,
      easing: MOTION_EASE
    });
    a.id = 'motion-peek-row';
  }
}

