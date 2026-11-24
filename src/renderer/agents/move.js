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
  // switching agents fades the other session in rather than cutting to it
  const switching =
    leaf.el.style.display === 'none' && [...tab.centerLeaves].some((l) => l !== leaf && l.el.style.display !== 'none');
  for (const l of tab.centerLeaves) l.el.style.display = l === leaf ? '' : 'none';
  gpuShowWithin(leaf.el);
  if (switching && !reduceMotion.matches) {
    leaf.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' }).id = 'motion-agent-switch';
  }
  syncDock(tab, leaf);
  markAgentsSeen();
  if (leaf.ptyId) api.ptyMute(leaf.ptyId);
  requestAnimationFrame(() => {
    leaf.fit.fit();
    leaf.term.focus();
  });
}

