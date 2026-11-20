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
  if (tab.kind === 'agents') return takeAgentTab(tab);
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

// The agent view is one per app, but that is about how many there are, not
// where: it moves like any tab, and the window it lands in owns it.
function movableTab(tab) {
  return Boolean(tab && (tab.root || tab.kind === 'agents'));
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
  if (payload.kind === 'agents') return adoptAgentTab(payload);
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

