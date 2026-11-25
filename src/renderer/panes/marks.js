// ---------- command marks ----------
// The prompt hooks emit OSC 133: A where a prompt starts, D;<exit> when the
// command that was typed at the previous prompt finishes. That gives every
// command a position in the scrollback and a result, which is what makes
// jumping between them and colouring the scrollbar possible.

const MARK_LIMIT = 500;
const MARK_OK = '#2ea043';
const MARK_FAIL = '#f85149';

function attachCommandMarks(node) {
  node.marks = [];
  node.lastExit = null;

  node.term.parser.registerOscHandler(133, (data) => {
    const [kind, arg] = String(data).split(';');

    if (kind === 'A') {
      // Ctrl+L: ConPTY passes the redrawn prompt's A through before it paints
      // the cleared screen, so the cursor is still on the old row when it
      // comes — a blank one now. The prompt itself lands at the top.
      const buf = node.term.buffer.active;
      const blank = !buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true).trim();
      const offset = node.clearedScreen && blank ? -buf.cursorY : 0;
      node.clearedScreen = false;
      const marker = node.term.registerMarker(offset);
      if (!marker) return true;
      // a prompt that never got a D had nothing run at it — Enter on an empty
      // line, Ctrl+C on a half-typed one. It's no command, and kept as one it
      // would stand between the last real command and everything that looks
      // for it. Its line is still where the command before it stopped
      // printing, though: the first such prompt is kept as that command's end.
      const prev = node.marks[node.marks.length - 1];
      if (prev && prev.exit === null) {
        node.marks.pop();
        const ran = node.marks[node.marks.length - 1];
        if (ran && !ran.end) ran.end = prev.marker;
        else prev.marker.dispose();
      }
      node.marks.push({ marker, exit: null, decoration: null, end: null });
      // scrollback is finite, and so is the number of marks worth keeping
      while (node.marks.length > MARK_LIMIT) {
        const old = node.marks.shift();
        old.decoration?.dispose();
        old.marker.dispose();
        old.end?.dispose();
        old.input?.marker.dispose();
      }
      return true;
    }

    if (kind === 'D') {
      node.clearedScreen = false; // a command ran: the next prompt is where it says
      // D closes the command typed at the previous prompt, which is the mark
      // made just before it
      const mark = node.marks[node.marks.length - 1];
      if (!mark || mark.exit !== null) return true;
      const exit = Number(arg);
      mark.exit = Number.isFinite(exit) ? exit : 0;
      node.lastExit = mark.exit;
      try {
        mark.decoration = node.term.registerDecoration({
          marker: mark.marker,
          overviewRulerOptions: { color: mark.exit === 0 ? MARK_OK : MARK_FAIL, position: 'left' }
        });
      } catch {}
      node.onCommandDone?.(mark);
      return true;
    }

    if (kind === 'B') {
      // Where the prompt ends and typing begins (the bash and zsh hooks send it).
      // Recorded on the prompt's mark so the command can be cut from the
      // prompt exactly, whatever the prompt looks like. Passed on, like C.
      const mark = node.marks[node.marks.length - 1];
      if (mark && mark.exit === null && !mark.input) {
        const marker = node.term.registerMarker(0);
        if (marker) mark.input = { marker, x: node.term.buffer.active.cursorX };
      }
      return false;
    }

    return false; // C and anything else aren't ours to claim
  });

  // Clearing the screen (cls, clear, Ctrl+L) blanks the rows but leaves their
  // markers where they were, so the next command's output is written over old
  // marks — and each one reads as a command starting mid-output. The marks on
  // the rows a clear erases go with it. A command still running (cls itself,
  // or a program redrawing its screen) keeps its mark, moved to where the
  // cleared screen starts, since everything printed from there on is its own.
  node.term.parser.registerCsiHandler({ final: 'J' }, (params) => {
    const buf = node.term.buffer.active;
    if (buf.type !== 'normal') return false; // a full-screen program's own screen
    const mode = params[0] || 0;
    const cursor = buf.baseY + buf.cursorY;
    const cleared = (line) =>
      mode === 0 ? line > cursor || (line === cursor && buf.cursorX === 0)
      : mode === 1 ? line >= buf.baseY && line <= cursor
      : mode === 2 ? line >= buf.baseY
      : true; // 3: the scrollback too
    const running = node.marks[node.marks.length - 1];
    const moves = running && running.exit === null && !running.marker.isDisposed && cleared(running.marker.line);
    node.marks = node.marks.filter((m) => {
      if (m === running && running.exit === null) return true;
      if (m.marker.isDisposed || !cleared(m.marker.line)) return true;
      m.decoration?.dispose();
      m.marker.dispose();
      m.end?.dispose();
      return false;
    });
    if (mode >= 2) node.clearedScreen = true;
    if (moves) {
      // offset from the cursor's row: the cursor's own row for a clear below
      // it, the top of the screen for the rest
      const marker = node.term.registerMarker(mode === 0 ? 0 : -buf.cursorY);
      running.marker.dispose();
      if (marker) running.marker = marker;
      else node.marks.pop();
    }
    return false; // the terminal still does the clearing
  });
}

