// Command blocks: every command in the scrollback, with what it printed, is one
// thing to act on. Hovering one outlines it and offers what otherwise takes a
// careful drag or a retype: the command or its output on the clipboard, the
// command run again, the output handed to the agent. The command marks already
// know where each one begins and ends; this only puts a hand on them.

// how long the pointer rests before a block is offered: passing over the
// scrollback on the way somewhere else shouldn't light every command it crosses
const BLOCK_DWELL = 250;

const blocksOn = () => state.theme?.commandBlocks !== false;

// The finished command whose rows hold this buffer row, if any. Its rows run
// from its prompt to the next one, or to the first empty prompt after it.
function blockAt(node, row) {
  const marks = liveMarks(node);
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    const last = i === marks.length - 1;
    const start = mark.marker.line;
    const stop = last
      ? node.term.buffer.active.length
      : mark.end && !mark.end.isDisposed
        ? mark.end.line
        : marks[i + 1].marker.line;
    if (row < start || row >= stop) continue;
    const inner = foreignBlockAt(node, mark, start, stop, row);
    if (inner) return inner;
    // the last mark is a prompt still waiting, or a command still running
    return mark.exit === null ? null : { mark, start, stop };
  }
  return null;
}

// A shell Frost's hooks aren't in (the far end of ssh, most often) marks
// nothing, so to the marks its whole session is one command. Inside it, the
// commands are found by their prompts instead, each running to the next one.
// How they exited isn't known.
function foreignBlockAt(node, mark, start, stop, row) {
  const buf = node.term.buffer.active;
  let from = start + 1;
  while (from < stop && buf.getLine(from)?.isWrapped) from++;
  const lines = bufferLines(node.term, from, stop - 1);
  const prompts = [];
  lines.forEach((l, i) => {
    const m = FOREIGN_PROMPT.exec(l.text);
    if (m) prompts.push({ i, row: l.row, host: m[1] || '', command: m[2].trim() });
  });
  for (let p = 0; p < prompts.length; p++) {
    const cur = prompts[p];
    const next = prompts[p + 1];
    // in a session still going, the last prompt is waiting or still running
    if (!cur.command || (!next && mark.exit === null)) continue;
    const end = next ? next.row : stop;
    if (row < cur.row || row >= end) continue;
    const output = lines.slice(cur.i + 1, next ? next.i : lines.length).map((l) => l.text);
    while (output.length && !output[output.length - 1]) output.pop();
    const foreign = { command: cur.command, output, exit: null, host: cur.host || null, clean: true };
    return { mark, start: cur.row, stop: end, foreign };
  }
  return null;
}

// the far end sitting at an empty prompt, inside the session still running
// here: what is typed now runs there
function foreignIdle(node, block) {
  const marks = liveMarks(node);
  if (block.mark !== marks[marks.length - 1]) return false;
  const buf = node.term.buffer.active;
  const m = FOREIGN_PROMPT.exec(buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) || '');
  return !!m && !m[2].trim();
}

const blockIdle = (node, block) => (block.foreign ? foreignIdle(node, block) : shellIdle(node));

// at a prompt with nothing running: typing a command now runs it. Output
// can't tell: Start-Sleep prints nothing while it runs. So Enter is what starts
// a command, and the next prompt is what ends it.
function shellIdle(node) {
  const marks = liveMarks(node);
  const last = marks[marks.length - 1];
  return !!last && last.exit === null && !node.shellBusy && !runningOutput(node, marks);
}

const BLOCK_BAR = `
  <span class="cmd-exit"></span>
  <button data-act="command" title="Copy the command">
    <svg viewBox="0 0 16 16"><path d="m3.5 5 3 3-3 3M8.5 11h4" /></svg><span>Command</span>
  </button>
  <button data-act="output" title="Copy what it printed">
    <svg viewBox="0 0 16 16"><rect x="5.25" y="5.25" width="8" height="8" rx="1.5" /><path d="M10.75 5.25v-1.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1.5" /></svg><span>Output</span>
  </button>
  <button data-act="run" title="Run it again">
    <svg viewBox="0 0 16 16"><path d="M12.75 8a4.75 4.75 0 1 1-1.4-3.36M12.75 2.75v3h-3" /></svg><span>Run</span>
  </button>
  <button data-act="send" title="Send the command and its output to the agent">
    <svg viewBox="0 0 16 16"><path d="M2.75 8h9.5M8.75 4.5 12.25 8l-3.5 3.5" /></svg><span>Send</span>
  </button>`;

