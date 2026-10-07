// The renderer's half of Frost's MCP server: main asks, this window answers
// about the panes it holds — which there are, what one of them printed, what
// is selected — opens shells for an agent, and watches a pane while a command
// an agent typed runs. The typing itself is main's: it owns the shells.

const MCP_MAX_CHARS = 60000;

// Every pane in this window with the tab it belongs to.
function mcpPanes() {
  const out = [];
  for (const tab of state.tabs) {
    if (tab.kind === 'agents') {
      for (const leaf of [...(tab.centerLeaves || []), ...(tab.dockLeaves || [])]) out.push({ tab, leaf });
    } else if (tab.root) {
      for (const leaf of allLeaves(tab.root)) out.push({ tab, leaf });
    }
  }
  return out.filter(({ leaf }) => leaf.ptyId && leaf.term);
}

function mcpPaneTitle(leaf) {
  const agent = agentsByPty.get(leaf.ptyId);
  if (agent) return `agent ${agent.name}`;
  if (leaf.dockOwner) {
    const owner = agentsByPty.get(leaf.dockOwner.ptyId);
    return `shell under the diff viewer, docked to agent ${owner?.name || '?'}`;
  }
  return paneLabel(leaf);
}

function mcpKind(leaf) {
  if (agentsByPty.has(leaf.ptyId)) return 'agent';
  return leaf.dockOwner ? 'dock-shell' : 'shell';
}

function mcpDescribe({ tab, leaf }) {
  const marks = liveMarks(leaf);
  const last = marks[marks.length - 1];
  const running = last && last.exit === null ? runningOutput(leaf, marks) : null;
  const finished = marks.length >= 2 ? marks[marks.length - 2] : null;
  const focused = document.hasFocus() && leaf.el.contains(document.activeElement);
  const d = {
    pane: leaf.ptyId,
    kind: mcpKind(leaf),
    tab: tabLabel(tab),
    title: mcpPaneTitle(leaf),
    cwd: leaf.cwd || leaf.dockCwd || null,
    branch: leaf.branch || null,
    shell: leaf.profileName || null
  };
  if (running) d.running = running.command || true;
  if (finished && finished.exit !== null) d.lastExit = finished.exit;
  if (!marks.length) d.noCommandMarks = true; // cmd, WSL: only "lines" reading works
  if (leaf.term.buffer.active.type === 'alternate') d.fullScreenProgram = true;
  if (state.activeTab === tab && leaf.el.offsetParent !== null) d.onScreen = true;
  if (focused) d.focused = true;
  return d;
}

function mcpClip(text) {
  if (text.length <= MCP_MAX_CHARS) return text;
  return '[… earlier output cut …]\n' + text.slice(text.length - MCP_MAX_CHARS);
}

function mcpRead({ pane, lines, command }) {
  const leaf = panesByPty.get(pane);
  if (!leaf?.term) return { error: `No pane "${pane}" in this window.` };
  const head = `[pane ${pane} · ${mcpPaneTitle(leaf)}${leaf.cwd ? ' · ' + leaf.cwd : ''}]`;

  if (command) {
    // 1 is the one running, when something is, else the last that finished
    const marks = liveMarks(leaf);
    const running = marks.length && marks[marks.length - 1].exit === null ? runningOutput(leaf, marks) : null;
    const c = running ? (command === 1 ? running : finishedCommand(leaf, command - 1)) : finishedCommand(leaf, command);
    if (!c) {
      return {
        error: marks.length
          ? `There is no command ${command} back in pane ${pane}'s scrollback.`
          : `Pane ${pane}'s shell does not mark its commands — read it by lines instead.`
      };
    }
    const status = c.running || c.exit === null ? '[still running]' : `[exit ${c.exit}]`;
    return { text: mcpClip(`${head}\n$ ${c.command}\n${c.output.join('\n')}\n${status}`) };
  }

  const term = leaf.term;
  const buf = term.buffer.active;
  let end = buf.length - 1;
  while (end > 0 && !buf.getLine(end)?.translateToString(true).trim()) end--;
  const start = Math.max(0, end - lines + 1);
  const body = bufferText(term, start, end).join('\n');
  const note = buf.type === 'alternate' ? ' (a full-screen program: this is its current screen)' : '';
  return { text: mcpClip(`${head}${note}\n${body}`) };
}

