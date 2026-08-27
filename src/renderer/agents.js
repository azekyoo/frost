// Agent mode: the rail of running agents, their status, the spaces they are
// spawned in, and the worktrees they leave behind.

// ---------- agent mode ----------

const globalAgents = new Map(); // agentId -> agent {id,name,cwd,branch,git,ptyId,leaf,status}
const agentsByPty = new Map(); // ptyId -> agent
const pendingNames = new Map(); // ptyId -> preferred display name
let sessions = []; // resumable past sessions [{name,cwd,branch,lastSeen}]
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
  const cfg = await api.agentsGetConfig();
  renderSpaces(tab, cfg);
  sessions = await api.agentsGetSessions();
  renderAgentList(tab);
  await refreshWorktrees();
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
      <div class="rail-section">
        <div class="rail-head"><h4>Spaces</h4><button class="rail-add" title="Add a git repo">+</button></div>
        <div class="spaces-list"></div>
      </div>
      <div class="rail-section">
        <div class="rail-head"><h4>Agents</h4></div>
        <div class="agents-list"></div>
      </div>
      <div class="rail-section">
        <div class="rail-head">
          <h4>Worktrees</h4>
          <button class="rail-prune" title="Forget worktrees whose folder is gone">prune</button>
        </div>
        <div class="worktrees-list"></div>
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
      <div class="diff-sub">
        <span class="diff-summary"></span>
        <div class="diff-tools">
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
    spacesList: layout.querySelector('.spaces-list'),
    agentsList: layout.querySelector('.agents-list'),
    worktreesList: layout.querySelector('.worktrees-list'),
    center: layout.querySelector('.agents-center'),
    empty: layout.querySelector('.agents-empty'),
    diffTitle: layout.querySelector('.diff-title'),
    diffBody: layout.querySelector('.diff-body'),
    diffSummary: layout.querySelector('.diff-summary'),
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

  layout.querySelector('.rail-prune').addEventListener('click', async () => {
    const pruned = await api.worktreesPrune();
    const total = pruned.reduce((n, p) => n + p.count, 0);
    toast(total ? `Forgot ${total} missing worktree${total > 1 ? 's' : ''}` : 'Nothing to prune');
    refreshWorktrees();
  });
  layout.querySelector('.rail-add').addEventListener('click', async () => {
    const cfg = await api.agentsAddSpace();
    if (!cfg) return;
    if (cfg.error) {
      toast(cfg.error);
      return;
    }
    renderSpaces(tab, cfg);
    refreshWorktrees();
  });
}

function renderSpaces(tab, cfg) {
  tab.els.spacesList.replaceChildren(
    ...(cfg.spaces || []).map((space) => {
      const row = document.createElement('div');
      row.className = 'space-row';
      const name = document.createElement('span');
      name.className = 'space-name';
      name.textContent = space.name;
      name.title = space.path;
      const btn = document.createElement('button');
      btn.textContent = '+ agent';
      btn.title = 'Spawn a Claude Code agent here';
      btn.addEventListener('click', () => showSpawnForm(tab, space, row));
      const del = document.createElement('button');
      del.className = 'space-remove';
      del.textContent = '×';
      del.title = 'Remove this space (repo itself is untouched)';
      del.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const cfg = await api.agentsRemoveSpace(space.path);
        renderSpaces(tab, cfg);
        refreshWorktrees();
      });
      row.append(name, btn, del);
      return row;
    })
  );
  if (!(cfg.spaces || []).length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No spaces yet — add a git repo with +';
    tab.els.spacesList.appendChild(p);
  }
}

function showSpawnForm(tab, space, row) {
  if (row.nextElementSibling?.classList.contains('spawn-form')) {
    row.nextElementSibling.remove();
    return;
  }
  tab.els.spacesList.querySelectorAll('.spawn-form').forEach((f) => f.remove());
  const form = document.createElement('div');
  form.className = 'spawn-form';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'agent name';
  input.spellcheck = false;
  const wtLabel = document.createElement('label');
  wtLabel.className = 'spawn-wt';
  const wtCheck = document.createElement('input');
  wtCheck.type = 'checkbox';
  wtLabel.append(wtCheck, document.createTextNode(' isolate in worktree (own branch)'));
  form.append(input, wtLabel);
  row.after(form);
  input.focus();
  input.addEventListener('keydown', async (ev) => {
    if (ev.key === 'Escape') form.remove();
    if (ev.key === 'Enter' && input.value.trim()) {
      const task = input.value.trim();
      const useWorktree = wtCheck.checked;
      form.remove();
      await spawnAgent(tab, space, task, useWorktree);
    }
  });
}

