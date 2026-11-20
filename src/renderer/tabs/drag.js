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
  // the accent on show, which under another design is that design's own
  const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim();
  return {
    accent: /^#[0-9a-f]{6}$/i.test(accent) ? accent : t.accent || '#80a8ff',
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
function dragModeFor(x, y) {
  const d = tabDrag;
  if (d.target) return 'merge';
  return wantsOwnWindow(x, y) ? 'detach' : 'reorder';
}

// Pulled well below the strip, or out of the window any way at all. Only
// downwards used to count, so a tab dragged off the side, or up over the top,
// came back to where it was: still a reorder, and with no tab out there to be
// reordered against, nothing happened.
function wantsOwnWindow(x, y) {
  const strip = el.tabstrip.getBoundingClientRect();
  const outside = x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight;
  return outside || y > strip.bottom + DETACH_DISTANCE;
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
      tabDrag.mode = dragModeFor(tabDrag.lastX, tabDrag.lastY);
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
    d.mode = dragModeFor(ev.clientX, ev.clientY);
    showDragGhost(ev);
    startDropProbe();
  }
  d.lastX = ev.clientX;
  d.lastY = ev.clientY;

  d.mode = dragModeFor(ev.clientX, ev.clientY);
  moveDragGhost();
  if (d.mode !== 'reorder') return;

  // Reorder against whichever tab the pointer is over, moving the element
  // itself: a strip rebuilt mid-drag would throw away the node being dragged.
  // (judged by where tabs sit, not where a slide is showing them mid-way)
  const over = [...el.tabstrip.children].find((n) => {
    if (n === d.el || n.classList.contains('leaving')) return false;
    const r = n.getBoundingClientRect();
    const shift = tabSlideOffset(n);
    return ev.clientX >= r.left - shift && ev.clientX <= r.right - shift;
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
  slideTabs(() => el.tabstrip.insertBefore(d.el, to > from ? over.nextSibling : over));
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
  const hit = await api.tabDropTarget({ x: ev.clientX, y: ev.clientY });
  if (hit) {
    moveTabToWindow(tab, hit);
    return;
  }
  if (wantsOwnWindow(ev.clientX, ev.clientY)) detachTab(tab);
  else settle();
}

