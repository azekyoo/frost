// ---------- a command's output, to an agent ----------
// Tests fail in the shell beside an agent, and the agent is who has to know.
// The command, how it ended and what it printed go into the agent's prompt as
// one message — pasted, not submitted, as review comments are.

const OUTPUT_HEAD = 40; // lines kept from the top of a long output…
const OUTPUT_TAIL = 300; // …and from the bottom, where a failure usually says why

// Whether path p is dir or inside it, as Windows compares paths
function pathWithin(dir, p) {
  const norm = (x) => String(x || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const d = norm(dir);
  const x = norm(p);
  return !!d && !!x && (x === d || x.startsWith(d + '\\'));
}

// Whose output this is to be: a docked shell's own session; otherwise the agent
// working in the folder the shell is in, or the only agent there is.
function agentForPane(node) {
  if (!node) return null;
  if (node.dockOwner) return agentsByPty.get(node.dockOwner.ptyId) || null;
  if (agentsByPty.has(node.ptyId)) return null; // the agent's own terminal
  const all = [...globalAgents.values()];
  const here = all.filter((a) => pathWithin(a.cwd, node.cwd) || pathWithin(node.cwd, a.cwd));
  const selected = agentTabs()[0]?.selected;
  return here.find((a) => a.id === selected) || here[0] || (all.length === 1 ? all[0] : null);
}

function outputPrompt(out, cwd) {
  const folder = String(cwd || '').split(/[\\/]/).pop();
  // a remote prompt says where the command ran better than the local folder
  const where = out.host || folder;
  const on = where ? (out.host ? ' on ' : ' in ') + where : '';
  const cmd = out.command ? '`' + out.command + '`' : 'This command';
  // no exit code: a remote command's, or a selection's, which nothing reports
  const how = out.selection ? '' : out.running ? ' is still running' : out.exit ? ` failed (exit ${out.exit})` : ' ran';
  let lines = out.output;
  if (lines.length > OUTPUT_HEAD + OUTPUT_TAIL) {
    const cut = lines.length - OUTPUT_HEAD - OUTPUT_TAIL;
    lines = [...lines.slice(0, OUTPUT_HEAD), `… ${cut} lines left out …`, ...lines.slice(-OUTPUT_TAIL)];
  }
  const head = out.selection
    ? `From the shell${on}:`
    : `${cmd}${how}${on}` + (lines.length ? ':' : ', printing nothing.');
  return lines.length ? [head, '', '```', ...lines, '```'].join('\n') : head;
}

// Brought on screen wherever its pane lives, with the keyboard in it
function revealAgent(agent) {
  const host = agentTabs().find((t) => t.centerLeaves.has(agent.leaf));
  if (host) {
    activateTab(host);
    selectAgent(host, agent.id);
    return;
  }
  const tab = tabOfPane(agent.leaf);
  if (tab) {
    activateTab(tab);
    focusPane(agent.leaf);
  }
}

// picked: one command block's output, sent instead of the last command's
function sendOutputToAgent(node, picked) {
  if (!node) return;
  const agent = agentForPane(node);
  if (!agent?.leaf?.term) {
    const why = agentsByPty.has(node.ptyId)
      ? 'Run the command in a shell, not in the agent'
      : 'No agent to send it to — none is working in this folder';
    toast(why, { error: true });
    return;
  }
  const out = picked || commandOutput(node);
  if (!out) {
    const why = liveMarks(node).length ? 'No finished command to send yet' : 'No command marks yet — this shell has not reported one';
    toast(why, { error: true });
    return;
  }
  agent.leaf.term.paste(outputPrompt(out, node.cwd));
  // sent: the selection has done its job, and the button goes back to the output
  if (out.selection) node.term.clearSelection();
  const tab = dockHostOf(node);
  if (tab) renderDockSend(tab);
  revealAgent(agent);
  toast(`Sent to ${agent.name} — press Enter to submit`);
}

function renderDockSend(tab) {
  const btn = tab.els?.dockSend;
  if (!btn) return;
  // a selection is what gets sent when there is one, so it names the button first
  const selected = !!tab.dockShown?.term.hasSelection();
  // red for as long as the last command is a failure — what Send takes
  const failed = !selected && !!tab.dockShown?.dockFailed;
  btn.classList.toggle('failed', failed);
  btn.classList.toggle('selection', selected);
  btn.querySelector('span').textContent = selected ? 'Send selection' : failed ? 'Send failure' : 'Send output';
  btn.title = selected
    ? keyText("Send the selected text to this session's agent (Ctrl+Shift+S)")
    : keyText("Send the last command's output to this session's agent (Ctrl+Shift+S)");
}
