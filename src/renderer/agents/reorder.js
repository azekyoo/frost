// ---------- reordering agents ----------
// A running agent's row can be dragged up or down the list. The order is all
// a drag changes: dropping anywhere, even outside the rail, just keeps the
// place it reached, and Esc puts it back where it was.

const DRAG_THRESHOLD = 4; // px of movement before a press becomes a drag

function startAgentDrag(tab, row, ev) {
  if (ev.button !== 0 || agentDrag) return;
  const list = tab.els.agentsList;
  agentDrag = {
    tab,
    row,
    list,
    startY: ev.clientY,
    grabTop: row.getBoundingClientRect().top,
    base: row.offsetTop,
    moved: false,
    before: [...list.children]
  };
  window.addEventListener('mousemove', onAgentDragMove);
  window.addEventListener('mouseup', onAgentDragEnd);
  window.addEventListener('keydown', onAgentDragKey, true);
}

function onAgentDragMove(ev) {
  const d = agentDrag;
  if (!d) return;
  const dy = ev.clientY - d.startY;
  if (!d.moved) {
    if (Math.abs(dy) < DRAG_THRESHOLD) return;
    d.moved = true;
    d.row.classList.add('reordering');
    document.body.classList.add('agent-reordering');
  }
  ev.preventDefault();
  // the row goes in front of the first other row whose middle is below the pointer
  // (judged by where rows sit, not where a slide is showing them mid-way)
  const others = [...d.list.querySelectorAll('.agent-row')].filter((r) => r !== d.row);
  const next = others.find((r) => {
    const b = r.getBoundingClientRect();
    return ev.clientY < b.top - slideOffset(r) + b.height / 2;
  });
  const last = others[others.length - 1];
  if (next) {
    if (d.row.nextElementSibling !== next) slideRows(d.list, () => d.list.insertBefore(d.row, next), d.row);
  } else if (last && d.row !== last.nextElementSibling) {
    slideRows(d.list, () => last.after(d.row), d.row);
  }
  // follow the pointer from wherever the row sits now, kept inside the list
  const listBox = d.list.getBoundingClientRect();
  const h = d.row.offsetHeight;
  const want = Math.max(listBox.top, Math.min(listBox.bottom - h, d.grabTop + dy));
  const natural = d.grabTop + (d.row.offsetTop - d.base);
  d.row.style.transform = `translateY(${want - natural}px)`;
}

function onAgentDragKey(ev) {
  if (ev.key !== 'Escape' || !agentDrag) return;
  ev.preventDefault();
  ev.stopPropagation();
  const d = agentDrag;
  slideRows(d.list, () => {
    d.list.replaceChildren(...d.before);
    d.row.style.transform = '';
  });
  finishAgentDrag(false);
}

function onAgentDragEnd() {
  if (agentDrag) finishAgentDrag(agentDrag.moved);
}

function finishAgentDrag(keep) {
  const d = agentDrag;
  window.removeEventListener('mousemove', onAgentDragMove);
  window.removeEventListener('mouseup', onAgentDragEnd);
  window.removeEventListener('keydown', onAgentDragKey, true);
  agentDrag = null;
  if (!d.moved) return; // a plain click: let it through
  // the row glides from under the pointer into its slot, then the list is rebuilt
  if (d.row.style.transform) slideRows(d.list, () => (d.row.style.transform = ''));
  document.body.classList.remove('agent-reordering');
  dragJustEnded = true;
  setTimeout(() => (dragJustEnded = false), 0);
  if (keep) {
    // the Map's order is the list's order, in every agent tab
    const order = [...d.list.querySelectorAll('.agent-row')].map((r) => r.dataset.agentId);
    const entries = order.map((id) => [id, globalAgents.get(id)]).filter(([, a]) => a);
    for (const [id, a] of globalAgents) if (!order.includes(id)) entries.push([id, a]);
    globalAgents.clear();
    for (const [id, a] of entries) globalAgents.set(id, a);
  }
  const settle = d.row.getAnimations().find((a) => a.id === 'row-slide');
  const done = () => {
    d.row.classList.remove('reordering');
    renderAgentLists();
  };
  if (settle) settle.finished.then(done, done);
  else done();
}

// Rows the list moves around (a drag passing them, the drop, Esc) slide to
// their new places instead of jumping: note where each row shows, make the
// change, then play each row from its old spot to its new one.
const ROW_SLIDE_MS = 160;

function slideOffset(row) {
  const t = getComputedStyle(row).transform;
  return t && t !== 'none' ? new DOMMatrixReadOnly(t).m42 : 0;
}

function slideRows(list, change, skip) {
  const rows = [...list.querySelectorAll('.agent-row')].filter((r) => r !== skip);
  const from = new Map(rows.map((r) => [r, r.getBoundingClientRect().top]));
  change();
  for (const r of rows) r.getAnimations().forEach((a) => a.id === 'row-slide' && a.cancel());
  if (reduceMotion.matches) return;
  for (const r of rows) {
    if (!r.isConnected) continue;
    const dy = from.get(r) - r.getBoundingClientRect().top;
    if (Math.abs(dy) < 0.5) continue;
    const base = r.style.transform || 'translateY(0)';
    const anim = r.animate([{ transform: `translateY(${dy}px) ${base}` }, { transform: base }], {
      duration: ROW_SLIDE_MS,
      easing: MOTION_EASE
    });
    anim.id = 'row-slide';
  }
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
        label: 'Copy session ID',
        disabled: !agent.sessionId,
        run: () => copyText(agent.sessionId, 'session ID')
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

