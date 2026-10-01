// Agent mode: the rail of running agents, their status, the spaces they are
// spawned in, and the Claude Code sessions that can be picked up again.

// ---------- agent mode ----------

const globalAgents = new Map(); // agentId -> agent {id,name,cwd,branch,git,ptyId,leaf,status,sessionId}
const agentsByPty = new Map(); // ptyId -> agent
const pendingNames = new Map(); // ptyId -> preferred display name
let claudeSessions = []; // recent Claude Code sessions [{id,cwd,title,branch,lastActive,exists}]
const STATUS_RANK = { blocked: 4, working: 3, done: 2, idle: 1, exited: 0 };

function agentTabs() {
  return state.tabs.filter((t) => t.kind === 'agents');
}

function worstAgentStatus() {
  let worst = 'idle';
  for (const a of globalAgents.values()) {
    if ((STATUS_RANK[a.status] ?? 0) > (STATUS_RANK[worst] ?? 0)) worst = a.status;
  }
  return worst;
}

// "Done" says the agent finished, not that you have looked. An agent that
// finishes out of sight stays unseen — bold in the rail — until its terminal is on screen in a focused window.
function agentOnScreen(agent) {
  if (!document.hasFocus() || document.hidden) return false;
  const t = state.activeTab;
  if (!t || !agent.leaf) return false;
  if (t.kind === 'agents') {
    if (t.dockShown === agent.leaf) return true;
    return t.centerLeaves.has(agent.leaf) && agent.leaf.el.style.display !== 'none';
  }
  return tabOfPane(agent.leaf) === t;
}

// Called wherever what's on screen can change: a tab, an agent, the window
// getting focus back.
function markAgentsSeen() {
  let changed = false;
  for (const a of globalAgents.values()) {
    if (a.unseen && agentOnScreen(a)) {
      a.unseen = false;
      changed = true;
    }
  }
  if (changed) renderAgentLists();
}

window.addEventListener('focus', () => markAgentsSeen());

function renderAgentLists() {
  for (const t of agentTabs()) renderAgentList(t);
  renderTabs();
}

// Agents are global, so a second agent tab renders a byte-identical list and
// clicking an agent in it jumps you to wherever its pane actually lives. It was
// never a second workspace — spaces are the grouping — so asking for one just
// returns you to the one that exists. That also makes the single diff watcher
// correct by construction rather than a race between tabs.
async function newAgentTab() {
  const existing = agentTabs()[0];
  if (existing) {
    activateTab(existing);
    return existing;
  }
  // Another window may already hold it; main focuses that one and tells us to
  // stand down rather than opening a duplicate here.
  const claim = await api.agentsClaimTab();
  if (!claim?.owned) return null;
  const tab = makeAgentTab();
  // default center terminal: cd anywhere and run `claude` — auto-registers
  const leaf = await createPane({ profileId: agentProfileId() });
  addCenterLeaf(tab, leaf, true);
  renderAgentList(tab);
  await refreshSessions();
  return tab;
}

function makeAgentTab() {
  const tab = {
    id: 'tab-' + ++tabCounter,
    kind: 'agents',
    title: 'agents',
    root: null,
    activePane: null,
    contentEl: document.createElement('div'),
    centerLeaves: new Set(),
    selected: null,
    els: {}
  };
  tab.contentEl.className = 'tab-content';
  buildAgentLayout(tab);
  state.tabs.push(tab);
  activateTab(tab);
  return tab;
}

// ---------- moving the agent view to another window ----------
// Its terminals go the way any tab's do — the shells are handed over, never
// restarted, and the screen text travels with them — plus who each agent is:
// the new window's list is built from its own panes, and a claude mid-turn
// won't say its name again for it. What the agent was doing (status, unread)
// comes along too, so a finished agent you haven't looked at stays bold.
function takeAgentTab(tab) {
  const shown = [...tab.centerLeaves].find((l) => l.el.style.display !== 'none');
  const leaves = [...tab.centerLeaves].map((leaf) => {
    const a = agentsByPty.get(leaf.ptyId);
    return {
      ...serializeLeafForMove(leaf),
      shown: leaf === shown,
      resumedSession: leaf.resumedSession || null,
      agent: a
        ? { agentId: a.id, name: a.name, cwd: a.cwd, branch: a.branch, git: a.git, sessionId: a.sessionId, status: a.status, unseen: a.unseen }
        : null
    };
  });
  const payload = {
    kind: 'agents',
    customTitle: tab.customTitle || null,
    diffMode: tab.diffMode,
    diffRepoPick: [...(tab.diffRepoPick || [])],
    leaves,
    // the docked shells go too, handed over like the center ones, each still
    // tied to its session by that session's place in the list above
    dock: [...tab.dockLeaves].map((leaf) => ({
      ...serializeLeafForMove(leaf),
      dockCwd: leaf.dockCwd,
      owner: [...tab.centerLeaves].indexOf(leaf.dockOwner)
    }))
  };
  for (const leaf of tab.dockLeaves) {
    if (leaf.ptyId) {
      panesByPty.delete(leaf.ptyId);
      api.ptyOrphan(leaf.ptyId);
    }
    try {
      leaf.term.dispose();
    } catch {}
    leaf.el.remove();
  }
  tab.dockLeaves.clear();
  for (const leaf of tab.centerLeaves) {
    const a = agentsByPty.get(leaf.ptyId);
    if (a) {
      agentsByPty.delete(leaf.ptyId);
      globalAgents.delete(a.id);
    }
    if (leaf.ptyId) {
      panesByPty.delete(leaf.ptyId);
      api.ptyOrphan(leaf.ptyId);
    }
    try {
      leaf.term.dispose();
    } catch {}
    leaf.el.remove();
  }
  // emptied first, so closing it lets go of the view without killing a shell
  tab.centerLeaves.clear();
  closeTab(tab, { killPtys: false });
  renderAgentLists();
  return payload;
}

