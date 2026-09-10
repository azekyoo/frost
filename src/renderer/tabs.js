// Tabs: opening and closing them, dragging one along the strip or out of the
// window, naming one by hand, and remembering the lot for next time.

// ---------- tabs ----------

async function newTab({ profileId, cwd } = {}) {
  const tab = {
    id: 'tab-' + ++tabCounter,
    title: '',
    root: null,
    activePane: null,
    contentEl: document.createElement('div')
  };
  tab.contentEl.className = 'tab-content';
  const leaf = await createPane({ profileId, cwd });
  tab.title = leaf.profileName || 'shell';
  tab.root = leaf;
  state.tabs.push(tab);
  activateTab(tab);
  renderTab(tab);
  focusPane(leaf);
  saveSession();
}

function activateTab(tab) {
  state.activeTab = tab;
  el.content.replaceChildren(tab.contentEl);
  renderTabs();
  saveSession();
  if (tab.kind === 'agents') {
    const visible = [...tab.centerLeaves].find((l) => l.el.style.display !== 'none');
    if (visible) {
      visible.fit.fit();
      visible.term.focus();
    }
    return;
  }
  allLeaves(tab.root).forEach((leaf) => leaf.fit.fit());
  if (tab.activePane) focusPane(tab.activePane);
  else focusPane(firstLeaf(tab.root));
}

// Disposes the terminals of a tab whose shells are being handed to another
// window: same as closing, minus the one thing that must not happen — killing
// the shells, which the other window is about to adopt.
function releaseLeaves(tab) {
  for (const leaf of allLeaves(tab.root)) {
    if (leaf.ptyId) {
      panesByPty.delete(leaf.ptyId);
      api.ptyOrphan(leaf.ptyId);
    }
    try {
      leaf.term.dispose();
    } catch {}
    leaf.el.remove();
  }
}

function closeTab(tab, { killPtys = true } = {}) {
  if (tab.kind === 'agents') {
    for (const leaf of tab.centerLeaves) {
      try {
        const agent = agentsByPty.get(leaf.ptyId);
        if (agent) {
          agentsByPty.delete(leaf.ptyId);
          globalAgents.delete(agent.id);
        }
        if (leaf.ptyId) {
          panesByPty.delete(leaf.ptyId);
          api.ptyKill(leaf.ptyId);
        }
        leaf.term.dispose();
        leaf.el.remove();
      } catch {}
    }
    api.agentsSelectDiff(null);
    api.agentsReleaseTab();
  } else if (killPtys) {
    allLeaves(tab.root).forEach(destroyLeaf);
  }
  const i = state.tabs.indexOf(tab);
  state.tabs.splice(i, 1);
  if (state.tabs.length === 0) {
    window.close();
    return;
  }
  if (state.activeTab === tab) {
    activateTab(state.tabs[Math.max(0, i - 1)]);
  } else {
    renderTabs();
  }
  saveSession();
}

function renderTabs() {
  rebuildingStrip = true;
  try {
    paintTabs();
  } finally {
    rebuildingStrip = false;
  }
}

function paintTabs() {
  el.tabstrip.replaceChildren(
    ...state.tabs.map((tab) => {
      const t = document.createElement('div');
      t.className = 'tab' + (tab === state.activeTab ? ' active' : '');
      t.tabData = tab;
      if (tab.kind === 'agents') {
        const dot = document.createElement('span');
        dot.className = 'tab-dot st-' + worstAgentStatus(tab);
        t.appendChild(dot);
      }
      const pane = tab.activePane;
      t.title = [pane?.cwd, pane?.profileName].filter(Boolean).join('\n') || tabLabel(tab);
      if (pane?.cwd) t.dataset.tipMono = ''; // the first line is a path
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = tabLabel(tab);
      // A zoomed tab looks like a tab with one pane, and the difference matters:
      // the other shells are still running behind it.
      if (tab.zoomedPane) {
        const mark = document.createElement('span');
        mark.className = 'tab-zoom';
        mark.textContent = '⤢';
        mark.title = 'One pane is zoomed';
        title.appendChild(mark);
      }
      const close = document.createElement('button');
      close.className = 'close';
      close.textContent = '×';
      close.title = 'Close tab';
      // stopPropagation on mousedown: otherwise the tab re-activates and the
      // tab strip re-renders, destroying this button before 'click' can fire
      close.addEventListener('mousedown', (ev) => ev.stopPropagation());
      close.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeTab(tab);
      });
      t.append(title, close);
      t.addEventListener('mousedown', (ev) => {
        if (ev.button !== 0) return;
        activateTab(tab);
        beginTabDrag(ev, tab);
      });
      // The name is the tab's own, so it is edited on the tab — double-click is
      // where every other application puts this
      title.addEventListener('dblclick', (ev) => {
        ev.preventDefault();
        startTabRename(tab);
      });
      t.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        openTabMenu(tab, ev.clientX, ev.clientY);
      });
      return t;
    })
  );
  reapplyRename();
  document.title = state.activeTab ? `${tabLabel(state.activeTab)} — Frost` : 'Frost';
  // With many tabs the strip scrolls, so the one you just switched to has to be
  // brought into view or it may be off-screen entirely.
  el.tabstrip.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// A tab strip is horizontal, so a vertical wheel should scroll it sideways —
