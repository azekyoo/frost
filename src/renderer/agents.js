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
    if (t.dockShown === agent.leaf) return !t.els.dock.hidden;
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
      dockHeight: leaf.dockHeight ?? null,
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
    if (saved.dockHeight) leaf.dockHeight = saved.dockHeight;
  }
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

// ---------- agent layout sizing ----------
// The rail and the diff panel are draggable and remembered. Widths are stored as
// the user set them; when the window is too narrow to honour both, they're
// scaled down for display only, so widening the window restores them.

const AGENT_MIN = { rail: 150, diff: 220, center: 260 };
const GUTTER = 6;

function agentColumns() {
  const stored = state.theme?.agentLayout || {};
  return { rail: stored.rail ?? 210, diff: stored.diff ?? 340 };
}

function applyAgentColumns(tab) {
  if (!tab.els?.layout) return;
  let { rail, diff } = agentColumns();
  const total = tab.els.layout.clientWidth;
  if (total) {
    const available = total - AGENT_MIN.center - GUTTER * 2;
    if (rail + diff > available) {
      const scale = Math.max(0.15, available / (rail + diff));
      rail = Math.max(AGENT_MIN.rail, Math.round(rail * scale));
      diff = Math.max(AGENT_MIN.diff, Math.round(diff * scale));
    }
  }
  const columns = `${rail}px ${GUTTER}px 1fr ${GUTTER}px ${diff}px`;
  // guard against feeding the ResizeObserver its own change
  if (tab.appliedColumns === columns) return;
  tab.appliedColumns = columns;
  tab.els.layout.style.gridTemplateColumns = columns;
}

function wireGutter(tab, gutter, edge) {
  gutter.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    gutter.setPointerCapture(ev.pointerId);
    gutter.classList.add('dragging');
    const startX = ev.clientX;
    const startWidth = agentColumns()[edge];

    const move = (mv) => {
      // the diff panel grows leftwards, so its delta is inverted
      const delta = edge === 'rail' ? mv.clientX - startX : startX - mv.clientX;
      const other = agentColumns()[edge === 'rail' ? 'diff' : 'rail'];
      const room = tab.els.layout.clientWidth - other - AGENT_MIN.center - GUTTER * 2;
      const next = Math.max(AGENT_MIN[edge], Math.min(room, startWidth + delta));
      state.theme.agentLayout = { ...state.theme.agentLayout, ...agentColumns(), [edge]: Math.round(next) };
      for (const t of agentTabs()) applyAgentColumns(t);
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
}

function buildAgentLayout(tab) {
  const layout = document.createElement('div');
  layout.className = 'agents-layout';
  layout.innerHTML = `
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
    <div class="agents-gutter" data-edge="rail" title="Drag to resize"></div>
    <div class="agents-center">
      <div class="agents-empty">cd into a repo and run <b>claude</b> — it becomes an agent automatically.</div>
    </div>
    <div class="agents-gutter" data-edge="diff" title="Drag to resize"></div>
    <div class="agents-side">
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
          <button class="diff-open-tab" title="Open a shell in this session's folder, under the diff">
            <svg viewBox="0 0 16 16"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" /><path d="m4.75 6.25 2 1.75-2 1.75M8.5 10h2.75" /></svg><span>Shell</span>
          </button>
          <button class="diff-fold" title="Collapse or expand every file">
            <svg viewBox="0 0 16 16"><path d="m5 3 3 3 3-3M5 13l3-3 3 3" /></svg><span>Fold</span>
          </button>
        </div>
      </div>
      <div class="diff-body"><p class="hint">No agent selected</p></div>
    </div>
    <div class="agents-dock-gutter" hidden title="Drag to resize"></div>
    <div class="agents-dock" hidden>
      <div class="dock-head">
        <span class="dock-title">
          <svg viewBox="0 0 16 16"><path d="m3.5 5 3 3-3 3M8.5 11.5h4" /></svg>
          <span class="dock-name">Shell</span>
        </span>
        <button class="dock-close" title="Close this shell"><svg viewBox="0 0 16 16"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7" /></svg></button>
      </div>
      <div class="dock-body"></div>
    </div>
    </div>`;
  tab.contentEl.appendChild(layout);
  tab.diffMode = 'session';
  // The diff is recomputed on every file change, so what the reader has done to
  // it — folded a file away, scrolled to a hunk — has to outlive the re-render.
  tab.diffCollapsed = new Set();
  tab.diffCwd = null;
  // Shells docked under the diff, one per folder; the one on show follows the
  // agent you select, so the shell next to a diff is always that diff's repo.
  tab.dockLeaves = new Set();
  tab.dockShown = null;
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
    side: layout.querySelector('.agents-side'),
    dock: layout.querySelector('.agents-dock'),
    dockGutter: layout.querySelector('.agents-dock-gutter'),
    dockBody: layout.querySelector('.dock-body'),
    dockName: layout.querySelector('.dock-name')
  };
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
  });
  layout.querySelector('.diff-open-tab').addEventListener('click', () => {
    // the selected agent, not diffCwd: that one outlives an agent that has gone
    const agent = globalAgents.get(tab.selected);
    if (agent?.cwd && tab.centerLeaves.has(agent.leaf)) openDockShell(tab, agent.leaf, agent.cwd);
    else toast('Select an agent first', { error: true });
  });
  layout.querySelector('.dock-close').addEventListener('click', () => {
    if (tab.dockShown) closeDockLeaf(tab, tab.dockShown);
  });
  wireDockGutter(tab);
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
  layout.querySelectorAll('.agents-gutter').forEach((g) => wireGutter(tab, g, g.dataset.edge));
  applyAgentColumns(tab);
  // re-clamp when the window changes size, so a narrow window can't squeeze the
  // terminal out entirely
  new ResizeObserver(() => {
    applyAgentColumns(tab);
    applyDockHeight(tab);
  }).observe(layout);

  layout.querySelector('.rail-refresh').addEventListener('click', () => refreshSessions());
  layout.querySelector('.rail-new').addEventListener('click', () => pickSessionFolder(tab));
}