async function spawnAgent(tab, space, task, useWorktree = false) {
  const res = await api.agentsSpawn({ spacePath: space.path, task, useWorktree });
  if (!res || res.error) {
    toast(res?.error || 'Agent spawn failed');
    return;
  }
  const leaf = await createPane({ cwd: res.cwd, run: res.run, profileId: agentProfileId() });
  addCenterLeaf(tab, leaf, true);
  if (useWorktree) refreshWorktrees();
  pendingNames.set(leaf.ptyId, task);
  if (res.agentId) {
    // auto-detect off: agent pre-registered by the main process
    api.agentsTrack({ agentId: res.agentId, ptyId: leaf.ptyId });
    registerAgent({
      agentId: res.agentId,
      ptyId: leaf.ptyId,
      cwd: res.cwd,
      name: task,
      branch: res.branch,
      git: true
    });
  }
}

function registerAgent({ agentId, ptyId, cwd, name, branch, git }) {
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
    status: 'working'
  };
  pendingNames.delete(ptyId);
  resuming.delete(String(cwd || '').toLowerCase());
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
    tab.diffKey = 'agent:' + agentId;
    tab.els.diffTitle.textContent = `${agent.name} · ${agent.branch}`;
    tab.diffCwd = agent.cwd || null; // lets a line number in the diff open the file
    api.agentsSelectDiff({ agentId, mode: tab.diffMode });
    renderAgentList(tab);
    renderWorktrees(tab);
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

// Resuming is slow: claude has to boot before it registers as an agent, and the
// row stays on screen until it does. Without a guard a second click starts a
// second session in the same directory.
const resuming = new Set(); // lowercased cwds with a resume in flight

const sameDir = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

async function resumeSession(tab, session) {
  const cwd = session.cwd;
  const key = String(cwd || '').toLowerCase();

  const live = [...globalAgents.values()].find((a) => sameDir(a.cwd, cwd));
  if (live) return selectAgent(tab, live.id);

  // Only a pane this resumed counts. Matching any pane that happens to sit in
  // the directory would focus an ordinary shell and never resume anything —
  // the agent tab's own starting pane is usually already there.
  const open = [...tab.centerLeaves].find((l) => sameDir(l.resumedCwd, cwd));
  if (open) return setCenterVisible(tab, open);

  if (resuming.has(key)) return;
  resuming.add(key);
  renderAgentList(tab);
  try {
    const leaf = await createPane({
      cwd,
      run: 'claude --continue',
      profileId: agentProfileId()
    });
    leaf.resumedCwd = cwd;
    addCenterLeaf(tab, leaf, true);
    pendingNames.set(leaf.ptyId, session.name);
  } finally {
    // released when the agent registers; this is the backstop for a claude that
    // never starts, so the row doesn't stay stuck forever
    setTimeout(() => {
      if (resuming.delete(key)) renderAgentLists();
    }, 30000);
  }
}