// otherwise a mouse without a tilt wheel can't reach the overflow at all.
el.tabstrip.addEventListener(
  'wheel',
  (ev) => {
    if (!ev.deltaY || ev.shiftKey) return;
    if (el.tabstrip.scrollWidth <= el.tabstrip.clientWidth) return;
    ev.preventDefault();
    el.tabstrip.scrollLeft += ev.deltaY;
  },
  { passive: false }
);

// ---------- dragging a tab ----------
// One gesture, three outcomes, decided by where the pointer is: along the strip
// reorders, over another Frost window hands the tab to it, anywhere else opens
// it in a window of its own. Mouse events rather than HTML5 drag-and-drop — the
// strip is the app's own chrome, and native drag brings a ghost image, a
// drop-effect cursor and no say over either.
//
// What follows the cursor is a copy of the tab drawn in a window of its own,
// asked for over IPC — not an element in this page. A page cannot paint outside
// its window, so an in-page copy vanished at the window edge, which is precisely
// where dragging a tab out becomes interesting. The tab left behind stays as a
// dimmed placeholder showing where it would land if the drag ended here.

const DRAG_SLOP = 5; // enough that a click with a shaky hand is still a click
const DETACH_DISTANCE = 56; // below the strip: far enough not to be a wobble
const DROP_PROBE_MS = 80; // how often to ask main what is under the pointer

const tabDrag = {
  tab: null,
  el: null,
  ghost: false, // whether the overlay window is currently showing
  width: 0, // the dragged tab's size, so the copy matches it
  height: 0,
  grabX: 0, // where in the tab it was grabbed, so the copy sits under the cursor
  grabY: 0,
  startX: 0,
  startY: 0,
  live: false,
  moved: false,
  mode: 'reorder', // reorder | detach | merge
  target: null, // the window a merge would go to
  session: 0, // a drop-target answer that arrives after the drop is discarded
  lastX: 0, // where the pointer was last seen, for the probe that runs on a timer
  lastY: 0,
  timer: null
};

function tabElementOf(tab) {
  return [...el.tabstrip.children].find((n) => n.tabData === tab) || null;
}

function beginTabDrag(ev, tab) {
  const node = tabElementOf(tab);
  if (!node) return;
  const r = node.getBoundingClientRect();
  tabDrag.tab = tab;
  tabDrag.el = node;
  tabDrag.grabX = ev.clientX - r.left;
  tabDrag.grabY = ev.clientY - r.top;
  tabDrag.width = r.width;
  tabDrag.height = r.height;
  tabDrag.startX = ev.clientX;
  tabDrag.startY = ev.clientY;
  tabDrag.live = false;
  tabDrag.moved = false;
  tabDrag.mode = 'reorder';
  tabDrag.target = null;
  tabDrag.session++;
  tabDrag.lastX = ev.clientX;
  tabDrag.lastY = ev.clientY;
  window.addEventListener('mousemove', onTabDragMove);
  window.addEventListener('mouseup', endTabDrag, { once: true });
}

// The overlay is told the colours rather than reading the theme itself: it is a
// separate window with no idea what this one looks like, and a tab that does not
// match the strip it came from reads as a different object.
function ghostPaint() {
  const t = state.theme || {};
  return {
    accent: t.accent || '#80a8ff',
    fg: t.terminal?.foreground || '#ffffff',
    bg: t.terminal?.background || '#24262e',
    font: t.font?.family || ''
  };
}

function showDragGhost(ev) {
  const d = tabDrag;
  api.ghostShow({
    label: tabLabel(d.tab),
    mode: d.mode,
    x: ev.clientX - d.grabX,
    y: ev.clientY - d.grabY,
    width: d.width,
    height: d.height,
    ...ghostPaint()
  });
  d.ghost = true;
}