// ---------- shell dock ----------
// A shell under the diff, owned by a session: somewhere to run the tests or poke
// at the repo while the agent works, without leaving the view that shows what it
// changed. The owner is the session's center pane, which outlives a claude that
// restarts inside it. Switching session swaps the dock for that session's own
// shell, or puts it away; a shell out of sight keeps running, and comes back
// exactly as it was, at the height it was left at.

const DOCK_MIN = 110;
const DIFF_MIN_H = 140;

function dockLeafFor(tab, owner) {
  return [...(tab.dockLeaves || [])].find((l) => l.dockOwner === owner) || null;
}

function dockHostOf(leaf) {
  return agentTabs().find((t) => t.dockLeaves?.has(leaf)) || null;
}

// Stored as the user dragged it, per shell; a new shell starts at the last one
// dragged. Squeezed for display only when the window is too short to give the
// diff its minimum, so a taller window gives it back.
function applyDockHeight(tab) {
  if (!tab.els?.dock || tab.els.dock.hidden) return;
  const stored = tab.dockShown?.dockHeight ?? state.theme?.agentLayout?.dock ?? 260;
  const total = tab.els.side.clientHeight;
  const room = total ? total - DIFF_MIN_H - GUTTER : stored;
  const h = Math.max(DOCK_MIN, Math.min(stored, room));
  if (tab.appliedDock === h) return;
  tab.appliedDock = h;
  tab.els.dock.style.height = h + 'px';
}

async function openDockShell(tab, owner, cwd) {
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
  if (owner.el.style.display !== 'none') showDockLeaf(tab, leaf, { animate: true });
}

function addDockLeaf(tab, leaf, owner, cwd) {
  leaf.dockOwner = owner;
  leaf.dockCwd = cwd;
  leaf.el.classList.add('dock-pane');
  leaf.el.style.display = 'none';
  tab.dockLeaves.add(leaf);
  tab.els.dockBody.appendChild(leaf.el);
}

// animate: only when the button opens it. Coming back with its session, the
// shell simply is there, as it was left.
function showDockLeaf(tab, leaf, { focus = true, animate = false } = {}) {
  for (const l of tab.dockLeaves) l.el.style.display = l === leaf ? '' : 'none';
  tab.els.dock.classList.toggle('opening', animate);
  tab.dockShown = leaf;
  tab.els.dock.hidden = false;
  tab.els.dockGutter.hidden = false;
  tab.els.dockName.textContent = String(leaf.dockCwd || '').split(/[\\/]/).pop() || 'Shell';
  tab.els.dockName.title = leaf.dockCwd || '';
  tab.appliedDock = null;
  applyDockHeight(tab);
  requestAnimationFrame(() => {
    leaf.fit.fit();
    if (focus) leaf.term.focus();
  });
}

// Put away, not closed: every shell stays alive for its session to come back to
function hideDock(tab) {
  if (!tab.dockShown && tab.els.dock.hidden) return;
  for (const l of tab.dockLeaves) l.el.style.display = 'none';
  tab.dockShown = null;
  tab.dockTyping = false;
  tab.els.dock.hidden = true;
  tab.els.dockGutter.hidden = true;
}

// The session on show decides what the dock holds
function syncDock(tab, centerLeaf) {
  if (!tab.dockLeaves) return;
  const leaf = dockLeafFor(tab, centerLeaf);
  if (leaf === tab.dockShown) return;
  if (leaf) showDockLeaf(tab, leaf, { focus: false });
  else hideDock(tab);
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
  // the diff takes the whole column back, the session's pane the keyboard
  if (leaf.dockOwner?.el.style.display !== 'none') leaf.dockOwner?.term.focus();
}

function wireDockGutter(tab) {
  const gutter = tab.els.dockGutter;
  gutter.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    gutter.setPointerCapture(ev.pointerId);
    gutter.classList.add('dragging');
    const startY = ev.clientY;
    const startH = tab.els.dock.offsetHeight;
    const move = (mv) => {
      // the dock grows upwards, so dragging up makes it taller
      const room = tab.els.side.clientHeight - DIFF_MIN_H - GUTTER;
      const next = Math.max(DOCK_MIN, Math.min(room, startH + (startY - mv.clientY)));
      if (tab.dockShown) tab.dockShown.dockHeight = Math.round(next);
      state.theme.agentLayout = { ...state.theme.agentLayout, dock: Math.round(next) };
      tab.appliedDock = null;
      applyDockHeight(tab);
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