function attachCommandBlocks(node) {
  const band = document.createElement('div');
  band.className = 'cmd-band';
  const bar = document.createElement('div');
  bar.className = 'cmd-bar';
  bar.innerHTML = BLOCK_BAR;
  node.el.append(band, bar);
  const b = { node, band, bar, block: null, pointer: null, timer: null };
  // a link (a path) under the pointer goes first; panes.js calls this when one
  // is entered, since links are found after the move that reaches them
  node.holdBlock = () => blockHide(b);

  node.el.addEventListener('mousemove', (ev) => {
    if (bar.contains(ev.target)) return;
    b.pointer = { x: ev.clientX, y: ev.clientY };
    // a button held is a selection being dragged: the bar would be in its way
    if (ev.buttons || node.onLink) return blockHide(b);
    // once offered it follows the pointer at once; the first offer waits
    clearTimeout(b.timer);
    if (b.block) blockUpdate(b);
    else b.timer = setTimeout(() => blockUpdate(b), BLOCK_DWELL);
  });
  node.el.addEventListener('mouseleave', () => {
    b.pointer = null;
    blockHide(b);
  });
  // the rows move under a resting pointer when the view scrolls
  node.term.onScroll(() => b.block && blockUpdate(b));
  node.term.onResize(() => blockHide(b));
  node.term.onData((data) => {
    if (!data.includes('\r')) return;
    node.shellBusy = true;
    if (b.block) blockUpdate(b);
  });
  // a command finishing changes what Run can do, under a pointer that hasn't
  // moved. Registered after the marks' handler, so it runs first and passes
  // on: the update waits until the mark has been recorded.
  node.term.parser.registerOscHandler(133, (data) => {
    if (String(data).startsWith('A')) node.shellBusy = false;
    if (b.block) setTimeout(() => b.block && blockUpdate(b));
    return false;
  });
  // the terminal keeps the focus and its selection: the bar is a tool, not a field
  bar.addEventListener('mousedown', (ev) => ev.preventDefault());
  bar.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    if (btn && !btn.disabled && b.block) blockAct(b, btn.dataset.act);
  });
}

function blockHide(b) {
  clearTimeout(b.timer);
  b.block = null;
  b.band.classList.remove('on');
  b.bar.classList.remove('on');
}

function blockUpdate(b) {
  const { node } = b;
  const term = node.term;
  const screen = term.element?.querySelector('.xterm-screen');
  // a full-screen program (vim, claude) owns the screen, and has no commands
  if (!b.pointer || !screen || !blocksOn() || term.buffer.active.type !== 'normal') return blockHide(b);
  const box = screen.getBoundingClientRect();
  const y = b.pointer.y - box.top;
  if (y < 0 || y >= box.height) return blockHide(b);
  const cellH = box.height / term.rows;
  const top = term.buffer.active.viewportY;
  const found = blockAt(node, top + Math.floor(y / cellH));
  if (!found) return blockHide(b);
  b.block = found;

  // the part of it on screen; an edge cut off by the view is drawn open
  const pane = node.el.getBoundingClientRect();
  const r0 = Math.max(found.start - top, 0);
  const r1 = Math.min(found.stop - top, term.rows);
  const ox = box.left - pane.left;
  const oy = box.top - pane.top;
  const failed = !found.foreign && found.mark.exit !== 0;
  Object.assign(b.band.style, {
    left: ox - 6 + 'px',
    width: box.width + 12 + 'px',
    top: oy + r0 * cellH + 'px',
    height: (r1 - r0) * cellH + 'px'
  });
  b.band.classList.toggle('failed', failed);
  b.band.classList.toggle('cut-top', found.start < top);
  b.band.classList.toggle('cut-bottom', found.stop > top + term.rows);
  b.band.classList.add('on');

  // pinned to the top of what is visible of it, so a long output scrolled
  // halfway still has its tools in reach
  const bar = b.bar;
  bar.style.top = oy + r0 * cellH + 3 + 'px';
  bar.style.right = pane.right - box.right + 2 + 'px';
  const exit = bar.querySelector('.cmd-exit');
  exit.textContent = failed ? `✕ ${found.mark.exit}` : '✓';
  exit.classList.toggle('failed', failed);
  exit.title = failed ? `Exited with code ${found.mark.exit}` : 'Succeeded';
  exit.hidden = !!found.foreign;
  const run = bar.querySelector('[data-act="run"]');
  run.disabled = !blockIdle(node, found);
  run.title = run.disabled ? 'Something is still running in this shell' : 'Run it again';
  bar.querySelector('[data-act="send"]').hidden = !agentForPane(node);
  bar.classList.add('on');
}

function blockAct(b, act) {
  const { node, block } = b;
  const out = block.foreign || markOutput(node, commandRegion(node, block.mark));
  if (!out) return toast('That command is no longer in the scrollback', { error: true });

  if (act === 'command') {
    if (!out.command) return toast('Nothing was typed at that prompt', { error: true });
    navigator.clipboard.writeText(out.command);
    toast('Command copied');
  } else if (act === 'output') {
    if (!out.output.length) return toast('That command printed nothing');
    navigator.clipboard.writeText(out.output.join('\n'));
    toast(`Output copied — ${out.output.length} line${out.output.length === 1 ? '' : 's'}`);
  } else if (act === 'run') {
    if (!out.command) return toast('Nothing was typed at that prompt', { error: true });
    if (!blockIdle(node, block)) return toast('Something is still running in this shell', { error: true });
    // from a prompt Frost can't read, the text may still carry part of it:
    // typed out for a look rather than run blind
    api.ptyInput(node.ptyId, out.clean ? out.command + '\r' : out.command);
    if (out.clean && !block.foreign) node.shellBusy = true;
    node.term.scrollToBottom();
    node.term.focus();
    blockHide(b);
  } else if (act === 'send') {
    sendOutputToAgent(node, out);
  }
}