// What the drag means right now. Another window under the pointer wins over
// everything: its tab strip sits at the same height as this window's, so height
// alone would call aiming at it a reorder — which is what it did, and dropping a
// tab on another window's tabs did nothing. Height only chooses between
// reordering here and opening a window of its own.
function dragModeFor(y) {
  const d = tabDrag;
  if (d.tab?.kind === 'agents') return 'reorder'; // one per app, nowhere to go
  if (d.target) return 'merge';
  const strip = el.tabstrip.getBoundingClientRect();
  return y > strip.bottom + DETACH_DISTANCE ? 'detach' : 'reorder';
}

// Position and outline travel together: both are what the copy is saying.
function moveDragGhost() {
  const d = tabDrag;
  if (!d.ghost) return;
  api.ghostMove({ x: d.lastX - d.grabX, y: d.lastY - d.grabY, mode: d.mode });
}

const paintDragGhost = moveDragGhost;

// Only main can say what is under the pointer: a window knows nothing about the
// others, and the one being dropped onto is a different process, which never
// sees the drag — the pointer stays captured by the window it started in.
//
// On a timer rather than per mouse-move, because the answer decides what the
// copy under the cursor says it will do, and a pointer held still over another
// window still has to be told about it. The drop itself asks again: this is the
// label, not the decision.
function startDropProbe() {
  clearInterval(tabDrag.timer);
  const probe = () => {
    const d = tabDrag;
    if (!d.live || !d.tab) return;
    const session = d.session;
    api.tabDropTarget({ x: d.lastX, y: d.lastY }).then((hit) => {
      // The drop already happened, or another drag started: this answer is stale
      if (tabDrag.session !== session || !tabDrag.live) return;
      tabDrag.target = hit || null;
      tabDrag.mode = dragModeFor(tabDrag.lastY);
      paintDragGhost();
    });
  };
  // Once immediately: until the first answer arrives, a pointer over another
  // window's strip looks like one over this one, and the tabs here would shuffle
  // for as long as that took.
  probe();
  tabDrag.timer = setInterval(probe, DROP_PROBE_MS);
}

function onTabDragMove(ev) {
  const d = tabDrag;
  if (!d.tab) return;
  if (!d.live) {
    if (Math.abs(ev.clientX - d.startX) < DRAG_SLOP && Math.abs(ev.clientY - d.startY) < DRAG_SLOP) return;
    d.live = true;
    d.el.classList.add('dragging');
    d.lastX = ev.clientX;
    d.lastY = ev.clientY;
    d.mode = dragModeFor(ev.clientY);
    showDragGhost(ev);
    startDropProbe();
  }
  d.lastX = ev.clientX;
  d.lastY = ev.clientY;

  d.mode = dragModeFor(ev.clientY);
  moveDragGhost();
  if (d.mode !== 'reorder') return;

  // Reorder against whichever tab the pointer is over, moving the element
  // itself: a strip rebuilt mid-drag would throw away the node being dragged.
  const over = [...el.tabstrip.children].find((n) => {
    if (n === d.el) return false;
    const r = n.getBoundingClientRect();
    return ev.clientX >= r.left && ev.clientX <= r.right;
  });
  if (!over) return;
  // Both positions are looked up in state.tabs, through the tab each node
  // carries, rather than taken from where the nodes sit in the strip. Those two
  // agreed until they didn't: one node left in the strip for a tab no longer in
  // state put every position after it one out, and splicing at a position past
  // the end returns nothing — which spliced an `undefined` into state.tabs.
  // From there every walk over the tabs threw on it, renderTabs included, so
  // the strip stopped repainting entirely while the shells carried on running
  // behind it. A node that answers to no tab now simply isn't a drop position.
  const from = state.tabs.indexOf(d.tab);
  const to = state.tabs.indexOf(over.tabData);
  if (from < 0 || to < 0 || from === to) return;
  el.tabstrip.insertBefore(d.el, to > from ? over.nextSibling : over);
  const [moved] = state.tabs.splice(from, 1);
  state.tabs.splice(to, 0, moved);
  d.moved = true;
}