function renderAgentList(tab) {
  const rows = [];
  for (const agent of globalAgents.values()) {
    const row = document.createElement('div');
    row.className = 'agent-row' + (tab.selected === agent.id ? ' selected' : '');
    row.innerHTML = `
      <span class="agent-dot st-${agent.status}"></span>
      <span class="agent-name"></span>
      <span class="agent-meta"></span>`;
    row.querySelector('.agent-name').textContent = agent.name;
    row.querySelector('.agent-meta').textContent = `${agent.branch} · ${agent.status}`;
    row.addEventListener('click', () => selectAgent(tab, agent.id));
    rows.push(row);
  }
  // compared case-insensitively: main canonicalises the separators, but Windows
  // paths can still differ in case for the same directory
  const liveCwds = new Set([...globalAgents.values()].map((a) => String(a.cwd || '').toLowerCase()));
  for (const s of sessions) {
    if (liveCwds.has(String(s.cwd || '').toLowerCase())) continue;
    const row = document.createElement('div');
    const busy = resuming.has(String(s.cwd || '').toLowerCase());
    row.className = 'agent-row dormant' + (busy ? ' busy' : '');
    row.title = busy ? `Resuming in ${s.cwd}` : `Resume last Claude session in ${s.cwd}`;
    row.innerHTML = `
      <span class="agent-dot st-exited"></span>
      <span class="agent-name"></span>
      <button class="session-remove" title="Forget this session">×</button>
      <span class="agent-meta"></span>`;
    row.querySelector('.agent-name').textContent = s.name;
    row.querySelector('.agent-meta').textContent = `${s.branch} · ${busy ? 'resuming…' : 'resume'}`;
    if (!busy) row.addEventListener('click', () => resumeSession(tab, s));
    row.querySelector('.session-remove').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      sessions = await api.agentsRemoveSession(s.cwd);
      renderAgentLists();
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
}

// ---------- worktrees ----------
// An agent isolated in a worktree leaves behind a checkout under <repo>/.frost
// and a branch. This lists them so the work can be found and reviewed after the
// agent is gone, instead of only while it's selected.

let worktrees = [];

async function refreshWorktrees() {
  worktrees = await api.worktreesList();
  for (const tab of agentTabs()) renderWorktrees(tab);
}

// Re-issues the diff request for whatever the tab is currently showing, so the
// Session/Uncommitted toggle works for agents and worktrees alike.
function reselectDiff(tab) {
  if (!tab.diffKey) return;
  if (tab.diffKey.startsWith('agent:')) {
    api.agentsSelectDiff({ agentId: tab.diffKey.slice(6), mode: tab.diffMode });
  } else if (tab.diffKey.startsWith('wt:')) {
    const wt = worktrees.find((w) => 'wt:' + w.path === tab.diffKey);
    if (wt) api.worktreesSelectDiff({ cwd: wt.path, base: wt.base, mode: tab.diffMode });
  }
}

function selectWorktree(tab, wt) {
  tab.selected = null;
  tab.diffKey = 'wt:' + wt.path;
  tab.els.diffTitle.textContent = `${wt.name} · ${wt.branch || 'detached'}`;
  tab.diffCwd = wt.path || null;
  api.worktreesSelectDiff({ cwd: wt.path, base: wt.base, mode: tab.diffMode });
  renderAgentList(tab);
  renderWorktrees(tab);
}

function renderWorktrees(tab) {
  const spaces = new Set(worktrees.map((w) => w.space));
  const rows = worktrees.map((wt) => {
    const row = document.createElement('div');
    row.className = 'wt-row' + (tab.diffKey === 'wt:' + wt.path ? ' selected' : '');
    row.title = wt.path;

    const name = document.createElement('span');
    name.className = 'wt-name';
    // The branch is what you act on, so it gets the row; the space is only worth
    // naming when more than one is configured.
    const label = wt.branch || wt.name + ' (detached)';
    name.textContent = spaces.size > 1 ? `${wt.space}/${label}` : label;

    const actions = document.createElement('span');
    actions.className = 'wt-actions';

    const act = (label, title, run) => {
      const b = document.createElement('button');
      b.className = 'wt-act';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        b.disabled = true;
        try {
          await run();
        } finally {
          b.disabled = false;
        }
      });
      actions.appendChild(b);
      return b;
    };

    if (wt.exists) {
      act('open', 'Open a tab in this worktree', () => newTab({ cwd: wt.path }));
      act(
        'merge',
        `Merge ${wt.branch || 'this branch'} into ${wt.base}`,
        async () => {
          const res = await api.worktreesMerge(wt.path);
          if (res?.cancelled) return;
          if (res?.error) return toast(res.error, { error: true });
          toast(`Merged ${res.branch} into ${res.base}`);
          refreshWorktrees();
        }
      );
    }
    act('discard', 'Delete this worktree and its branch', async () => {
      const res = await api.worktreesDiscard(wt.path);
      if (res?.cancelled) return;
      if (res?.error) return toast(res.error, { error: true });
      if (res?.warning) toast(res.warning, { error: true });
      else toast(`Discarded ${wt.name}`);
      // the diff panel may have been showing what we just deleted
      if (tab.diffKey === 'wt:' + wt.path) {
        tab.diffKey = null;
        tab.diffCwd = null;
        tab.els.diffTitle.textContent = 'Diff watch';
        tab.els.diffSummary.textContent = '';
        tab.els.diffBody.innerHTML = '<p class="hint">No agent selected</p>';
        api.agentsSelectDiff(null);
      }
      refreshWorktrees();
    });

    const meta = document.createElement('span');
    meta.className = 'wt-meta';
    // No branch here: it's the row's title now, and repeating it only crowded
    // out the part that actually changes.
    const bits = [];
    if (!wt.exists) bits.push('folder missing');
    else {
      if (wt.ahead) bits.push(`${wt.ahead} commit${wt.ahead > 1 ? 's' : ''}`);
      if (wt.dirty) bits.push('uncommitted');
      if (!wt.ahead && !wt.dirty) bits.push('no changes');
    }
    if (wt.locked) bits.push('locked');
    meta.textContent = bits.join(' · ');

    row.append(name, actions, meta);
    if (wt.exists) row.addEventListener('click', () => selectWorktree(tab, wt));
    else row.classList.add('gone');
    return row;
  });

  tab.els.worktreesList.replaceChildren(...rows);
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No worktrees — tick "isolate in worktree" when spawning an agent';
    tab.els.worktreesList.appendChild(p);
  }
}