function mcpSelection() {
  const panes = mcpPanes();
  // the pane being typed in first: its selection is the one being looked at
  panes.sort((a, b) => (b.leaf.el.contains(document.activeElement) ? 1 : 0) - (a.leaf.el.contains(document.activeElement) ? 1 : 0));
  for (const { leaf } of panes) {
    if (!leaf.term.hasSelection()) continue;
    const text = leaf.term.getSelection().replace(/[ \t]+$/gm, '').trim();
    if (text) return { pane: leaf.ptyId, title: mcpPaneTitle(leaf), text: mcpClip(text) };
  }
  return null;
}

// ---------- what the typing tools need ----------

const mcpSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Whether a pane is free to type into, and how many commands it has finished
// so far — the count the wait afterwards watches go up.
function mcpState({ pane }) {
  const leaf = panesByPty.get(pane);
  if (!leaf?.term) return { error: `No pane "${pane}" in this window.` };
  const marks = liveMarks(leaf);
  const last = marks[marks.length - 1];
  const running = last && last.exit === null ? runningOutput(leaf, marks) : null;
  return { running: running ? running.command || 'a program' : null, done: leaf.doneCount || 0 };
}

// Everything printed from a marker down, the blank rows under it left off
function mcpTextFrom(leaf, marker) {
  const buf = leaf.term.buffer.active;
  let end = buf.length - 1;
  while (end > 0 && !buf.getLine(end)?.translateToString(true).trim()) end--;
  const start = marker && !marker.isDisposed ? marker.line : Math.max(0, end - 150);
  return end < start ? '' : bufferText(leaf.term, start, end).join('\n');
}

// What the screen looks like, cheaply: it stops changing when a program that
// draws no prompt marks has finished, or is waiting on input.
function mcpScreenSig(leaf) {
  const buf = leaf.term.buffer.active;
  return `${buf.length}:${buf.baseY}:${buf.cursorY}:${buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true)}`;
}

// After run_in_pane typed a command: until the shell reports it finished — its
// D mark and the prompt after it — or the timeout, when whatever it is goes on
// running and what it has printed so far is the answer. A shell with no marks
// (cmd, WSL) is taken to be done once its screen has sat still for a moment.
async function mcpWaitDone({ pane, done, ms }) {
  const leaf = panesByPty.get(pane);
  if (!leaf?.term) return { error: `No pane "${pane}" in this window.` };
  const marked = liveMarks(leaf).length > 0;
  const start = leaf.term.registerMarker(0);
  const until = Date.now() + ms;
  const t0 = Date.now();
  let sig = '';
  let still = Date.now();
  try {
    while (Date.now() < until) {
      await mcpSleep(200);
      if (panesByPty.get(pane) !== leaf) return { error: `Pane ${pane} closed.` };
      if (marked) {
        const marks = liveMarks(leaf);
        // the prompt after it has to be drawn as well, for its output to end
        if ((leaf.doneCount || 0) > done && marks.length && marks[marks.length - 1].exit === null) {
          const c = finishedCommand(leaf, 1);
          if (c) return { text: mcpClip(`$ ${c.command}\n${c.output.join('\n')}\n[exit ${c.exit}]`) };
        }
      } else {
        const now = mcpScreenSig(leaf);
        if (now !== sig) {
          sig = now;
          still = Date.now();
        } else if (Date.now() - still > 1500 && Date.now() - t0 > 1000) {
          return { text: mcpClip(`${mcpTextFrom(leaf, start)}\n[this shell does not report exit codes; output stopped changing]`) };
        }
      }
    }
    const secs = Math.round(ms / 1000);
    return { text: mcpClip(`${mcpTextFrom(leaf, start)}\n[still running after ${secs}s — it keeps running in pane ${pane}]`) };
  } finally {
    start?.dispose();
  }
}