async function adoptAgentTab(payload) {
  // the old window let go of it before sending, so this claim is the one
  await api.agentsClaimTab();
  const tab = makeAgentTab();
  // its own shells are on their way: none fresh in their place meanwhile
  tab.adopting = true;
  tab.customTitle = payload.customTitle || null;
  tab.diffRepoPick = new Map(payload.diffRepoPick || []);
  if (payload.diffMode) {
    tab.diffMode = payload.diffMode;
    tab.els.layout
      .querySelectorAll('.diff-toggle button')
      .forEach((b) => b.classList.toggle('active', b.dataset.mode === payload.diffMode));
  }
  let shownAgent = null;
  let shownLeaf = null;
  const centers = [];
  for (const saved of payload.leaves || []) {
    const leaf = await createPane({ profileId: saved.profileId || undefined, cwd: saved.cwd || undefined, adopt: saved });
    centers.push(leaf);
    leaf.resumedSession = saved.resumedSession;
    addCenterLeaf(tab, leaf, false);
    if (saved.shown) shownLeaf = leaf;
    // a shell that died in the gap came back fresh: no agent in it any more
    if (!saved.agent || leaf.ptyId !== saved.ptyId) continue;
    const agent = registerAgent({ ...saved.agent, ptyId: leaf.ptyId });
    if (!agent) continue;
    agent.status = saved.agent.status || agent.status;
    agent.unseen = Boolean(saved.agent.unseen);
    if (saved.shown) shownAgent = agent;
  }
  for (const saved of payload.dock || []) {
    const owner = centers[saved.owner];
    const leaf = await createPane({ profileId: saved.profileId || undefined, cwd: saved.cwd || saved.dockCwd || undefined, adopt: saved });
    // its session did not make the trip: nothing left to own it
    if (!owner) {
      destroyLeaf(leaf);
      continue;
    }
    addDockLeaf(tab, leaf, owner, saved.dockCwd);
  }
  tab.adopting = false;
  if (shownAgent) selectAgent(tab, shownAgent.id);
  else if (shownLeaf) setCenterVisible(tab, shownLeaf);
  if (!tab.centerLeaves.size) tab.els.empty.style.display = '';
  renderAgentLists();
  await refreshSessions();
}

function addCenterLeaf(tab, leaf, show) {
  tab.centerLeaves.add(leaf);
  leaf.el.classList.add('agent-pane');
  tab.els.empty.style.display = 'none';
  tab.els.center.appendChild(leaf.el);
  if (show) setCenterVisible(tab, leaf);
  else leaf.el.style.display = 'none';
}

function setCenterVisible(tab, leaf) {
  for (const l of tab.centerLeaves) l.el.style.display = l === leaf ? '' : 'none';
  syncDock(tab, leaf);
  markAgentsSeen();
  if (leaf.ptyId) api.ptyMute(leaf.ptyId);
  requestAnimationFrame(() => {
    leaf.fit.fit();
    leaf.term.focus();
  });
}

// ---------- agent layout ----------
// Four panes — the rail, the shell, the diff and the agent — laid out as columns
// of stacked panes, every one of them dragged by its grip to wherever it should
// go, and every gap between them dragged to size them. Sizes are in pixels as
// the user left them, but for the one that takes up the slack: the agent, in
// whichever column it is in, and in the others the pane at the foot. A window
// too small for the pixels squeezes them for display only, so a bigger one
// gives them back. Shared by every agent tab and remembered in theme.json.

const PANE_IDS = ['rail', 'shell', 'diff', 'agent'];
const PANE_MIN_W = { rail: 150, shell: 200, diff: 220, agent: 260 };
const PANE_MIN_H = { rail: 120, shell: 110, diff: 140, agent: 160 };

function defaultPaneLayout() {
  // the widths of the layout this replaced carry over, where there are any
  const old = state.theme?.agentLayout || {};
  return [
    { w: old.rail ?? 210, panes: [{ id: 'rail' }] },
    { w: old.diff ?? 340, panes: [{ id: 'shell', h: old.dock ?? 260 }, { id: 'diff' }] },
    { panes: [{ id: 'agent' }] }
  ];
}

function paneLayout() {
  const stored = state.theme?.agentLayout?.panes;
  // anything but every pane exactly once is a layout from somewhere else
  const ids = Array.isArray(stored) ? stored.flatMap((c) => (c?.panes || []).map((p) => p?.id)) : [];
  const valid = ids.length === PANE_IDS.length && PANE_IDS.every((id) => ids.includes(id));
  return valid ? structuredClone(stored) : defaultPaneLayout();
}

function savePaneLayout(cols) {
  state.theme.agentLayout = { ...state.theme.agentLayout, panes: cols };
  for (const t of agentTabs()) renderPaneLayout(t);
  saveTheme();
}

// The pane that takes up the slack in a column, and the column that does
const flexPaneOf = (col) => col.panes.find((p) => p.id === 'agent') || col.panes[col.panes.length - 1];
const isFlexCol = (col) => col.panes.some((p) => p.id === 'agent');

function sizeSlot(el, fixed, px, minProp, min) {
  el.style.flex = fixed ? `0 1 ${px}px` : '1 1 0px';
  el.style[minProp] = min + 'px';
}

// Built afresh only when the arrangement changes: moving an element in the DOM
// takes the keyboard off it. A resize only restyles what is there.
function renderPaneLayout(tab) {
  const layout = tab.els?.layout;
  if (!layout) return;
  const cols = paneLayout();
  const key = cols.map((c) => c.panes.map((p) => p.id).join('/')).join('|');
  if (tab.layoutKey !== key) {
    tab.layoutKey = key;
    const focused = layout.contains(document.activeElement) ? document.activeElement : null;
    for (const el of layout.querySelectorAll(':scope > .agents-col, :scope > .agents-gutter')) {
      for (const slot of el.querySelectorAll('.agents-slot')) layout.appendChild(slot);
      el.remove();
    }
    cols.forEach((col, ci) => {
      if (ci) layout.appendChild(makeGutter(tab, 'col', ci));
      const colEl = document.createElement('div');
      colEl.className = 'agents-col';
      col.panes.forEach((p, pi) => {
        if (pi) colEl.appendChild(makeGutter(tab, 'row', ci, pi));
        colEl.appendChild(tab.els.slots[p.id]);
      });
      layout.appendChild(colEl);
    });
    focused?.focus();
  }
  const colEls = layout.querySelectorAll(':scope > .agents-col');
  cols.forEach((col, ci) => {
    const minW = Math.max(...col.panes.map((p) => PANE_MIN_W[p.id]));
    sizeSlot(colEls[ci], !isFlexCol(col), col.w ?? 300, 'minWidth', minW);
    const flex = flexPaneOf(col);
    for (const p of col.panes) sizeSlot(tab.els.slots[p.id], p !== flex, p.h ?? 260, 'minHeight', PANE_MIN_H[p.id]);
  });
}

