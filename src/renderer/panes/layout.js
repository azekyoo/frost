// ---------- zooming a pane ----------
// Splitting is cheap, so panes get small; then one of them is where the work is
// and the others are context you want back in a keystroke. Zoom lays the focused
// pane over its tab rather than rebuilding the layout: the tree, the sizes and
// every other shell are untouched, which is what makes it a view state that can
// be turned off without anything having moved.

function setPaneZoom(tab, leaf) {
  if (!tab || tab.kind === 'agents') return;
  const previous = tab.zoomedPane || null;
  if (previous) previous.el.classList.remove('zoomed');
  tab.zoomedPane = leaf || null;
  if (leaf) leaf.el.classList.add('zoomed');
  tab.contentEl.classList.toggle('has-zoom', Boolean(leaf));
  renderTabs(); // the strip carries the marker: a zoomed tab hides its own splits
  // The pane changed size, so the shell it holds has a different window than it
  // did a moment ago and has to be told
  const affected = leaf || previous;
  if (affected) requestAnimationFrame(() => affected.fit.fit());
}

// Anything that changes the layout has to let go of the zoom first, or it
// changes a layout nobody can see.
function unzoom(tab) {
  if (tab?.zoomedPane) setPaneZoom(tab, null);
}

function toggleZoom() {
  const tab = state.activeTab;
  if (!tab || tab.kind === 'agents' || !tab.root) return;
  if (tab.zoomedPane) {
    setPaneZoom(tab, null);
    return;
  }
  const leaf = tab.activePane || firstLeaf(tab.root);
  // One pane already fills the tab, so zooming it would look like nothing
  // happened. Says how to get a second one rather than only that there is not:
  // zoom is the answer to a split layout, so whoever presses it here has most
  // likely not met splitting yet.
  if (!leaf || allLeaves(tab.root).length < 2) {
    toast(osText('Zoom fills the tab with one terminal — split first with Alt+Shift+= or Alt+Shift+-', 'Zoom fills the tab with one terminal — split first with Cmd+D or Cmd+Shift+D'), {
      ms: 6000
    });
    return;
  }
  setPaneZoom(tab, leaf);
  focusPane(leaf);
}

// ---------- resizing panes from the keyboard ----------
// The dividers can be dragged, which needs a mouse, a small target and a steady
// hand. These move the same boundary a step at a time.

const RESIZE_STEP = 0.06; // of the split's own total, so it feels the same at any depth
const RESIZE_MIN = 0.08; // the floor the divider drag uses too

// The nearest ancestor split running along the axis being resized, and which of
// its children the pane sits inside — a pane deep in a column stack still
// widens by moving the boundary of the row split above it.
function splitAlong(tab, leaf, dir) {
  const wanted = dir === 'left' || dir === 'right' ? 'row' : 'col';
  let node = leaf;
  let parent = tab.root === node ? null : findParent(tab.root, node);
  while (parent) {
    if (parent.dir === wanted) return { split: parent, index: parent.children.indexOf(node) };
    node = parent;
    parent = tab.root === node ? null : findParent(tab.root, node);
  }
  return null;
}

function resizePane(dir) {
  const tab = state.activeTab;
  if (!tab || tab.kind === 'agents' || !tab.activePane) return;
  // A zoomed pane has no visible neighbours to take space from
  if (tab.zoomedPane) return;
  const found = splitAlong(tab, tab.activePane, dir);
  if (!found) return;
  const { split, index } = found;
  const last = split.children.length - 1;
  const forward = dir === 'right' || dir === 'down';
  // The boundary this pane owns in that direction — and if it has none, because
  // it is the last child, the one on its other side. Moving that one the same
  // way shrinks the pane, which is what "the edge moves right" means when the
  // pane is already against the wall.
  const edge = forward ? (index < last ? index : index - 1) : index > 0 ? index - 1 : index;
  if (edge < 0 || edge >= last + 1) return;
  const sum = split.sizes.reduce((a, b) => a + b, 0);
  const step = (forward ? 1 : -1) * RESIZE_STEP * sum;
  const a = split.sizes[edge] + step;
  const b = split.sizes[edge + 1] - step;
  if (a < RESIZE_MIN || b < RESIZE_MIN) return; // already as far as it goes
  split.sizes[edge] = a;
  split.sizes[edge + 1] = b;
  const kids = [...split.el.children].filter((c) => !c.classList.contains('divider'));
  kids[edge].style.flex = `${a} 1 0%`;
  kids[edge + 1].style.flex = `${b} 1 0%`;
  saveSession(); // each pane refits itself: they are watched for resize
}

// ---------- pane motion ----------
// A split or a close changes the layout in one step, and the terminals are
// refitted to their final sizes straight away: animating real sizes would
// resize every shell on every frame. What moves instead is a clip — each pane
// shows the area it had a moment ago and opens out to the area it has now, so a
// new pane unfolds from the one it split off and the panes beside a closed one
// grow over the space it left.

const PANE_MOTION_MS = 200;

