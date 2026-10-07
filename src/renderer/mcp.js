// The renderer's half of Frost's MCP server: main asks, this window answers
// about the panes it holds — which there are, what one of them printed, and
// what is selected. Main only ever forwards the answers to the agent that
// asked; nothing here changes what is on screen.

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
    return `shell of agent ${owner?.name || ''}`.trim();
  }
  return paneLabel(leaf);
}

function mcpDescribe({ tab, leaf }) {
  const marks = liveMarks(leaf);
  const last = marks[marks.length - 1];
  const running = last && last.exit === null ? runningOutput(leaf, marks) : null;
  const finished = marks.length >= 2 ? marks[marks.length - 2] : null;
  const focused = document.hasFocus() && leaf.el.contains(document.activeElement);
  const d = {
    pane: leaf.ptyId,
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

api.onMcpQuery(({ reqId, op, args }) => {
  let result = null;
  try {
    if (op === 'panes') result = mcpPanes().map(mcpDescribe);
    else if (op === 'read') result = mcpRead(args);
    else if (op === 'selection') result = mcpSelection();
  } catch (e) {
    result = op === 'read' ? { error: String(e?.message || e) } : null;
  }
  api.mcpReply(reqId, result);
});