// What is on screen now, written back into the layout: a pane that was the
// slack has a size of its own once it is moved somewhere it no longer is.
function measuredLayout(tab) {
  const cols = paneLayout();
  const colEls = tab.els.layout.querySelectorAll(':scope > .agents-col');
  cols.forEach((col, ci) => {
    col.w = Math.round(colEls[ci]?.offsetWidth || col.w || 300);
    for (const p of col.panes) p.h = Math.round(tab.els.slots[p.id].offsetHeight || p.h || 260);
  });
  return cols;
}

// The gap between two columns, or between two panes stacked in one. Dragging it
// moves the line between them: a pane of fixed size grows or shrinks with it,
// the slack takes up the rest.
function makeGutter(tab, axis, ci, pi) {
  const gutter = document.createElement('div');
  gutter.className = axis === 'col' ? 'agents-gutter' : 'agents-row-gutter';
  gutter.title = 'Drag to resize';
  gutter.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    gutter.setPointerCapture(ev.pointerId);
    gutter.classList.add('dragging');
    const cols = measuredLayout(tab);
    const horizontal = axis === 'col';
    const start = horizontal ? ev.clientX : ev.clientY;
    // either side of the gap, with their sizes and floors as they are now
    const [a, b] = horizontal
      ? [cols[ci - 1], cols[ci]].map((c) => ({
          item: c,
          size: c.w,
          min: Math.max(...c.panes.map((p) => PANE_MIN_W[p.id])),
          fixed: !isFlexCol(c),
          key: 'w'
        }))
      : [cols[ci].panes[pi - 1], cols[ci].panes[pi]].map((p) => ({
          item: p,
          size: p.h,
          min: PANE_MIN_H[p.id],
          fixed: p !== flexPaneOf(cols[ci]),
          key: 'h'
        }));
    const move = (mv) => {
      const raw = (horizontal ? mv.clientX : mv.clientY) - start;
      const d = Math.max(a.min - a.size, Math.min(b.size - b.min, raw));
      if (a.fixed) a.item[a.key] = a.size + d;
      if (b.fixed) b.item[b.key] = b.size - d;
      state.theme.agentLayout = { ...state.theme.agentLayout, panes: cols };
      for (const t of agentTabs()) renderPaneLayout(t);
    };
    const up = () => {
      gutter.classList.remove('dragging');
      gutter.releasePointerCapture?.(ev.pointerId);
      gutter.removeEventListener('pointermove', move);
      gutter.removeEventListener('pointerup', up);
      saveTheme();
    };
    gutter.addEventListener('pointermove', move);
    gutter.addEventListener('pointerup', up);
  });
  return gutter;
}