// ---------- what one command printed ----------
// The marks already know where every command began; between two of them is
// exactly one command's output, which is the thing worth having on the
// clipboard and the thing that is most tedious to select by hand — it is
// usually longer than the screen, so selecting it means dragging past both
// ends without overshooting.
//
// A mark sits on the line the prompt was drawn on, and the next mark on the
// line of the prompt after it. So the output is what lies between them, minus
// the rows the prompt and the typed command themselves take up: a long command
// wraps, and every wrapped row belongs to the command, not to its output.

function liveMarks(node) {
  return (node?.marks || []).filter((m) => !m.marker.isDisposed).sort((a, b) => a.marker.line - b.marker.line);
}

// The last finished command, wherever the screen is scrolled to: it is the one
// that just ran, and the one a Send or a copy means. Or the given mark's, for a
// command block picked out of the scrollback.
// Where a prompt's typed line ends: the prompt's own row, or the row its end
// mark (133;B) was on when the prompt runs over several (Git Bash's
// "user@host MINGW64 /c/x" over "$ ").
function promptInputRow(mark) {
  const inp = mark.input;
  return inp && !inp.marker.isDisposed && inp.marker.line >= mark.marker.line ? inp.marker.line : mark.marker.line;
}

// The first row a command printed: past the prompt and the rows the typed
// line wrapped onto.
function outputStart(buf, mark, limit) {
  let start = promptInputRow(mark) + 1;
  while (start < limit && buf.getLine(start)?.isWrapped) start++;
  return start;
}

// The first row of a prompt worth outlining: one that begins with an empty
// line (Git Bash's does) has its mark on that blank row, above the prompt.
// Only a prompt that said where it ends is trimmed, and never past that end.
function promptTop(node, mark) {
  const buf = node.term.buffer.active;
  let top = mark.marker.line;
  if (!mark.input) return top;
  const last = promptInputRow(mark);
  while (top < last && !buf.getLine(top)?.translateToString(true).trim()) top++;
  return top;
}

function commandRegion(node, mark) {
  const term = node?.term;
  if (!term) return null;
  const marks = liveMarks(node);
  if (marks.length < 2) return null;
  const buf = term.buffer.active;
  const index = mark ? marks.indexOf(mark) : marks.length - 2; // the last one that has finished
  // the last mark is the prompt still waiting: nothing after it to end it
  if (index < 0 || index > marks.length - 2) return null;

  // up to the next prompt — the first empty one after it, when there were any
  const own = marks[index].end;
  const stop = own && !own.isDisposed ? own.line : marks[index + 1].marker.line;
  const start = outputStart(buf, marks[index], stop);
  const end = stop - 1;
  // end < start: a command that printed nothing, which is still a command —
  // one that failed silently is worth sending
  return { start, end, mark: marks[index] };
}

