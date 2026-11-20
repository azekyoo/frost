// Tabs: opening and closing them, dragging one along the strip or out of the
// window, naming one by hand, and remembering the lot for next time.

// ---------- tabs ----------

async function newTab({ profileId, cwd, run } = {}) {
  const tab = {
    id: 'tab-' + ++tabCounter,
    title: '',
    root: null,
    activePane: null,
    contentEl: document.createElement('div')
  };
  tab.contentEl.className = 'tab-content';
  const leaf = await createPane({ profileId, cwd, run });
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
  gpuShowWithin(tab.contentEl);
  renderTabs();
  saveSession();
  markAgentsSeen();
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
    for (const leaf of tab.dockLeaves || []) {
      try {
        destroyLeaf(leaf);
      } catch {}
    }
    api.agentsSelectDiff(null);
    api.agentsReleaseTab();
  } else if (killPtys) {
    allLeaves(tab.root).forEach(destroyLeaf);
  }
  const i = state.tabs.indexOf(tab);
  if (state.tabs.length > 1) foldTabAway(tab);
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
  const previous = new Map(
    [...el.tabstrip.children].filter((n) => n.tabData && !n.classList.contains('leaving')).map((n) => [n.tabData, n])
  );
  // a tab that just opened grows into the strip; ones at boot are simply there
  const growNew = previous.size > 0 && !restoring && !reduceMotion.matches;
  const born = [];
  const fresh = state.tabs.map((tab) => {
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
    // a glide still running on the tab's old node carries on in the new one;
    // read while the old node is still in the document
    const old = previous.get(tab);
    if (old) carryAnimations(old, t);
    else if (growNew) born.push(t);
    return t;
  });
  // Closing tabs stay where they are, folding shut, until their animation is
  // done — taken out and put back, they would lose it. Everything else is
  // replaced, slotted in around them at the places they were closed from.
  for (const n of [...el.tabstrip.children]) if (!n.classList.contains('leaving')) n.remove();
  const order = [...fresh];
  for (const { node, index } of [...leavingTabs].sort((a, b) => a.index - b.index)) {
    if (node.isConnected) order.splice(Math.min(index, order.length), 0, node);
  }
  let ref = el.tabstrip.firstChild;
  for (const n of order) {
    if (n.classList.contains('leaving')) ref = n.nextSibling;
    else el.tabstrip.insertBefore(n, ref);
  }
  born.forEach(growTab);
  reapplyRename();
  document.title = state.activeTab ? `${tabLabel(state.activeTab)} — Frost` : 'Frost';
  // With many tabs the strip scrolls, so the one you just switched to has to be
  // brought into view or it may be off-screen entirely.
  el.tabstrip.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ---------- tab motion ----------
// Opening a tab grows it out of nothing and closing one folds it shut, the
// tabs beside it gliding over as it does. Animated as real width rather than a
// transform, so the neighbours move because the layout moves.

const TAB_MOTION_MS = 180;
const leavingTabs = []; // { node, index }: closed tabs still folding shut

function tabFoldFrames(node) {
  const cs = getComputedStyle(node);
  const w = node.offsetWidth + 'px';
  return [
    { minWidth: '0px', maxWidth: '0px', paddingLeft: '0px', paddingRight: '0px', opacity: 0 },
    { minWidth: w, maxWidth: w, paddingLeft: cs.paddingLeft, paddingRight: cs.paddingRight, opacity: 1 }
  ];
}

function growTab(node) {
  node.classList.add('motion-clip');
  const a = node.animate(tabFoldFrames(node), { duration: TAB_MOTION_MS, easing: MOTION_EASE });
  a.id = 'motion-tab-grow';
  a.finished.then(() => node.classList.remove('motion-clip'), () => {});
}

function foldTabAway(tab) {
  if (reduceMotion.matches) return;
  const node = tabElementOf(tab);
  if (!node) return;
  const index = [...el.tabstrip.children].indexOf(node);
  node.getAnimations().forEach((a) => a.cancel());
  const frames = tabFoldFrames(node).reverse();
  node.classList.remove('active');
  node.classList.add('leaving', 'motion-clip');
  const entry = { node, index };
  leavingTabs.push(entry);
  const a = node.animate(frames, { duration: TAB_MOTION_MS, easing: MOTION_EASE, fill: 'forwards' });
  const done = () => {
    leavingTabs.splice(leavingTabs.indexOf(entry), 1);
    node.remove();
  };
  a.finished.then(done, done);
}

// Tabs a drag passes slide aside rather than jumping: note where each shows,
// make the move, then play each from its old spot to its new one.
function tabSlideOffset(node) {
  const t = getComputedStyle(node).transform;
  return t && t !== 'none' ? new DOMMatrixReadOnly(t).m41 : 0;
}

function slideTabs(change) {
  const nodes = [...el.tabstrip.children].filter((n) => !n.classList.contains('leaving'));
  const from = new Map(nodes.map((n) => [n, n.getBoundingClientRect().left]));
  change();
  for (const n of nodes) n.getAnimations().forEach((a) => a.id === 'motion-tab-slide' && a.cancel());
  if (reduceMotion.matches) return;
  for (const n of nodes) {
    const dx = from.get(n) - n.getBoundingClientRect().left;
    if (Math.abs(dx) < 0.5) continue;
    const a = n.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], {
      duration: TAB_MOTION_MS,
      easing: MOTION_EASE
    });
    a.id = 'motion-tab-slide';
  }
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

