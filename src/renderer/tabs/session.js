// ---------- session persistence ----------
// The layout is pushed to the main process on every change rather than on exit,
// so a crash still leaves something restorable on disk. Agent tabs are left out
// on purpose: they have their own resumable-session list, and relaunching
// `claude` unasked on startup would be the wrong call.

let restoring = false;

function serializeNode(node) {
  if (node.type === 'leaf') {
    return { t: 'leaf', profileId: node.profileId || null, cwd: node.cwd || null };
  }
  return {
    t: 'split',
    dir: node.dir,
    sizes: node.sizes.slice(),
    children: node.children.map(serializeNode)
  };
}

const saveSession = debounce(() => {
  if (restoring) return;
  if (state.theme?.restoreSession === false) {
    api.sessionSave({ tabs: [], activeTab: 0 });
    return;
  }
  const tabs = state.tabs.filter((t) => t.kind !== 'agents' && t.root);
  api.sessionSave({
    tabs: tabs.map((t) => ({ root: serializeNode(t.root), title: t.customTitle || null })),
    activeTab: Math.max(0, tabs.indexOf(state.activeTab))
  });
}, 400);

function savedSizes(sizes, n) {
  const s = Array.isArray(sizes) && sizes.length === n ? sizes.map(Number) : null;
  return s && s.every((x) => Number.isFinite(x) && x > 0) ? s : Array(n).fill(1);
}

// window.json is a plain file the user can edit or corrupt, and every leaf
// costs a real shell process, so the tree is measured before anything spawns.
const MAX_TABS = 20;
const MAX_PANES_PER_TAB = 16;
const MAX_PANES = 40;
const MAX_DEPTH = 12;

function isSplit(saved, depth) {
  return (
    depth < MAX_DEPTH &&
    saved &&
    saved.t === 'split' &&
    Array.isArray(saved.children) &&
    saved.children.length > 0
  );
}

function countLeaves(saved, depth = 0) {
  if (!isSplit(saved, depth)) return 1;
  let n = 0;
  for (const c of saved.children) {
    n += countLeaves(c, depth + 1);
    if (n > MAX_PANES) return n; // already disqualifying, no point walking further
  }
  return n;
}

async function buildSavedNode(saved, depth = 0) {
  if (!isSplit(saved, depth)) {
    // a directory that no longer exists falls back to the start dir in main
    return createPane({ profileId: saved?.profileId || undefined, cwd: saved?.cwd || undefined });
  }
  const children = [];
  for (const c of saved.children) children.push(await buildSavedNode(c, depth + 1));
  return {
    type: 'split',
    dir: saved.dir === 'col' ? 'col' : 'row',
    children,
    sizes: savedSizes(saved.sizes, children.length),
    el: null
  };
}

async function restoreTabs(session) {
  let budget = MAX_PANES;
  const savedTabs = [];
  for (const t of session.tabs.slice(0, MAX_TABS)) {
    const panes = countLeaves(t?.root);
    if (panes > MAX_PANES_PER_TAB || panes > budget) continue;
    budget -= panes;
    savedTabs.push(t);
  }
  if (savedTabs.length < session.tabs.length) {
    toast(`Restored ${savedTabs.length} of ${session.tabs.length} saved tabs`);
  }
  restoring = true;
  try {
    for (const savedTab of savedTabs) {
      const tab = {
        id: 'tab-' + ++tabCounter,
        title: '',
        root: null,
        activePane: null,
        contentEl: document.createElement('div')
      };
      tab.contentEl.className = 'tab-content';
      tab.root = await buildSavedNode(savedTab.root);
      const first = firstLeaf(tab.root);
      tab.title = first.profileName || 'shell';
      if (typeof savedTab.title === 'string' && savedTab.title.trim()) {
        tab.customTitle = savedTab.title.trim().slice(0, 60);
      }
      state.tabs.push(tab);
      activateTab(tab);
      renderTab(tab);
      focusPane(first);
    }
  } finally {
    restoring = false;
  }
  const target = state.tabs[session.activeTab];
  if (target) activateTab(target);
  return state.tabs.length > 0;
}