// Until new output matches the pattern, or — with none — until what is
// running finishes.
async function mcpWaitOutput({ pane, pattern, ms }) {
  const leaf = panesByPty.get(pane);
  if (!leaf?.term) return { error: `No pane "${pane}" in this window.` };
  const st = mcpState({ pane });
  if (!pattern && !st.running) {
    return { text: mcpClip(`[nothing is running in pane ${pane}]\n${mcpTextFrom(leaf, null)}`) };
  }
  const re = pattern ? new RegExp(pattern, 'i') : null;
  const start = leaf.term.registerMarker(0);
  const until = Date.now() + ms;
  try {
    while (Date.now() < until) {
      await mcpSleep(250);
      if (panesByPty.get(pane) !== leaf) return { error: `Pane ${pane} closed.` };
      const text = mcpTextFrom(leaf, start);
      if (re && re.test(text)) return { text: mcpClip(`[matched /${pattern}/]\n${text}`) };
      if (!re && (leaf.doneCount || 0) > st.done) {
        return { text: mcpClip(`${text}\n[finished, exit ${leaf.lastExit}]`) };
      }
    }
    const secs = Math.round(ms / 1000);
    return { text: mcpClip(`[${re ? `no match for /${pattern}/` : 'still running'} after ${secs}s]\n${mcpTextFrom(leaf, start)}`) };
  } finally {
    start?.dispose();
  }
}

// A shell for an agent, next to it: under the diff in an agents tab, a split
// of its own pane in a normal one. Answered once the shell has drawn its first
// prompt, since anything typed before that lands in its startup.
async function mcpOpen({ from, where, cwd }) {
  const leaf = panesByPty.get(from);
  if (!leaf) return { error: 'Your pane is not in this window any more.' };
  const agent = agentsByPty.get(from);
  const host = agentTabs().find((t) => t.centerLeaves.has(leaf));
  const dir = cwd || agent?.cwd || leaf.cwd || null;
  let shell;
  let reused = false;
  if (host) {
    if (where === 'split') return { error: 'An agents tab has no splits — use where: "dock".' };
    reused = Boolean(dockLeafFor(host, leaf));
    shell = await openDockShell(host, leaf, dir, { focus: false });
  } else {
    if (where === 'dock') return { error: 'Your session is in a normal tab, which has no dock — use where: "split".' };
    shell = await splitPane('row', { target: leaf, focus: false, cwd: dir });
  }
  if (!shell?.ptyId) return { error: 'The shell did not open.' };
  const until = Date.now() + 15000;
  while (!reused && !shell.cwd && !liveMarks(shell).length && Date.now() < until) await mcpSleep(150);
  return {
    pane: shell.ptyId,
    where: host ? 'dock' : 'split',
    cwd: shell.cwd || dir,
    ...(reused ? { reused: true } : {}),
    ...(host && shell.el.style.display === 'none' ? { hidden: 'your session is not the one on screen; the dock shows it when it is' } : {})
  };
}

// Typing that lands somewhere out of sight is still said out loud
function mcpNotice({ pane, text }) {
  const leaf = panesByPty.get(pane);
  if (leaf && leaf.el.offsetParent !== null && document.hasFocus()) return null;
  toast(`${text} (pane ${pane})`);
  return null;
}

const MCP_OPS = {
  panes: () => mcpPanes().map(mcpDescribe),
  read: mcpRead,
  selection: mcpSelection,
  state: mcpState,
  notice: mcpNotice,
  waitDone: mcpWaitDone,
  waitOutput: mcpWaitOutput,
  open: mcpOpen
};

api.onMcpQuery(async ({ reqId, op, args }) => {
  let result = null;
  try {
    result = (await MCP_OPS[op]?.(args || {})) ?? null;
  } catch (e) {
    result = { error: String(e?.message || e) };
  }
  api.mcpReply(reqId, result);
});
