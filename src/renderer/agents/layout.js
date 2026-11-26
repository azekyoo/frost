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
      <button class="rail-new" title="Start Claude Code in a folder"><span>+ New session</span></button>
      <div class="rail-section">
        <div class="rail-head"><h4>Agents<span class="rail-count"></span></h4></div>
        <div class="agents-list"></div>
      </div>
      <div class="rail-section">
        <div class="rail-head">
          <h4>Sessions<span class="rail-count"></span></h4>
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
          <button data-mode="session" class="active" title="Everything since the agent started, commits included"><span>Session</span></button>
          <button data-mode="uncommitted" title="Working tree vs HEAD only"><span>Uncommitted</span></button>
        </div>
      </div>
      <div class="diff-repos" hidden></div>
      <div class="diff-sub">
        <span class="diff-summary"></span>
        <div class="diff-tools">
          <button class="diff-send" hidden title="Send comments to the agent">
            <svg viewBox="0 0 16 16"><path d="M2.75 8h9.5M8.75 4.5 12.25 8l-3.5 3.5" /></svg><span>Send</span>
          </button>
          <button class="diff-open-tab" title="Show or put away this session's shell, under the diff (it keeps running)">
            <svg viewBox="0 0 16 16"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" /><path d="m4.75 6.25 2 1.75-2 1.75M8.5 10h2.75" /></svg><span>Shell</span>
          </button>
          <button class="diff-open-editor" title="${keyText("Browse this session's repo in Peek (Ctrl+Shift+E)")}">
            <svg viewBox="0 0 16 16"><path d="m5.5 4.5-3.25 3.5 3.25 3.5M10.5 4.5l3.25 3.5-3.25 3.5" /></svg><span>Files</span>
          </button>
          <button class="diff-explorer" title="${osText('Open this repo in File Explorer', 'Open this repo in Finder')}">
            <svg viewBox="0 0 16 16"><path d="M1.75 4.25a1.5 1.5 0 0 1 1.5-1.5h2.6l1.5 1.75h5.4a1.5 1.5 0 0 1 1.5 1.5v5.75a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5z" /></svg>
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
      <div class="dock-inner">
        <div class="dock-head">
          <span class="dock-title">
            <svg viewBox="0 0 16 16"><path d="m3.5 5 3 3-3 3M8.5 11.5h4" /></svg>
            <span class="dock-name">Shell</span>
          </span>
          <button class="dock-send" title="${keyText("Send the last command's output to this session's agent (Ctrl+Shift+S)")}">
            <svg viewBox="0 0 16 16"><path d="M2.75 8h9.5M8.75 4.5 12.25 8l-3.5 3.5" /></svg><span>Send output</span>
          </button>
          <button class="dock-close" title="Close this shell"><svg viewBox="0 0 16 16"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7" /></svg></button>
        </div>
        <div class="dock-body"></div>
      </div>
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
    diffSendBtn: layout.querySelector('.diff-send'),
    side: layout.querySelector('.agents-side'),
    dock: layout.querySelector('.agents-dock'),
    dockGutter: layout.querySelector('.agents-dock-gutter'),
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
    // no animation and no measuring: on a big diff, reading each file's box
    // between class flips re-laid out the whole panel once per file (seconds)
    for (const f of files) {
      foldDiffFile(f, !expand, false);
      const p = f.dataset.path;
      if (!p) continue;
      if (expand) tab.diffCollapsed.delete(p);
      else tab.diffCollapsed.add(p);
    }
    syncFoldButton(tab);
  });
  tab.els.diffSendBtn.addEventListener('click', () => sendNotes(tab));
  layout.querySelector('.diff-open-tab').addEventListener('click', () => {
    // the selected agent, not diffCwd: that one outlives an agent that has gone
    const agent = globalAgents.get(tab.selected);
    if (!agent?.cwd || !tab.centerLeaves.has(agent.leaf)) return toast('Select an agent first', { error: true });
    // the button toggles: a second press puts this session's shell away, still
    // running, rather than replaying the opening — the × is what ends it
    const shown = tab.dockShown;
    if (shown && shown.dockOwner === agent.leaf && !shown.dockClosing) putDockAway(tab, shown);
    else openDockShell(tab, agent.leaf, agent.cwd);
  });
  layout.querySelector('.diff-open-editor').addEventListener('click', () => {
    // diffCwd as a fallback: the repo is still worth browsing once its agent ends
    const dir = globalAgents.get(tab.selected)?.cwd || tab.diffCwd;
    if (dir) peekBrowseHome(dir, tab);
    else toast('Select an agent first', { error: true });
  });
  layout.querySelector('.diff-explorer').addEventListener('click', () => {
    // the repo chip picked above the diff when there is one, so Explorer shows
    // the folder whose changes are on screen
    const dir = tab.diffRepo || globalAgents.get(tab.selected)?.cwd || tab.diffCwd;
    if (!dir) return toast('Select an agent first', { error: true });
    api.revealPath({ target: dir }).then((res) => {
      if (res?.error && !res.opened) toast(res.error, { error: true });
    });
  });
  layout.querySelector('.dock-close').addEventListener('click', () => {
    if (tab.dockShown) closeDockLeaf(tab, tab.dockShown, { animate: true });
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