async function endTabDrag(ev) {
  window.removeEventListener('mousemove', onTabDragMove);
  clearInterval(tabDrag.timer);
  tabDrag.timer = null;
  const { tab, el: node, ghost, live, moved } = tabDrag;
  node?.classList.remove('dragging');
  if (ghost) api.ghostHide();
  tabDrag.tab = null;
  tabDrag.el = null;
  tabDrag.ghost = false;
  tabDrag.target = null;
  tabDrag.session++; // any drop-target answer still in flight is now stale
  if (!live) return;
  const settle = () => {
    if (!moved) return;
    renderTabs(); // titles and the active marker, now in the new order
    saveSession();
  };
  // Asked once more here rather than trusting the last answer from the drag:
  // those are throttled, so the final position — the only one that decides
  // anything — may never have been asked about. Asked even when the pointer is
  // at strip height, because another window's strip is at strip height too.
  const hit = tab.kind === 'agents' ? null : await api.tabDropTarget({ x: ev.clientX, y: ev.clientY });
  if (hit) {
    moveTabToWindow(tab, hit);
    return;
  }
  const strip = el.tabstrip.getBoundingClientRect();
  const offStrip = tab.kind !== 'agents' && ev.clientY > strip.bottom + DETACH_DISTANCE;
  if (offStrip) detachTab(tab);
  else settle();
}

// ---------- renaming a tab ----------
// A tab says directory · branch, which is the right answer until several tabs
// are in the same repo — then the thing that tells them apart is what you are
// doing in each, and only you know that. A name typed here sticks until it is
// cleared, survives a restart, and travels with the tab to another window.

// A rename in progress is a DOM node living inside the strip, and the strip is
// rebuilt every time a pane reports a new title — which, with a claude session
// in a tab, is constantly. Removing a focused input fires blur, and blur is
// what commits the name, so a rebuild used to end the rename in the middle of a
// word and save whatever had been typed by then. A blur from an input that is
// no longer in the document is the rebuild talking, not the user: the box is
// carried into the new strip with its text and caret where they were, and only
// a blur from a box still on screen means the name is finished.
let renaming = null; // { tab, input, finish }
let rebuildingStrip = false;

function reapplyRename() {
  if (!renaming) return;
  // The tab was closed or handed to another window while its name was being
  // typed. There is nothing left to name, and the box must not outlive it.
  if (!state.tabs.includes(renaming.tab)) {
    const r = renaming;
    renaming = null;
    r.finish(false, { rerender: false });
    return;
  }
  const titleEl = tabElementOf(renaming.tab)?.querySelector('.title');
  if (!titleEl) return;
  const { input } = renaming;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  titleEl.replaceWith(input);
  input.focus();
  try {
    input.setSelectionRange(start, end);
  } catch {}
}

function startTabRename(tab) {
  // One name at a time, and settled first: committing the other one rebuilds
  // the strip, and the nodes looked up before that would be the old ones.
  if (renaming) renaming.finish(true);
  const node = tabElementOf(tab);
  const titleEl = node?.querySelector('.title');
  if (!titleEl || node.querySelector('.tab-rename')) return;
  const input = document.createElement('input');
  input.className = 'tab-rename';
  input.type = 'text';
  input.spellcheck = false;
  input.value = tabLabel(tab);
  input.title = 'Enter to name it, Esc to cancel, empty to go back to the live title';
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit, { rerender = true } = {}) => {
    if (done) return;
    done = true;
    if (renaming?.input === input) renaming = null;
    if (commit) {
      const value = input.value.trim().slice(0, 60);
      // Empty is not a name, it is "stop naming it": the live directory · branch
      // title comes back rather than the tab going blank.
      tab.customTitle = value && value !== tab.title ? value : null;
      saveSession();
    }
    if (rerender) renderTabs();
    activePane()?.term.focus();
  };
  renaming = { tab, input, finish };
  input.addEventListener('mousedown', (ev) => ev.stopPropagation());
  input.addEventListener('dblclick', (ev) => ev.stopPropagation());
  // Taking the input out of the document blurs it, and blur is what commits the
  // name — so a repaint would settle a name the user is still typing. Only a
  // blur that is not the repaint's doing means they have gone somewhere else.
  input.addEventListener('blur', () => {
    if (!rebuildingStrip) finish(true);
  });
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation(); // the window-level shortcut handler is not wanted here
    if (ev.key === 'Enter') {
      ev.preventDefault();
      finish(true);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      finish(false);
    }
  });
}

// ---------- moving a tab to its own window ----------
// The shells are not restarted: main keeps them running and re-points their
// output at the new window, so whatever was running keeps running and the
// directory is still the directory. The scrollback is copied across as text,
// because a terminal's buffer lives in the renderer that drew it.

function serializeLeafForMove(leaf) {
  let text = '';
  try {
    // Loaded only here: a pane that is never moved should not carry the addon
    const ser = new SerializeAddon.SerializeAddon();
    leaf.term.loadAddon(ser);
    // Enough history to keep the move from reading as a wipe, bounded because
    // this crosses an IPC boundary as a string
    text = ser.serialize({ scrollback: 1000 });
    ser.dispose();
  } catch {}
  return {
    t: 'leaf',
    ptyId: leaf.ptyId,
    profileId: leaf.profileId || null,
    cwd: leaf.cwd || null,
    branch: leaf.branch || null,
    oscTitle: leaf.oscTitle || null,
    text
  };
}