// Rows start..end as text, a wrapped row joined back onto the one it continues.
// Read off the buffer rather than through a selection: selecting would put the
// text on the clipboard as well, with copy-on-select on.
//
// xterm only knows a row is a continuation when it did the wrapping itself. A
// program that breaks its own lines at the edge — a remote shell over ssh
// redrawing what you type, ConPTY repainting after a resize — sends a real
// newline instead. A row filled to its last column is taken as one of those:
// a line that happens to end exactly at the edge is rarer than one cut there.
function bufferText(term, start, end) {
  return bufferLines(term, start, end).map((l) => l.text);
}

// The same, each line with the row it starts on.
function bufferLines(term, start, end) {
  const buf = term.buffer.active;
  const out = [];
  let joinNext = false;
  for (let i = start; i <= end; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if ((line.isWrapped || joinNext) && out.length) out[out.length - 1].text += text;
    else out.push({ row: i, text });
    const last = line.getCell(term.cols - 1)?.getChars() || '';
    joinNext = last !== '' && last !== ' ';
  }
  for (const l of out) l.text = l.text.replace(/\s+$/, '');
  return out;
}

// A prompt drawn by a shell Frost's hooks aren't in — the far end of an ssh
// session, most often: "user@host:~# cmd", or a remote PowerShell's "PS x> cmd".
const FOREIGN_PROMPT = /^(?:\[?([\w.-]+@[\w.-]+)[^#$\n]{0,80}?[#$]|PS [^>\n]{1,200}>) ?(.*)$/;

// What was typed at a prompt that marked its own end (133;B): the text from
// that column on, through the rows the command wrapped onto, up to (not
// including) row `stop`. Null without the mark — the hooks on Windows don't
// send it, and their prompts are recognised by shape instead.
function typedCommand(term, mark, stop) {
  const inp = mark?.input;
  if (!inp || inp.marker.isDisposed) return null;
  const from = inp.marker.line;
  if (from < mark.marker.line || from >= stop) return null;
  const buf = term.buffer.active;
  let text = buf.getLine(from)?.translateToString(true, inp.x) || '';
  for (let i = from + 1; i < stop; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    text += (line.isWrapped ? '' : ' ') + line.translateToString(true);
  }
  return text.trim();
}

// The last mark's command, while it is still running — ssh, a REPL, a watcher.
// Its output never ends in a mark of Frost's, so the command worth sending is
// found by the prompts inside it: the last one that ran something, up to the
// prompt after it. With none to go by, everything it has printed so far.
function runningOutput(node, marks) {
  const mark = marks[marks.length - 1];
  const buf = node.term.buffer.active;
  const start = outputStart(buf, mark, buf.length);
  let end = buf.length - 1;
  while (end >= start && !buf.getLine(end)?.translateToString(true).trim()) end--;
  if (end < start) return null; // an idle prompt: nothing is running
  const local =
    typedCommand(node.term, mark, start) ??
    bufferText(node.term, mark.marker.line, start - 1).join(' ').replace(/^PS [^>]*>\s*/, '').trim();
  const lines = bufferText(node.term, start, end);
  const prompts = [];
  lines.forEach((l, i) => {
    const m = FOREIGN_PROMPT.exec(l);
    if (m) prompts.push({ i, host: m[1] || '', command: m[2].trim() });
  });
  // what was typed at the prompt still waiting at the bottom hasn't run
  const ran = prompts.filter((p) => p.command && p.i < lines.length - 1);
  const last = ran[ran.length - 1];
  if (!last) return { command: local, output: lines, exit: null, running: true };
  const next = prompts.find((p) => p.i > last.i);
  const output = lines.slice(last.i + 1, next ? next.i : lines.length);
  while (output.length && !output[output.length - 1]) output.pop();
  return { command: last.command, output, exit: null, host: last.host || null };
}

// The last command, as what was typed, what it printed and how it
// ended — for handing to an agent. The prompt's own text is taken off the
// command where it can be recognised: PowerShell's "PS C:\x> ", or the "$ "
// line under Git Bash's two-line prompt, which then isn't output either.
// What is selected, when something is, is taken as it stands instead: it is
// the one thing that works for any program at all.
function commandOutput(node) {
  const term = node?.term;
  if (!term) return null;
  if (term.hasSelection()) {
    const text = term.getSelection().split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
    while (text.length && !text[text.length - 1]) text.pop();
    if (text.length) return { command: '', output: text, exit: null, selection: true };
  }
  const marks = liveMarks(node);
  if (marks.length && marks[marks.length - 1].exit === null) {
    const running = runningOutput(node, marks);
    if (running) return running;
  }
  return markOutput(node, commandRegion(node));
}

// One finished command's text, as commandOutput gives it: what was typed, what
// it printed, how it ended.
function markOutput(node, region) {
  const term = node?.term;
  if (!term || !region) return null;
  const promptRows = bufferText(term, region.mark.marker.line, region.start - 1);
  let output = bufferText(term, region.start, region.end);
  let command = promptRows.join(' ').trim();
  // the prompt said where it ends: everything after that is what was typed
  const typed = typedCommand(term, region.mark, region.start);
  if (typed !== null) {
    while (output.length && !output[output.length - 1]) output.pop();
    return { command: typed, output, exit: region.mark.exit, clean: true };
  }
  if (/^\$ /.test(output[0] || '')) {
    command = output[0];
    output = output.slice(1);
  }
  // a prompt of our own hooks' shape: what is left of it is only what was typed.
  // Any other prompt (oh-my-posh, starship) is still in the command text.
  const clean = /^(PS [^>]*>|\$ )/.test(command);
  command = command.replace(/^PS [^>]*>\s*/, '').replace(/^\$ /, '').trim();
  while (output.length && !output[output.length - 1]) output.pop();
  return { command, output, exit: region.mark.exit, clean };
}

function selectCommandOutput(node) {
  const region = commandRegion(node);
  if (!region || region.end < region.start) {
    // cmd and WSL profiles install no prompt hook, so they never report one
    toast(
      liveMarks(node).length
        ? 'That command printed nothing'
        : 'No command marks yet — this shell has not reported one'
    );
    return null;
  }
  node.term.selectLines(region.start, region.end);
  // xterm's own selection knows which rows are continuations of one long line,
  // so this is the output as it was printed rather than as it was wrapped
  return node.term.getSelection();
}

// Scrolls to the nearest command prompt above or below what's on screen.
function jumpToMark(node, dir) {
  if (!node?.marks?.length) return;
  const term = node.term;
  const top = term.buffer.active.viewportY;
  const lines = node.marks
    .filter((m) => !m.marker.isDisposed)
    .map((m) => m.marker.line)
    .sort((a, b) => a - b);
  const target =
    dir < 0
      ? [...lines].reverse().find((line) => line < top - 1)
      : lines.find((line) => line > top + 1);
  if (target === undefined) {
    toast(dir < 0 ? 'No earlier command' : 'No later command');
    return;
  }
  term.scrollToLine(Math.max(0, target));
}

// OSC 9;9;<path> — Windows Terminal's cwd sequence, what our prompt hooks emit.
// OSC 7;file://host/<path> — the same thing from anything already emitting it.
function attachCwdTracking(node) {
  node.term.parser.registerOscHandler(9, (data) => {
    if (!data.startsWith('9;')) return false; // OSC 9 also carries notify/progress
    setPaneCwd(node, data.slice(2).trim());
    return true;
  });
  node.term.parser.registerOscHandler(7, (data) => {
    const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
    if (!m) return false;
    // /C:/Users/... -> C:/Users/...
    setPaneCwd(node, decodeURIComponent(m[1]).replace(/^\/([A-Za-z]:)/, '$1'));
    return true;
  });
}

