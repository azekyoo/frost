// Agent mode: the rail of running agents, their status, the spaces they are
// spawned in, and the Claude Code sessions that can be picked up again.

// ---------- agent mode ----------

const globalAgents = new Map(); // agentId -> agent {id,name,cwd,branch,git,ptyId,leaf,status,sessionId}
const agentsByPty = new Map(); // ptyId -> agent
const pendingNames = new Map(); // ptyId -> preferred display name
let claudeSessions = []; // recent Claude Code sessions [{id,cwd,title,branch,lastActive,exists}]
let agentDrag = null; // { tab, row, list, startY, grabTop, base, moved, before }
let dragJustEnded = false;
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