// Picked up by its grip and dropped on another pane: on that pane's left or
// right edge it becomes a column of its own beside that pane's column; on its
// top or bottom edge it stacks above or below it. The nearest edge is the one.
function wirePaneGrip(tab, id) {
  const slot = tab.els.slots[id];
  const grip = slot.querySelector('.slot-grip');
  grip.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    grip.setPointerCapture(ev.pointerId);
    const layout = tab.els.layout;
    const marker = document.createElement('div');
    marker.className = 'agents-drop';
    marker.hidden = true;
    layout.appendChild(marker);
    layout.classList.add('moving');
    slot.classList.add('lifted');
    let drop = null;

    const move = (mv) => {
      const under = document
        .elementsFromPoint(mv.clientX, mv.clientY)
        .find((el) => el.classList?.contains('agents-slot') && layout.contains(el));
      const target = under?.dataset.pane;
      if (!target || target === id) {
        drop = null;
        marker.hidden = true;
        return;
      }
      const r = under.getBoundingClientRect();
      const fx = (mv.clientX - r.left) / r.width;
      const fy = (mv.clientY - r.top) / r.height;
      const side = [
        ['left', fx],
        ['right', 1 - fx],
        ['top', fy],
        ['bottom', 1 - fy]
      ].sort((x, y) => x[1] - y[1])[0][0];
      drop = { target, side };
      const box = layout.getBoundingClientRect();
      const [x, y, w, h] = { left: [0, 0, 0.5, 1], right: [0.5, 0, 0.5, 1], top: [0, 0, 1, 0.5], bottom: [0, 0.5, 1, 0.5] }[side];
      marker.hidden = false;
      marker.style.left = r.left - box.left + r.width * x + 'px';
      marker.style.top = r.top - box.top + r.height * y + 'px';
      marker.style.width = r.width * w + 'px';
      marker.style.height = r.height * h + 'px';
    };
    const up = () => {
      grip.releasePointerCapture?.(ev.pointerId);
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      marker.remove();
      layout.classList.remove('moving');
      slot.classList.remove('lifted');
      if (drop) movePane(tab, id, drop.target, drop.side);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
}

function movePane(tab, id, target, side) {
  const cols = measuredLayout(tab);
  const from = cols.find((c) => c.panes.some((p) => p.id === id));
  const pane = from.panes.find((p) => p.id === id);
  from.panes = from.panes.filter((p) => p !== pane);
  const rest = cols.filter((c) => c.panes.length);
  const col = rest.find((c) => c.panes.some((p) => p.id === target));
  if (side === 'left' || side === 'right') {
    // a column of its own, as wide as it was, if the column it lands by can spare it
    const w = Math.max(PANE_MIN_W[id], Math.min(from.w, Math.round(col.w / 2)));
    rest.splice(rest.indexOf(col) + (side === 'right' ? 1 : 0), 0, { w, panes: [{ id }] });
  } else {
    // it takes half the height of the pane it lands on
    const t = col.panes.find((p) => p.id === target);
    pane.h = Math.max(PANE_MIN_H[id], Math.round(t.h / 2));
    t.h = Math.max(PANE_MIN_H[t.id], t.h - pane.h);
    col.panes.splice(col.panes.indexOf(t) + (side === 'bottom' ? 1 : 0), 0, pane);
  }
  savePaneLayout(rest);
}

function buildAgentLayout(tab) {
  const layout = document.createElement('div');
  layout.className = 'agents-layout';
  layout.innerHTML = `
    <div class="agents-slot" data-pane="rail">
    <div class="slot-grip" title="Drag to move"></div>
    <div class="agents-rail">
      <button class="rail-new" title="Start Claude Code in a folder">+ New session</button>
      <div class="rail-section">
        <div class="rail-head"><h4>Agents</h4></div>
        <div class="agents-list"></div>
      </div>
      <div class="rail-section">
        <div class="rail-head">
          <h4>Sessions</h4>
          <button class="rail-refresh" title="Look for new Claude Code sessions">refresh</button>
        </div>
        <div class="sessions-list"></div>
      </div>
    </div>
    </div>
    <div class="agents-slot" data-pane="diff">
    <div class="slot-grip" title="Drag to move"></div>
    <div class="agents-diff">
      <div class="diff-head">
        <span class="diff-title">Diff watch</span>
        <div class="diff-toggle">
          <button data-mode="session" class="active" title="Everything since the agent started, commits included">Session</button>
          <button data-mode="uncommitted" title="Working tree vs HEAD only">Uncommitted</button>
        </div>
      </div>
      <div class="diff-repos" hidden></div>
      <div class="diff-sub">
        <span class="diff-summary"></span>
        <div class="diff-tools">
          <button class="diff-send" hidden title="Send comments to the agent">
            <svg viewBox="0 0 16 16"><path d="M2.75 8h9.5M8.75 4.5 12.25 8l-3.5 3.5" /></svg><span>Send</span>
          </button>
          <button class="diff-fold" title="Collapse or expand every file">
            <svg viewBox="0 0 16 16"><path d="m5 3 3 3 3-3M5 13l3-3 3 3" /></svg><span>Fold</span>
          </button>
        </div>
      </div>
      <div class="diff-body"><p class="hint">No agent selected</p></div>
    </div>
    </div>
    <div class="agents-slot" data-pane="shell">
    <div class="slot-grip" title="Drag to move"></div>
    <div class="agents-dock">
      <div class="dock-head">
        <span class="dock-title">
          <svg viewBox="0 0 16 16"><path d="m3.5 5 3 3-3 3M8.5 11.5h4" /></svg>
          <span class="dock-name">Shell</span>
        </span>
        <button class="dock-send" title="Send the last command's output to this session's agent (Ctrl+Shift+S)">
          <svg viewBox="0 0 16 16"><path d="M2.75 8h9.5M8.75 4.5 12.25 8l-3.5 3.5" /></svg><span>Send output</span>
        </button>
      </div>
      <div class="dock-body"><p class="hint dock-empty">The shell opens in the session's folder</p></div>
    </div>
    </div>
    <div class="agents-slot" data-pane="agent">
    <div class="slot-grip" title="Drag to move"></div>
    <div class="agents-center">
      <div class="agents-empty">cd into a repo and run <b>claude</b> — it becomes an agent automatically.</div>
    </div>
    </div>`;
  tab.contentEl.appendChild(layout);
  tab.diffMode = 'session';
  // The diff is recomputed on every file change, so what the reader has done to
  // it — folded a file away, scrolled to a hunk — has to outlive the re-render.
  tab.diffCollapsed = new Set();
  tab.diffCwd = null;
  // Shells docked by the diff, one per session; the one on show follows the
  // agent you select, so the shell next to a diff is always that diff's repo.
  tab.dockLeaves = new Set();
  tab.dockShown = null;
  tab.dockPending = new Set();
  tab.els = {
    layout,
    agentsList: layout.querySelector('.agents-list'),
    sessionsList: layout.querySelector('.sessions-list'),
    center: layout.querySelector('.agents-center'),
    empty: layout.querySelector('.agents-empty'),
    diffTitle: layout.querySelector('.diff-title'),
    diffBody: layout.querySelector('.diff-body'),
    diffSummary: layout.querySelector('.diff-summary'),
    diffRepos: layout.querySelector('.diff-repos'),
    diffFoldBtn: layout.querySelector('.diff-fold'),
    diffSendBtn: layout.querySelector('.diff-send'),
    slots: Object.fromEntries([...layout.querySelectorAll('.agents-slot')].map((el) => [el.dataset.pane, el])),
    dock: layout.querySelector('.agents-dock'),
    dockEmpty: layout.querySelector('.dock-empty'),
    dockBody: layout.querySelector('.dock-body'),
    dockName: layout.querySelector('.dock-name'),
    dockSend: layout.querySelector('.dock-send')
  };
  tab.els.dockSend.addEventListener('click', () => {
    if (tab.dockShown) sendOutputToAgent(tab.dockShown);
  });
  tab.els.diffFoldBtn.addEventListener('click', () => {
    const files = [...tab.els.diffBody.querySelectorAll('.diff-file')];
    // fold everything, unless it is already all folded
    const expand = files.length > 0 && files.every((f) => f.classList.contains('collapsed'));
    for (const f of files) {
      f.classList.toggle('collapsed', !expand);
      const p = f.dataset.path;
      if (!p) continue;
      if (expand) tab.diffCollapsed.delete(p);
      else tab.diffCollapsed.add(p);
    }
    syncFoldButton(tab);
  });
  tab.els.diffSendBtn.addEventListener('click', () => sendNotes(tab));
  // Which of the two terminals was typed into last. Remembered, not read off the
  // focus: the palette takes the focus, and its commands still mean that one.
  tab.els.dockBody.addEventListener('focusin', () => (tab.dockTyping = true));
  tab.els.center.addEventListener('focusin', () => (tab.dockTyping = false));
  layout.querySelectorAll('.diff-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      tab.diffMode = btn.dataset.mode;
      layout.querySelectorAll('.diff-toggle button').forEach((b) => b.classList.toggle('active', b === btn));
      reselectDiff(tab);
    });
  });
  for (const id of PANE_IDS) wirePaneGrip(tab, id);
  renderPaneLayout(tab);

  layout.querySelector('.rail-refresh').addEventListener('click', () => refreshSessions());
  layout.querySelector('.rail-new').addEventListener('click', () => pickSessionFolder(tab));
}