function paneRects(tab) {
  return new Map(allLeaves(tab.root).map((leaf) => [leaf, leaf.el.getBoundingClientRect()]));
}

// A rect of no width (or no height) on the side of `rect` that faces `toward`:
// where a new pane starts from.
function edgeFacing(rect, toward) {
  const e = { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
  if (toward.right <= rect.left + 1) e.right = rect.left;
  else if (toward.left >= rect.right - 1) e.left = rect.right;
  else if (toward.bottom <= rect.top + 1) e.bottom = rect.top;
  else e.top = rect.bottom;
  return e;
}

// `born` is a pane that did not exist before; it unfolds from `origin`, the pane it split off.
function revealPanes(tab, before, born = null, origin = null) {
  if (reduceMotion.matches || tab !== state.activeTab) return;
  const originRect = origin?.el.getBoundingClientRect();
  for (const leaf of allLeaves(tab.root)) {
    const now = leaf.el.getBoundingClientRect();
    if (now.width < 1 || now.height < 1) continue;
    let was = before.get(leaf);
    if (leaf === born && originRect) was = edgeFacing(now, originRect);
    if (!was || (leaf !== born && (was.width < 1 || was.height < 1))) continue;
    const top = Math.max(0, was.top - now.top);
    const right = Math.max(0, now.right - was.right);
    const bottom = Math.max(0, now.bottom - was.bottom);
    const left = Math.max(0, was.left - now.left);
    if (top + right + bottom + left < 1) continue;
    if (top + bottom >= now.height || left + right >= now.width) {
      if (leaf !== born) continue; // no overlap to grow from: just be there
    }
    const round = getComputedStyle(leaf.el).borderTopLeftRadius;
    leaf.el.getAnimations().forEach((a) => a.id === 'motion-pane' && a.cancel());
    const a = leaf.el.animate(
      [
        { clipPath: `inset(${top}px ${right}px ${bottom}px ${left}px round ${round})`, opacity: leaf === born ? 0.4 : 1 },
        { clipPath: `inset(0px 0px 0px 0px round ${round})`, opacity: 1 }
      ],
      { duration: PANE_MOTION_MS, easing: MOTION_EASE }
    );
    a.id = 'motion-pane';
  }
}

function renderTab(tab) {
  tab.contentEl.replaceChildren(renderNode(tab.root));
  allLeaves(tab.root).forEach((leaf) => leaf.fit.fit());
}

function focusPane(node) {
  const tab = tabOfPane(node);
  if (!tab) return;
  tab.activePane = node;
  document.querySelectorAll('.pane.focused').forEach((p) => p.classList.remove('focused'));
  node.el.classList.add('focused');
  // focusing can make a TUI redraw; that repaint isn't the agent working
  if (node.ptyId) api.ptyMute(node.ptyId);
  node.term.focus();
  refreshPaneTitle(node);
}

async function splitPane(dir) {
  const tab = state.activeTab;
  if (!tab || !tab.activePane) return;
  unzoom(tab); // a new pane hidden behind a zoomed one reads as a split that failed
  const target = tab.activePane;
  // a split keeps the shell and directory you were already in
  const newLeaf = await createPane({ profileId: target.profileId, cwd: target.cwd });
  const parent = tab.root === target ? null : findParent(tab.root, target);

  if (parent && parent.dir === dir) {
    const i = parent.children.indexOf(target);
    parent.children.splice(i + 1, 0, newLeaf);
    const half = parent.sizes[i] / 2;
    parent.sizes[i] = half;
    parent.sizes.splice(i + 1, 0, half);
  } else {
    const split = { type: 'split', dir, children: [target, newLeaf], sizes: [1, 1], el: null };
    if (!parent) {
      tab.root = split;
    } else {
      parent.children[parent.children.indexOf(target)] = split;
    }
  }
  const before = paneRects(tab);
  renderTab(tab);
  revealPanes(tab, before, newLeaf, target);
  focusPane(newLeaf);
  saveSession();
}

function destroyLeaf(node) {
  if (node.ptyId) {
    panesByPty.delete(node.ptyId);
    api.ptyKill(node.ptyId);
  }
  node.term.dispose();
  node.el.remove();
}

function removePane(node, { killPty = true } = {}) {
  const tab = tabOfPane(node);
  if (!tab) return;
  unzoom(tab);
  const before = paneRects(tab); // measured while the pane is still there

  if (killPty) destroyLeaf(node);
  else {
    node.term.dispose();
    node.el.remove();
  }

  if (tab.root === node) {
    closeTab(tab, { killPtys: false });
    return;
  }

  const parent = findParent(tab.root, node);
  const i = parent.children.indexOf(node);
  parent.children.splice(i, 1);
  parent.sizes.splice(i, 1);

  if (parent.children.length === 1) {
    const survivor = parent.children[0];
    if (tab.root === parent) {
      tab.root = survivor;
    } else {
      const gp = findParent(tab.root, parent);
      gp.children[gp.children.indexOf(parent)] = survivor;
    }
  }
  renderTab(tab);
  revealPanes(tab, before);
  focusPane(firstLeaf(tab.root));
  saveSession();
}
