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