// ---------- shell dock ----------
// A shell by the diff, owned by a session: somewhere to run the tests or poke at
// the repo while the agent works, without leaving the view that shows what it
// changed. The owner is the session's center pane, which outlives a claude that
// restarts inside it. Every session has one, started in its folder as soon as
// the folder is known; switching session swaps the dock for that session's own
// shell. A shell out of sight keeps running, and comes back exactly as it was.

function dockLeafFor(tab, owner) {
  return [...(tab.dockLeaves || [])].find((l) => l.dockOwner === owner) || null;
}

function dockHostOf(leaf) {
  return agentTabs().find((t) => t.dockLeaves?.has(leaf)) || null;
}

async function openDockShell(tab, owner, cwd, { focus = true } = {}) {
  let leaf = dockLeafFor(tab, owner);
  if (!leaf) {
    leaf = await createPane({ cwd });
    // the session may have ended while the shell was starting
    if (!tab.centerLeaves.has(owner)) {
      destroyLeaf(leaf);
      return;
    }
    addDockLeaf(tab, leaf, owner, cwd);
  }
  // switched away while it started: it waits for its session instead
  if (owner.el.style.display !== 'none') showDockLeaf(tab, leaf, { focus });
}

// The folder a session's shell starts in: its agent's, else wherever its pane
// has said it is. Not known yet, and the shell waits until it is.
function ensureDockShell(tab, owner) {
  if (tab.adopting || !owner || !tab.centerLeaves.has(owner) || dockLeafFor(tab, owner) || tab.dockPending.has(owner)) return;
  const agent = [...globalAgents.values()].find((a) => a.leaf === owner);
  const cwd = agent?.cwd || owner.cwd;
  if (!cwd) return;
  tab.dockPending.add(owner);
  openDockShell(tab, owner, cwd, { focus: false }).finally(() => tab.dockPending.delete(owner));
}

function addDockLeaf(tab, leaf, owner, cwd) {
  leaf.dockOwner = owner;
  leaf.dockCwd = cwd;
  leaf.dockBorn = Date.now();
  // a failed command lights the dock's Send button; a passing one puts it out
  leaf.onCommandDone = (mark) => {
    leaf.dockFailed = mark.exit !== 0;
    if (tab.dockShown === leaf) renderDockSend(tab);
  };
  // and a selection turns it into "Send selection", which is what it will send
  leaf.term.onSelectionChange(() => {
    if (tab.dockShown === leaf) renderDockSend(tab);
  });
  leaf.el.classList.add('dock-pane');
  leaf.el.style.display = 'none';
  tab.dockLeaves.add(leaf);
  tab.els.dockBody.appendChild(leaf.el);
}

function showDockLeaf(tab, leaf, { focus = true } = {}) {
  for (const l of tab.dockLeaves) l.el.style.display = l === leaf ? '' : 'none';
  tab.dockShown = leaf;
  tab.els.dockEmpty.hidden = true;
  tab.els.dockName.textContent = String(leaf.dockCwd || '').split(/[\\/]/).pop() || 'Shell';
  tab.els.dockName.title = leaf.dockCwd || '';
  renderDockSend(tab);
  requestAnimationFrame(() => {
    leaf.fit.fit();
    if (focus) leaf.term.focus();
  });
}

// Put away, not closed: every shell stays alive for its session to come back to
function hideDock(tab) {
  for (const l of tab.dockLeaves) l.el.style.display = 'none';
  tab.dockShown = null;
  tab.dockTyping = false;
  tab.els.dockEmpty.hidden = false;
  tab.els.dockName.textContent = 'Shell';
  tab.els.dockName.title = '';
  renderDockSend(tab);
}

// The session on show decides what the dock holds, and starts it if it has none
function syncDock(tab, centerLeaf) {
  if (!tab.dockLeaves) return;
  const leaf = dockLeafFor(tab, centerLeaf);
  if (leaf && leaf === tab.dockShown) return;
  if (leaf) showDockLeaf(tab, leaf, { focus: false });
  else {
    hideDock(tab);
    ensureDockShell(tab, centerLeaf);
  }
}

// kill: false for a shell that has already exited on its own
function closeDockLeaf(tab, leaf, { kill = true } = {}) {
  tab.dockLeaves.delete(leaf);
  if (kill) destroyLeaf(leaf);
  else {
    try {
      leaf.term.dispose();
    } catch {}
    leaf.el.remove();
  }
  if (tab.dockShown !== leaf) return;
  hideDock(tab);
  const owner = leaf.dockOwner;
  if (owner?.el.style.display === 'none') return;
  // exited: a fresh one in its place, unless it died as it started, which a
  // fresh one would only do again
  if (!kill && Date.now() - leaf.dockBorn > 2000) ensureDockShell(tab, owner);
  owner?.term.focus();
}

// ---------- new session ----------
// Starting claude only needs a folder: the name is the folder's until Claude
// Code titles the session itself. The palette doubles as the picker, offering
// the folders recent sessions ran in, plus Browse for anywhere else.

async function pickSessionFolder(tab) {
  const [history, cfg] = await Promise.all([api.claudeFolders(), api.agentsGetConfig()]);
  const seen = new Set();
  const folders = [];
  const add = (cwd) => {
    const key = String(cwd || '').toLowerCase();
    if (!cwd || seen.has(key)) return;
    seen.add(key);
    folders.push({ label: cwd.split(/[\\/]/).pop() || cwd, detail: cwd, cwd });
  };
  // what is running now first, then everywhere claude has run, newest first —
  // not just the sessions list, which stops at its last row and leaves out the
  // live ones — then spaces saved before this picker existed
  for (const a of globalAgents.values()) add(a.cwd);
  for (const cwd of history || []) add(cwd);
  for (const sp of cfg?.spaces || []) add(sp.path);
  const browse = { label: 'Browse…', detail: 'pick any folder', always: true, browse: true };
  openPalette({
    placeholder: 'Start Claude in…',
    empty: 'No matching folder',
    items: () => [...folders, browse],
    choose: async (it) => {
      const cwd = it.browse ? await api.pickDir() : it.cwd;
      if (cwd) startSession(tab, cwd);
    }
  });
}

