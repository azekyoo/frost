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
      gpuShowWithin(agent.leaf.el);
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

const AGENT_STATE_WORDS = {
  working: 'Working',
  blocked: 'Needs you',
  done: 'Done',
  idle: 'Idle',
  exited: 'Exited'
};

// How many rows a rail section holds, next to its heading. Hidden in Frost;
// blank when there are none.
function setRailCount(list, n) {
  const count = list.closest('.rail-section')?.querySelector('.rail-count');
  if (count) count.textContent = n ? String(n) : '';
}

function renderAgentList(tab) {
  // a status tick mid-drag would rebuild the rows out from under the pointer;
  // the drop renders the list again
  if (agentDrag?.tab === tab) {
    renderSessionList(tab);
    return;
  }
  const rows = [];
  for (const agent of globalAgents.values()) {
    const row = document.createElement('div');
    const look = agent.status === 'done' ? (agent.unseen ? ' unseen' : ' seen') : '';
    row.className = 'agent-row' + (tab.selected === agent.id ? ' selected' : '') + look;
    row.title = [agent.cwd, agent.sessionId, agent.unseen && 'Finished — not looked at yet'].filter(Boolean).join('\n');
    // for a design to colour the row by; Frost colours only the dot
    row.dataset.status = agent.status;
    row.innerHTML = `
      <span class="agent-dot st-${agent.status}"></span>
      <span class="agent-name"></span>
      <span class="agent-state"></span>
      <span class="agent-meta"><span class="meta-where"></span><span class="meta-st"></span></span>`;
    row.querySelector('.agent-name').textContent = agent.name;
    // The state twice: in words on a chip, for the designs that show one, and
    // at the end of the meta line, where Frost shows it. Each design hides one.
    row.querySelector('.agent-state').textContent = AGENT_STATE_WORDS[agent.status] || agent.status;
    // the repo too, as in the sessions list: a resumed session is named after
    // its title, which doesn't say where it runs
    const folder = String(agent.cwd || '').split(/[\\/]/).pop();
    const where = [folder, agent.branch].filter(Boolean).join(' · ');
    row.querySelector('.meta-where').textContent = where;
    row.querySelector('.meta-st').textContent = (where ? ' · ' : '') + agent.status;
    row.dataset.agentId = agent.id;
    row.addEventListener('click', () => {
      // the click that ends a drag is not a click on the row
      if (dragJustEnded) return;
      selectAgent(tab, agent.id);
    });
    row.addEventListener('mousedown', (ev) => startAgentDrag(tab, row, ev));
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      openAgentMenu(tab, agent, ev.clientX, ev.clientY);
    });
    rows.push(row);
  }
  flipList(tab.els.agentsList, (r) => r.dataset.agentId, () => {
    tab.els.agentsList.replaceChildren(...rows);
    if (!rows.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'No agents yet — run claude in the terminal';
      tab.els.agentsList.appendChild(p);
    }
  });
  setRailCount(tab.els.agentsList, rows.length);
  renderSessionList(tab);
}