function serializeNodeForMove(node) {
  if (node.type === 'leaf') return serializeLeafForMove(node);
  return {
    t: 'split',
    dir: node.dir,
    sizes: node.sizes.slice(),
    children: node.children.map(serializeNodeForMove)
  };
}

// Everything a tab needs to exist somewhere else: its name, its layout, and per
// pane the shell to claim plus the text that was on screen. Taking it hands the
// shells over and closes the tab here — the caller decides where they go next.
function takeTab(tab) {
  unzoom(tab);
  const payload = {
    title: tab.title,
    customTitle: tab.customTitle || null,
    root: serializeNodeForMove(tab.root)
  };
  releaseLeaves(tab);
  closeTab(tab, { killPtys: false });
  return payload;
}

function movableTab(tab) {
  if (!tab || !tab.root) return false;
  if (tab.kind === 'agents') {
    toast('The agent view is one per app — it stays in this window');
    return false;
  }
  return true;
}

function detachTab(tab) {
  if (!movableTab(tab)) return;
  if (state.tabs.length < 2) {
    toast('That is the only tab in this window');
    return;
  }
  api.tabDetach(takeTab(tab));
}

// Dropped on another Frost window. The last tab may leave this way — unlike a
// move to a new window, which would only shuffle the same tab between two
// windows: here the window it lands in already exists, so this one closing is
// the point rather than a side effect.
function moveTabToWindow(tab, target) {
  if (!movableTab(tab)) return;
  api.tabMoveTo(target.frostId, takeTab(tab));
}

async function buildAdoptedNode(saved, depth = 0) {
  if (!isSplit(saved, depth)) {
    return createPane({
      profileId: saved?.profileId || undefined,
      cwd: saved?.cwd || undefined,
      adopt: saved?.ptyId ? saved : null
    });
  }
  const children = [];
  for (const c of saved.children) children.push(await buildAdoptedNode(c, depth + 1));
  return {
    type: 'split',
    dir: saved.dir === 'col' ? 'col' : 'row',
    children,
    sizes: savedSizes(saved.sizes, children.length),
    el: null
  };
}

// Runs in the window main opened to receive the tab, before anything else is
// created — this window exists for this tab and nothing else.
async function adoptTab(payload) {
  const tab = {
    id: 'tab-' + ++tabCounter,
    title: '',
    customTitle: payload.customTitle || null,
    root: null,
    activePane: null,
    contentEl: document.createElement('div')
  };
  tab.contentEl.className = 'tab-content';
  tab.root = await buildAdoptedNode(payload.root);
  const first = firstLeaf(tab.root);
  tab.title = payload.title || paneLabel(first);
  state.tabs.push(tab);
  activateTab(tab);
  renderTab(tab);
  focusPane(first);
  saveSession();
}

// A tab dropped on this window by another one. The window is already up, so
// unlike the boot-time adoption this arrives as a message.
api.onTabAdopt((payload) => {
  if (payload) adoptTab(payload);
});

// ---------- the tab's own menu ----------

function closeTabMenu() {
  el.tabMenu.classList.remove('open');
}

function openTabMenu(tab, x, y) {
  const items = [
    { label: 'Rename…', run: () => startTabRename(tab) },
    {
      label: 'Duplicate',
      run: () => {
        const pane = tab.activePane || firstLeaf(tab.root);
        newTab({ profileId: pane?.profileId, cwd: pane?.cwd });
      }
    },
    { label: 'Move to a new window', run: () => detachTab(tab) },
    { label: 'Close', run: () => closeTab(tab) }
  ];
  if (tab.kind === 'agents') items.splice(1, 2); // neither applies to the agent view
  el.tabMenu.replaceChildren(
    ...items.map(({ label, run }) => {
      const item = document.createElement('button');
      item.className = 'menu-item';
      const name = document.createElement('span');
      name.textContent = label;
      item.appendChild(name);
      item.addEventListener('click', () => {
        closeTabMenu();
        run();
      });
      return item;
    })
  );
  el.tabMenu.classList.add('open');
  // Placed after it is measurable, and pulled back inside the window if the
  // click was near the right edge
  const r = el.tabMenu.getBoundingClientRect();
  el.tabMenu.style.left = Math.round(Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  el.tabMenu.style.top = Math.round(y + 4) + 'px';
}

window.addEventListener('mousedown', (ev) => {
  if (!el.tabMenu.contains(ev.target)) closeTabMenu();
});

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
