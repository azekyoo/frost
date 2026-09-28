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
  // default center terminal: cd anywhere and run `claude` — auto-registers
  const leaf = await createPane({ profileId: agentProfileId() });
  addCenterLeaf(tab, leaf, true);
  renderAgentList(tab);
  await refreshSessions();
  return tab;
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
      state.theme.agentLayout = { ...agentColumns(), [edge]: Math.round(next) };
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
          <button class="diff-open-tab" title="Open a terminal tab in this session's folder">shell</button>
          <button class="diff-fold" title="Collapse or expand every file">fold</button>
        </div>
      </div>
      <div class="diff-body"><p class="hint">No agent selected</p></div>
    </div>`;
  tab.contentEl.appendChild(layout);
  tab.diffMode = 'session';
  // The diff is recomputed on every file change, so what the reader has done to
  // it — folded a file away, scrolled to a hunk — has to outlive the re-render.
  tab.diffCollapsed = new Set();
  tab.diffCwd = null;
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
    diffFoldBtn: layout.querySelector('.diff-fold')
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
    const cwd = globalAgents.get(tab.selected)?.cwd;
    if (cwd) newTab({ cwd });
    else toast('Select an agent first', { error: true });
  });
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
  new ResizeObserver(() => applyAgentColumns(tab)).observe(layout);

  layout.querySelector('.rail-refresh').addEventListener('click', () => refreshSessions());
  layout.querySelector('.rail-new').addEventListener('click', () => pickSessionFolder(tab));
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
      agent.leaf.fit.fit();
    }
    if (tab.diffKey !== 'agent:' + agentId) {
      // another agent's repos: back to its own, until its diff says what else
      tab.diffRepo = null;
      tab.diffMsg = null;
      tab.els.diffRepos.hidden = true;
    }
    tab.diffKey = 'agent:' + agentId;
    tab.els.diffTitle.textContent = `${agent.name} · ${agent.branch}`;
    tab.diffCwd = agent.cwd || null; // lets a line number in the diff open the file
    api.agentsSelectDiff({ agentId, mode: tab.diffMode });
    renderAgentList(tab);
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
    row.className = 'agent-row' + (tab.selected === agent.id ? ' selected' : '');
    row.title = [agent.cwd, agent.sessionId].filter(Boolean).join('\n');
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