async function startSession(tab, cwd) {
  const name = cwd.split(/[\\/]/).pop() || cwd;
  const res = await api.agentsSpawn({ spacePath: cwd });
  if (!res || res.error) {
    toast(res?.error || 'Could not start claude', { error: true });
    return;
  }
  const leaf = await createPane({ cwd: res.cwd, run: res.run, profileId: agentProfileId() });
  addCenterLeaf(tab, leaf, true);
  if (res.agentId) {
    // auto-detect off: agent pre-registered by the main process
    api.agentsTrack({ agentId: res.agentId, ptyId: leaf.ptyId });
    registerAgent({
      agentId: res.agentId,
      ptyId: leaf.ptyId,
      cwd: res.cwd,
      name,
      branch: res.branch,
      git: res.git
    });
  }
}

function registerAgent({ agentId, ptyId, cwd, name, branch, git, sessionId }) {
  const leaf = panesByPty.get(ptyId);
  if (!leaf) return null;
  const agent = {
    id: agentId,
    name: pendingNames.get(ptyId) || name,
    cwd,
    branch,
    git,
    ptyId,
    leaf,
    status: 'working',
    sessionId: sessionId || null
  };
  pendingNames.delete(ptyId);
  if (leaf.resumedSession) resuming.delete(leaf.resumedSession);
  globalAgents.set(agentId, agent);
  agentsByPty.set(ptyId, agent);
  // if an agent tab hosts this pane in its center, select it there
  const host = agentTabs().find((t) => t.centerLeaves.has(leaf));
  if (host) selectAgent(host, agentId, { focus: false });
  renderAgentLists();
  return agent;
}

function selectAgent(tab, agentId, { focus = true } = {}) {
  const agent = globalAgents.get(agentId);
  if (!agent) return;
  if (tab.centerLeaves.has(agent.leaf)) {
    tab.selected = agentId;
    if (focus) setCenterVisible(tab, agent.leaf);
    else {
      for (const l of tab.centerLeaves) l.el.style.display = l === agent.leaf ? '' : 'none';
      syncDock(tab, agent.leaf);
      agent.leaf.fit.fit();
    }
    if (tab.diffKey !== 'agent:' + agentId) {
      // another agent's repos: back to its own, until its diff says what else
      tab.diffRepo = null;
      tab.diffMsg = null;
      tab.els.diffRepos.hidden = true;
      holdDiff(tab);
    }
    tab.diffKey = 'agent:' + agentId;
    tab.els.diffTitle.textContent = `${agent.name} · ${agent.branch}`;
    tab.diffCwd = agent.cwd || null; // lets a line number in the diff open the file
    renderNoteButton(tab);
    api.agentsSelectDiff({ agentId, mode: tab.diffMode });
    renderAgentList(tab);
    markAgentsSeen();
    return;
  }
  // claude started in a docked shell: its row brings up the session that owns
  // that shell, and the shell with it
  const dockTab = dockHostOf(agent.leaf);
  if (dockTab) {
    activateTab(dockTab);
    const owner = [...globalAgents.values()].find((a) => a.leaf === agent.leaf.dockOwner);
    if (owner) selectAgent(dockTab, owner.id);
    else setCenterVisible(dockTab, agent.leaf.dockOwner);
    agent.leaf.term.focus();
    return;
  }
  // pane lives elsewhere (normal tab or another agent tab) — jump to it
  const homeTab = agentTabs().find((t) => t.centerLeaves.has(agent.leaf)) || tabOfPane(agent.leaf);
  if (homeTab) {
    activateTab(homeTab);
    if (homeTab.kind === 'agents') selectAgent(homeTab, agentId);
    else focusPane(agent.leaf);
    return;
  }

  // Its pane is gone, so there is nothing to show and the entry is stale. This
  // used to do nothing at all, which read as the click being ignored. Say so and
  // stop listing it, rather than leaving a row that can never open.
  globalAgents.delete(agentId);
  agentsByPty.delete(agent.ptyId);
  for (const t of agentTabs()) {
    if (t.selected === agentId) t.selected = null;
    if (t.diffKey === 'agent:' + agentId) t.diffKey = null;
  }
  renderAgentLists();
  toast(`${agent.name} is no longer running`, { error: true });
}

// Resuming is slow: claude has to boot before the SessionStart hook ties the
// pane to its session, and the row stays on screen until it does. Without a
// guard a second click would open the same session twice.
const resuming = new Set(); // session ids with a resume in flight

async function resumeSession(tab, session) {
  const live = [...globalAgents.values()].find((a) => a.sessionId === session.id);
  if (live) return selectAgent(tab, live.id);

  // already resumed here, but claude hasn't reported back yet
  const open = [...tab.centerLeaves].find((l) => l.resumedSession === session.id);
  if (open) return setCenterVisible(tab, open);

  if (!session.exists) {
    toast(`${session.cwd} no longer exists`, { error: true });
    return;
  }
  if (resuming.has(session.id)) return;
  // claimed before asking, so a double click can't raise the dialog twice
  resuming.add(session.id);
  const ok =
    !session.runningElsewhere ||
    (await confirmModal({
      title: `"${session.title}" is still open somewhere else`,
      detail:
        'Another terminal or Frost window is running this session. Resuming it here as well puts two Claude processes on one history, and they can overwrite each other.',
      confirmLabel: 'Resume anyway',
      cancelLabel: 'Cancel',
      focusCancel: true
    }));
  if (!ok) {
    resuming.delete(session.id);
    return;
  }
  renderSessions();
  try {
    // --resume by id, not --continue: the folder's latest session is not
    // necessarily the one that was clicked
    const leaf = await createPane({
      cwd: session.cwd,
      run: `claude --resume ${session.id}`,
      profileId: agentProfileId()
    });
    leaf.resumedSession = session.id;
    addCenterLeaf(tab, leaf, true);
    pendingNames.set(leaf.ptyId, session.title);
  } finally {
    // released when the session reports in; this is the backstop for a claude
    // that never starts, so the row doesn't stay stuck forever
    setTimeout(() => {
      if (resuming.delete(session.id)) renderSessions();
    }, 30000);
  }
}

