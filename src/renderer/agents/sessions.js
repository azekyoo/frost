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
    row.dataset.sessionId = s.id;
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
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      openSessionMenu(s, busy, ev.clientX, ev.clientY);
    });
    rows.push(row);
  }
  flipList(tab.els.sessionsList, (r) => r.dataset.sessionId, () => {
    tab.els.sessionsList.replaceChildren(...rows);
    if (!rows.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'No other Claude Code sessions yet';
      tab.els.sessionsList.appendChild(p);
    }
  });
  setRailCount(tab.els.sessionsList, rows.length);
}

function openSessionMenu(session, busy, x, y) {
  const open = busy || session.runningElsewhere;
  openMenu(
    [
      { label: 'Copy session ID', run: () => copyText(session.id, 'session ID') },
      { label: 'Copy folder path', run: () => copyText(session.cwd, 'folder path') },
      {
        label: 'Delete session…',
        sep: true,
        // a running claude would write the transcript straight back
        disabled: open,
        title: open ? 'Still open — end it first' : '',
        run: () => deleteSession(session)
      }
    ],
    x,
    y
  );
}

async function deleteSession(session) {
  const ok = await confirmModal({
    title: `Delete "${session.title}"?`,
    detail: 'Its transcript is moved to the Recycle Bin and it can no longer be resumed.',
    confirmLabel: 'Delete',
    cancelLabel: 'Cancel',
    focusCancel: true
  });
  if (!ok) return;
  const res = await api.claudeDeleteSession(session.id);
  if (res?.error) {
    toast(res.error, { error: true });
    return;
  }
  // gone from the list now, not on the next refresh
  claudeSessions = claudeSessions.filter((s) => s.id !== session.id);
  renderSessions();
  refreshSessions();
  toast(`Deleted "${session.title}"`);
}

// Re-issues the diff request for the selected agent, so the Session/Uncommitted
// toggle takes effect straight away.
function reselectDiff(tab) {
  if (!tab.diffKey?.startsWith('agent:')) return;
  api.agentsSelectDiff({ agentId: tab.diffKey.slice(6), mode: tab.diffMode });
}