function renderAgentList(tab) {
  const rows = [];
  for (const agent of globalAgents.values()) {
    const row = document.createElement('div');
    const look = agent.status === 'done' ? (agent.unseen ? ' unseen' : ' seen') : '';
    row.className = 'agent-row' + (tab.selected === agent.id ? ' selected' : '') + look;
    row.title = [agent.cwd, agent.sessionId, agent.unseen && 'Finished — not looked at yet'].filter(Boolean).join('\n');
    row.innerHTML = `
      <span class="agent-dot st-${agent.status}"></span>
      <span class="agent-name"></span>
      <span class="agent-meta"></span>`;
    row.querySelector('.agent-name').textContent = agent.name;
    // the repo too, as in the sessions list: a resumed session is named after
    // its title, which doesn't say where it runs
    const folder = String(agent.cwd || '').split(/[\\/]/).pop();
    row.querySelector('.agent-meta').textContent = [folder, agent.branch, agent.status]
      .filter(Boolean)
      .join(' · ');
    row.addEventListener('click', () => selectAgent(tab, agent.id));
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      openAgentMenu(tab, agent, ev.clientX, ev.clientY);
    });
    rows.push(row);
  }
  tab.els.agentsList.replaceChildren(...rows);
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No agents yet — run claude in the terminal';
    tab.els.agentsList.appendChild(p);
  }
  renderSessionList(tab);
}

function copyText(text, what) {
  navigator.clipboard.writeText(text).then(
    () => toast(`Copied ${what}`),
    () => toast(`Couldn't copy ${what}`, { error: true })
  );
}

function openAgentMenu(tab, agent, x, y) {
  const done = agent.status === 'done';
  openMenu(
    [
      {
        label: 'Mark as unread',
        // bold is how a finished agent says it hasn't been looked at; one still
        // working has nothing to be unread yet
        disabled: !done || agent.unseen,
        title: done ? '' : 'Only a finished agent can be unread',
        run: () => {
          agent.unseen = true;
          renderAgentLists();
        }
      },
      {
        label: 'Copy resume command',
        disabled: !agent.sessionId,
        run: () => copyText(`claude --resume ${agent.sessionId}`, 'resume command')
      },
      {
        label: 'Copy folder path',
        sep: true,
        disabled: !agent.cwd,
        run: () => copyText(agent.cwd, 'folder path')
      },
      {
        label: 'Open folder in Explorer',
        disabled: !agent.cwd,
        run: () =>
          api.openPath({ cwd: agent.cwd, target: '.' }).then((res) => {
            if (res?.error && !res.opened) toast(res.error, { error: true });
          })
      },
      { label: 'End session', sep: true, run: () => endAgentSession(tab, agent) }
    ],
    x,
    y
  );
}

// Quits claude the way you would by hand, so it ends cleanly and its session
// stays resumable from the list below, then closes the pane it ran in. Ctrl+C
// is sent three times: mid-turn the first only interrupts, and the next two
// are the double press that quits. What lands after claude has gone reaches
// the shell, which is closed anyway. A claude that doesn't quit is killed with
// the pane — the transcript is on disk already.
async function endAgentSession(tab, agent) {
  if (agent.status === 'working') {
    const ok = await confirmModal({
      title: `End "${agent.name}"?`,
      detail: 'It is in the middle of a turn, which will be interrupted. The session can be resumed from the list afterwards.',
      confirmLabel: 'End session',
      cancelLabel: 'Cancel',
      focusCancel: true
    });
    if (!ok) return;
  }
  const leaf = agent.leaf;
  const ptyId = agent.ptyId;
  if (ptyId) {
    for (let i = 0; i < 3; i++) {
      if (!globalAgents.has(agent.id)) break;
      api.ptyInput(ptyId, '\x03');
      await new Promise((r) => setTimeout(r, 300));
    }
    // up to a few seconds for it to say goodbye
    for (let t = 0; t < 20 && globalAgents.has(agent.id); t++) await new Promise((r) => setTimeout(r, 150));
  }
  if (leaf) closeAgentPane(leaf);
  refreshSessions();
}

// A pane in the agent view's center goes, and another is shown in its place;
// one in an ordinary tab closes like any pane.
function closeAgentPane(leaf) {
  const host = agentTabs().find((t) => t.centerLeaves.has(leaf));
  if (!host) {
    if (tabOfPane(leaf)) removePane(leaf);
    return;
  }
  const wasShown = leaf.el.style.display !== 'none';
  host.centerLeaves.delete(leaf);
  const shell = dockLeafFor(host, leaf);
  if (shell) closeDockLeaf(host, shell);
  destroyLeaf(leaf);
  const agent = [...globalAgents.values()].find((a) => a.leaf === leaf);
  if (agent) {
    globalAgents.delete(agent.id);
    agentsByPty.delete(agent.ptyId);
  }
  if (agent && host.selected === agent.id) host.selected = null;
  const next = [...host.centerLeaves].pop();
  if (!next) {
    host.els.empty.style.display = '';
    host.selected = null;
  } else if (wasShown) {
    const shown = [...globalAgents.values()].find((a) => a.leaf === next);
    if (shown) selectAgent(host, shown.id);
    else setCenterVisible(host, next);
  }
  renderAgentLists();
}

// ---------- sessions ----------
// Recent Claude Code sessions, read from Claude Code's own transcripts, so a
// claude started in any tab can be found and picked up again from here. One
// that is running right now is listed under Agents instead, with its status.

async function refreshSessions() {
  if (!agentTabs().length) return;
  // live ones are listed under Agents; main leaves them out before counting
  const live = [...globalAgents.values()].map((a) => a.sessionId).filter(Boolean);
  claudeSessions = (await api.claudeSessions(live)) || [];
  renderSessions();
}

function renderSessions() {
  for (const tab of agentTabs()) renderSessionList(tab);
}

function timeAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

function renderSessionList(tab) {
  if (!tab.els?.sessionsList) return;
  const live = new Set([...globalAgents.values()].map((a) => a.sessionId).filter(Boolean));
  const rows = [];
  for (const s of claudeSessions) {
    if (live.has(s.id)) continue;
    const busy = resuming.has(s.id);
    const row = document.createElement('div');
    row.className = 'agent-row dormant' + (busy ? ' busy' : '') + (s.exists ? '' : ' gone');
    row.title = `${s.cwd}\n${s.id}`;
    row.innerHTML = `
      <span class="agent-dot st-exited"></span>
      <span class="agent-name"></span>
      <span class="agent-meta"></span>`;
    row.querySelector('.agent-name').textContent = s.title;
    const folder = s.cwd.split(/[\\/]/).pop();
    const when = !s.exists ? 'folder missing' : s.runningElsewhere ? 'open elsewhere' : timeAgo(s.lastActive);
    row.querySelector('.agent-meta').textContent = `${folder} · ${busy ? 'resuming…' : when}`;
    // running, just not here: dimmer than live, brighter than closed
    if (s.runningElsewhere) row.querySelector('.agent-dot').className = 'agent-dot st-idle';
    if (!busy) row.addEventListener('click', () => resumeSession(tab, s));
    rows.push(row);
  }
  tab.els.sessionsList.replaceChildren(...rows);
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No other Claude Code sessions yet';
    tab.els.sessionsList.appendChild(p);
  }
}

// Re-issues the diff request for the selected agent, so the Session/Uncommitted
// toggle takes effect straight away.
function reselectDiff(tab) {
  if (!tab.diffKey?.startsWith('agent:')) return;
  api.agentsSelectDiff({ agentId: tab.diffKey.slice(6), mode: tab.diffMode });
}

// ---------- a command's output, to an agent ----------
// Tests fail in the shell beside an agent, and the agent is who has to know.
// The command, how it ended and what it printed go into the agent's prompt as
// one message — pasted, not submitted, as review comments are.

const OUTPUT_HEAD = 40; // lines kept from the top of a long output…
const OUTPUT_TAIL = 300; // …and from the bottom, where a failure usually says why

// Whether path p is dir or inside it, as Windows compares paths
function pathWithin(dir, p) {
  const norm = (x) => String(x || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const d = norm(dir);
  const x = norm(p);
  return !!d && !!x && (x === d || x.startsWith(d + '\\'));
}

// Whose output this is to be: a docked shell's own session; otherwise the agent
// working in the folder the shell is in, or the only agent there is.
function agentForPane(node) {
  if (!node) return null;
  if (node.dockOwner) return agentsByPty.get(node.dockOwner.ptyId) || null;
  if (agentsByPty.has(node.ptyId)) return null; // the agent's own terminal
  const all = [...globalAgents.values()];
  const here = all.filter((a) => pathWithin(a.cwd, node.cwd) || pathWithin(node.cwd, a.cwd));
  const selected = agentTabs()[0]?.selected;
  return here.find((a) => a.id === selected) || here[0] || (all.length === 1 ? all[0] : null);
}

function outputPrompt(out, cwd) {
  const folder = String(cwd || '').split(/[\\/]/).pop();
  // a remote prompt says where the command ran better than the local folder
  const where = out.host || folder;
  const on = where ? (out.host ? ' on ' : ' in ') + where : '';
  const cmd = out.command ? '`' + out.command + '`' : 'This command';
  // no exit code: a remote command's, or a selection's, which nothing reports
  const how = out.selection ? '' : out.running ? ' is still running' : out.exit ? ` failed (exit ${out.exit})` : ' ran';
  let lines = out.output;
  if (lines.length > OUTPUT_HEAD + OUTPUT_TAIL) {
    const cut = lines.length - OUTPUT_HEAD - OUTPUT_TAIL;
    lines = [...lines.slice(0, OUTPUT_HEAD), `… ${cut} lines left out …`, ...lines.slice(-OUTPUT_TAIL)];
  }
  const head = out.selection
    ? `From the shell${on}:`
    : `${cmd}${how}${on}` + (lines.length ? ':' : ', printing nothing.');
  return lines.length ? [head, '', '```', ...lines, '```'].join('\n') : head;
}

// Brought on screen wherever its pane lives, with the keyboard in it
function revealAgent(agent) {
  const host = agentTabs().find((t) => t.centerLeaves.has(agent.leaf));
  if (host) {
    activateTab(host);
    selectAgent(host, agent.id);
    return;
  }
  const tab = tabOfPane(agent.leaf);
  if (tab) {
    activateTab(tab);
    focusPane(agent.leaf);
  }
}

function sendOutputToAgent(node) {
  if (!node) return;
  const agent = agentForPane(node);
  if (!agent?.leaf?.term) {
    const why = agentsByPty.has(node.ptyId)
      ? 'Run the command in a shell, not in the agent'
      : 'No agent to send it to — none is working in this folder';
    toast(why, { error: true });
    return;
  }
  const out = commandOutput(node);
  if (!out) {
    const why = liveMarks(node).length ? 'No finished command to send yet' : 'No command marks yet — this shell has not reported one';
    toast(why, { error: true });
    return;
  }
  agent.leaf.term.paste(outputPrompt(out, node.cwd));
  // sent: the selection has done its job, and the button goes back to the output
  if (out.selection) node.term.clearSelection();
  else node.dockFailed = false;
  const tab = dockHostOf(node);
  if (tab) renderDockSend(tab);
  revealAgent(agent);
  toast(`Sent to ${agent.name} — press Enter to submit`);
}

function renderDockSend(tab) {
  const btn = tab.els?.dockSend;
  if (!btn) return;
  // a selection is what gets sent when there is one, so it names the button first
  const selected = !!tab.dockShown?.term.hasSelection();
  const failed = !selected && !!tab.dockShown?.dockFailed;
  btn.classList.toggle('failed', failed);
  btn.classList.toggle('selection', selected);
  btn.querySelector('span').textContent = selected ? 'Send selection' : failed ? 'Send failure' : 'Send output';
  btn.title = selected
    ? "Send the selected text to this session's agent (Ctrl+Shift+S)"
    : "Send the last command's output to this session's agent (Ctrl+Shift+S)";
}
