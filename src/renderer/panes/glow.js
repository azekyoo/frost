// ---------- typing glow ----------
// Each character typed lights up where it lands and fades out, in the accent
// colour. Where it lands is read off the screen, not guessed: the shell echoes
// it, and the cell just behind the cursor then holds that very character. A
// program drawing its own cursor somewhere else (claude does) or not echoing at
// all (a password prompt) leaves nothing to match, and nothing lights up in the
// wrong place.
//
// Deleting gets the same in red: the cells that emptied light up, with the
// character that was there fading out of them. Again read off the screen —
// the line as it stood when the key went down, against the line after.

const GLOW_WAIT_MS = 250; // how long a key may take to come back as an echo
// ...counted from when its row starts being redrawn, not from the key: a busy
// program (claude, deep into a long session) can sit on a key for most of a
// second before drawing anything, and its other output meanwhile (a spinner)
// would otherwise run the clock out before the echo ever came. This long in
// all, though, and the key is given up on — a password prompt never answers.
const GLOW_MAX_WAIT_MS = 2000;

// Backspace (DEL, or ^H), Ctrl+W and Alt/Ctrl+Backspace rub out behind the
// cursor; the Delete key takes the character under it
const ERASE_BACK = new Set(['\x7f', '\b', '\x17', '\x1b\x7f', '\x1b\b']);
const ERASE_FORWARD = '\x1b[3~';

// look: how the cell is drawn, so a grey prediction turning into real text
// counts as a change even though the letter is the same
function lineCells(line, cols) {
  const out = [];
  for (let x = 0; x < cols; x++) {
    const c = line.getCell(x);
    out.push({
      ch: c?.getChars() || '',
      w: c?.getWidth() ?? 1,
      look: c ? `${c.getFgColorMode()}:${c.getFgColor()}:${c.isDim()}:${c.isItalic()}` : ''
    });
  }
  return out;
}

// A row as it reads and as it is drawn, to tell when it has been redrawn
function rowLook(buf, y, cols) {
  const line = buf.getLine(y);
  return line ? lineCells(line, cols).map((c) => c.ch + c.look).join('|') : '';
}

// Something waiting on an echo ({ y, row, at }): has its row changed since the
// key, and when last. Each change restarts the wait — a slow program may draw
// a few keys typed together one redraw at a time.
function rowStirred(w, buf, cols, now) {
  const look = rowLook(buf, w.y, cols);
  if (look !== w.row) {
    w.row = look;
    w.stirred = now;
  }
  return w.stirred != null;
}

// True once it's no use waiting any longer for the echo
function echoGivenUp(w, buf, cols, now, wait = GLOW_WAIT_MS) {
  if (now - w.at > GLOW_MAX_WAIT_MS) return true;
  return rowStirred(w, buf, cols, now) && now - w.stirred > wait;
}

// A paste: the text, wrapped in bracketed-paste markers when the program
// asked for them
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const PASTE_GLOW_MAX = 600; // characters; past that it's a dump, not an input
const ACCEPT_ROWS = 8; // how far below the cursor a taken suggestion may run
const ERASE_ROWS = 8; // how far above the cursor a word rubbed out may have started
// → and End (normal and application cursor modes), Ctrl+→, Ctrl+E, Ctrl+F,
// Tab, ↑ and ↓
const FILL_KEYS = new Set([
  '\x1b[C', '\x1bOC', '\x1b[F', '\x1bOF', '\x1b[4~', '\x1b[1;5C', '\x05', '\x06',
  '\t', '\x1b[A', '\x1bOA', '\x1b[B', '\x1bOB'
]);

function attachTypingGlow(node) {
  const term = node.term;
  // Keys typed and not yet seen on screen, each with the cell it should land
  // in: where the cursor was for the first, one on from the key before for
  // the rest. Typing outruns the echo, so the cursor alone can't say where a
  // key goes — and matching letters backwards from it went wrong on a word
  // with a letter twice in it, dropping keys that had yet to come back.
  let pending = []; // { ch, x, y, at, missed }
  let newest = null; // the last key typed, waiting or not
  let fresh = true; // the next key starts from the cursor, not from the key before
  let erasing = null; // a delete key waiting for its echo: { y, x, cells, forward, at }
  let paste = null; // { chars, x, y, at }
  let pasteTimer = null;
  let accepting = null; // a key that may fill the line in: { x, y, cells, at }
  let acceptTimer = null;
  // the line as it stands when a delete key goes down, to tell its echo by
  const eraseFrom = (forward, more) => {
    const buf = term.buffer.active;
    const y = buf.baseY + buf.cursorY;
    const line = buf.getLine(y);
    if (!line) return null;
    // a word long enough to run past the edge started on a row above: keep
    // the rows this one wraps on from, so the cursor can go back up them
    let top = y;
    while (top > 0 && y - top < ERASE_ROWS && buf.getLine(top)?.isWrapped) top--;
    const above = [];
    for (let r = top; r < y; r++) above.push(lineCells(buf.getLine(r), term.cols));
    return { y, x: buf.cursorX, cells: lineCells(line, term.cols), top, above, forward, more, at: Date.now(), row: rowLook(buf, y, term.cols) };
  };
  const absCursor = () => {
    const buf = term.buffer.active;
    return { x: buf.cursorX, y: buf.baseY + buf.cursorY };
  };
  term.onData((d) => {
    if (state.theme?.typingGlow !== true) return; // off unless turned on
    if (ERASE_BACK.has(d) || d === ERASE_FORWARD) {
      const forward = d === ERASE_FORWARD;
      // pressed again before the last one came back: the line hasn't changed
      // yet to be looked at — count it, and look once the last one is in
      if (erasing && erasing.stirred == null && erasing.forward === forward) erasing.more++;
      else erasing = eraseFrom(forward, 0);
      fresh = true;
      return;
    }
    const text = d.startsWith(PASTE_START) ? d.slice(PASTE_START.length).replace(PASTE_END, '') : d;
    const isPaste = d.startsWith(PASTE_START) || ([...d].length > 1 && !d.startsWith('\x1b'));
    if (isPaste) {
      const chars = [...text].filter((c) => c.trim());
      if (chars.length && chars.length <= PASTE_GLOW_MAX) {
        const at = absCursor();
        paste = { chars, ...at, at: Date.now(), row: rowLook(term.buffer.active, at.y, term.cols) };
      }
      fresh = true;
      return;
    }
    // one printable character: a key, not an arrow or Enter
    if ([...d].length !== 1 || d < ' ') {
      fresh = true; // the cursor may have gone anywhere
      // Keys that fill the line in: → or End taking a suggestion, Tab
      // completing, ↑ ↓ bringing a command back. Only those — Ctrl+C or Enter
      // draw a whole new prompt, which is not something typed.
      if (FILL_KEYS.has(d)) {
        const at = absCursor();
        const buf = term.buffer.active;
        // the row the cursor is on and the ones under it: a long suggestion
        // runs on past the edge of the window
        const rows = [];
        for (let y = at.y; y < Math.min(buf.length, at.y + ACCEPT_ROWS); y++) rows.push(lineCells(buf.getLine(y), term.cols));
        accepting = { ...at, rows, at: Date.now(), row: rowLook(buf, at.y, term.cols) };
      }
      return;
    }
    // on from the last key typed, not the last still waiting: one that never
    // showed where it was looked for would drag every key after it off too
    const prev = pending.length ? newest : null;
    let at = fresh || !prev ? absCursor() : { x: prev.x + 1, y: prev.y };
    if (at.x >= term.cols) at = { x: at.x - term.cols, y: at.y + 1 };
    newest = { ch: d, ...at, at: Date.now(), row: rowLook(term.buffer.active, at.y, term.cols) };
    pending.push(newest);
    fresh = false;
  });
  term.onWriteParsed(() => {
    const now = Date.now();
    const buf = term.buffer.active;
    if (erasing) {
      if (glowErased(node, erasing)) erasing = erasing.more ? eraseFrom(erasing.forward, erasing.more - 1) : null;
      else if (echoGivenUp(erasing, buf, term.cols, now)) erasing = null;
    }
    if (paste) {
      if (now - paste.at > GLOW_MAX_WAIT_MS) paste = null;
      // a paste echoes in several writes: wait for the last of those that
      // change its row — any other output (a spinner) would put it off forever
      else if (rowStirred(paste, buf, term.cols, now) && paste.stirred === now) {
        clearTimeout(pasteTimer);
        const p = paste;
        pasteTimer = setTimeout(() => {
          if (paste === p) paste = null;
          glowPasted(node, p);
        }, 70);
      }
    }
    if (accepting) {
      if (echoGivenUp(accepting, buf, term.cols, now, 400)) accepting = null;
      else if (accepting.stirred === now) {
        // the line is redrawn in more than one write too
        clearTimeout(acceptTimer);
        const a = accepting;
        acceptTimer = setTimeout(() => {
          if (accepting === a) accepting = null;
          glowAccepted(node, a);
        }, 60);
      }
    }
    if (!pending.length) return;
    const cur = absCursor();
    let shift = 0; // a wide character landed: everything after it moves one on
    pending = pending.filter((p) => {
      p.x += shift;
      const line = buf.getLine(p.y);
      const cell = line?.getCell(p.x);
      // there, and the cursor gone past it: echoed, not just predicted text
      const past = cur.y > p.y || (cur.y === p.y && cur.x > p.x);
      if (cell && cell.getChars() === p.ch && past) {
        const width = cell.getWidth() || 1;
        shift += width - 1;
        glowCell(node, p.x, p.y - buf.viewportY, width, null, p.ch);
        return false;
      }
      p.missed = past; // the cursor went by, and the key isn't there
      return !echoGivenUp(p, buf, term.cols, now);
    });
    // The last key typed went by where it was looked for, but is just behind
    // the cursor: the line went on somewhere one-on-from-the-key-before can't
    // say — wrapped inside a box that stops short of the window's edge
    // (claude's prompt does). Light it there and start again from the cursor;
    // the keys still waiting before it were looked for in the same wrong place.
    if (newest?.missed && pending.includes(newest)) {
      const line = buf.getLine(cur.y);
      let x = cur.x - 1;
      if (line?.getCell(x)?.getWidth() === 0) x--; // the second half of a wide one
      const cell = line?.getCell(x);
      if (cell && cell.getChars() === newest.ch) {
        glowCell(node, x, cur.y - buf.viewportY, cell.getWidth() || 1, null, newest.ch);
        pending = [];
      }
    }
  });
}

// A copy is a scan: a green beam passes over what was selected, left to
// right, and leaves it lit for a moment behind it. One beam for the whole
// selection, cut to its rows, so a selection over several lines is swept as
// one — and only over text, not the blank end of a row.
function glowCopy(node) {
  const term = node.term;
  const pos = term.getSelectionPosition();
  if (!pos) return;
  const buf = term.buffer.active;
  const rows = [];
  for (let y = pos.start.y; y <= pos.end.y; y++) {
    const row = y - buf.viewportY;
    if (row < 0 || row >= term.rows) continue;
    const line = buf.getLine(y);
    const x0 = y === pos.start.y ? pos.start.x : 0;
    let x1 = y === pos.end.y ? pos.end.x : term.cols;
    while (x1 > x0 && !(line?.getCell(x1 - 1)?.getChars() || '').trim()) x1--;
    if (x1 > x0) rows.push({ row, x0, x1 });
  }
  scanRows(node, rows);
}

// A program that does its own selecting (claude in fullscreen takes the mouse)
// copies by handing the terminal the text — OSC 52 — and xterm never has a
// selection to scan. So the text is found on screen instead, and scanned
// there. It goes on the clipboard too, as any terminal would put it.
function attachOscCopy(node) {
  // where the mouse went down and came up: the same words can show more than
  // once (pasted twice), and the copy is the one that was dragged over
  const cellAt = (ev) => {
    const screen = node.term.element?.querySelector('.xterm-screen');
    if (!screen) return null;
    const box = screen.getBoundingClientRect();
    return {
      x: Math.floor(((ev.clientX - box.left) / box.width) * node.term.cols),
      row: Math.floor(((ev.clientY - box.top) / box.height) * node.term.rows)
    };
  };
  node.el.addEventListener('mousedown', (ev) => (node.mouseDrag = { from: cellAt(ev), to: null }), true);
  node.el.addEventListener('mouseup', (ev) => node.mouseDrag && (node.mouseDrag.to = cellAt(ev)), true);
  node.term.parser.registerOscHandler(52, (data) => {
    const b64 = data.slice(data.indexOf(';') + 1);
    if (!b64 || b64 === '?') return true; // a read: not something we answer
    let text;
    try {
      text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    } catch {
      return true;
    }
    if (!text) return true;
    navigator.clipboard.writeText(text);
    const d = node.mouseDrag;
    scanRows(node, rowsShowing(node, text, [d?.from, d?.to].filter(Boolean)));
    return true;
  });
}

// Where on screen the copied text is: its lines, one under the other, each
// whole on its row or running on to the next when it wrapped. Spaces aren't
// held to — a program lays text out its own way — so neither the text nor the
// screen is compared with them. Where it shows more than once, the place
// nearest the cells given (where the mouse was). Nothing, if it isn't all there.
function rowsShowing(node, text, near = []) {
  const term = node.term;
  const buf = term.buffer.active;
  const screen = [];
  for (let r = 0; r < term.rows; r++) {
    // each cell's place in the row, spaces left out
    const line = buf.getLine(buf.viewportY + r);
    let str = '';
    const at = [];
    for (let x = 0; x < term.cols; x++) {
      const c = line?.getCell(x)?.getChars() || '';
      if (!c.trim()) continue;
      str += c;
      for (let i = 0; i < c.length; i++) at.push(x);
    }
    screen.push({ str, at });
  }
  const wanted = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, '')).filter(Boolean);
  if (!wanted.length) return [];
  const from = (r, start) => {
    const rows = [];
    let i = 0; // the line looked for
    let rest = wanted[0];
    let off = start; // where in the row's text it starts
    for (; r < term.rows && i < wanted.length; r++) {
      const s = screen[r];
      const here = s.str.slice(off);
      const take = here.startsWith(rest) ? rest.length : rest.startsWith(here) && here ? here.length : -1;
      if (take < 0) return null;
      rows.push({ row: r, x0: s.at[off], x1: s.at[off + take - 1] + 1 });
      rest = rest.slice(take);
      if (!rest && ++i < wanted.length) rest = wanted[i];
      // a line goes on from the start of the next row; a new one may sit
      // anywhere on it, past a border or a bullet
      off = 0;
      if (!rest) break;
      if (rest === wanted[i] && r + 1 < term.rows) {
        const k = screen[r + 1].str.indexOf(rest.slice(0, Math.min(rest.length, 8)));
        if (k < 0) return null;
        off = k;
      }
    }
    return i >= wanted.length ? rows : null;
  };
  // how far a place is from the mouse: nothing for a cell inside it, else
  // rows apart, then columns
  const away = (rows) =>
    near.reduce((sum, p) => {
      let best = Infinity;
      for (const r of rows) {
        const dx = p.x < r.x0 ? r.x0 - p.x : p.x >= r.x1 ? p.x - r.x1 + 1 : 0;
        best = Math.min(best, Math.abs(p.row - r.row) * term.cols + dx);
      }
      return sum + best;
    }, 0);
  const head = wanted[0].slice(0, Math.min(wanted[0].length, 8));
  let found = [];
  let score = Infinity;
  // from the bottom up: with no mouse to go by, the newest place wins
  for (let r = term.rows - 1; r >= 0; r--) {
    let k = screen[r].str.lastIndexOf(head);
    while (k >= 0) {
      const rows = from(r, k);
      if (rows) {
        const d = away(rows);
        if (d < score) [found, score] = [rows, d];
        if (d === 0) return found;
      }
      k = k ? screen[r].str.lastIndexOf(head, k - 1) : -1;
    }
  }
  return found;
}

// The scan itself, over rows on screen: { row, x0, x1 }
function scanRows(node, rows) {
  if (state.theme?.typingGlow !== true) return;
  // one copy, however many ways it was asked for at once
  if (Date.now() - (node.copyGlowAt || 0) < 400) return;
  const term = node.term;
  const screen = term.element?.querySelector('.xterm-screen');
  if (!rows.length || !screen) return;
  node.copyGlowAt = Date.now();
  const cw = screen.clientWidth / term.cols;
  const ch = screen.clientHeight / term.rows;
  const left = Math.min(...rows.map((r) => r.x0));
  const right = Math.max(...rows.map((r) => r.x1));
  const first = rows[0].row;
  const span = (right - left) * cw;
  const g = document.createElement('div');
  g.className = 'copy-glow';
  g.style.left = left * cw + 'px';
  g.style.top = first * ch + 'px';
  g.style.width = span + 'px';
  g.style.height = (rows[rows.length - 1].row - first + 1) * ch + 'px';
  // a touch longer across a wide selection, always quick
  g.style.setProperty('--sweep', Math.round(Math.min(320, 160 + span * 0.15)) + 'ms');
  for (const r of rows) {
    const seg = document.createElement('div');
    seg.className = 'seg';
    const offset = (r.x0 - left) * cw;
    seg.style.left = offset + 'px';
    seg.style.top = (r.row - first) * ch + 'px';
    seg.style.width = (r.x1 - r.x0) * cw + 'px';
    seg.style.height = ch + 'px';
    const beam = document.createElement('div');
    beam.className = 'beam';
    // every row's beam travels the same line across the whole selection, so
    // together they read as one
    beam.style.setProperty('--from', -offset - 12 + 'px');
    beam.style.setProperty('--to', span - offset + 'px');
    seg.appendChild(beam);
    g.appendChild(seg);
  }
  screen.appendChild(g);
  setTimeout(() => g.remove(), 1600);
}

// A paste freezes along its length, one character after another, as if the
// frost were running through it. Its characters are found on screen in order
// from where the cursor was — a shell's continuation prompts in between are
// skipped — and if they can't all be found, it is somewhere other than where
// it was typed (a full-screen program), and nothing lights up.
function glowPasted(node, p) {
  const term = node.term;
  const buf = term.buffer.active;
  const end = { x: buf.cursorX, y: buf.baseY + buf.cursorY };
  const found = [];
  let i = 0;
  for (let y = p.y; y <= end.y && i < p.chars.length; y++) {
    const line = buf.getLine(y);
    if (!line) break;
    const from = y === p.y ? p.x : 0;
    const to = y === end.y ? end.x : term.cols;
    for (let x = from; x < to && i < p.chars.length; x++) {
      const cell = line.getCell(x);
      if (cell?.getChars() === p.chars[i]) {
        found.push({ x, y, ch: p.chars[i], w: cell.getWidth() || 1 });
        i++;
      }
    }
  }
  if (i < p.chars.length) return;
  glowRun(node, found);
}

// Cells frozen one after another, left to right: frost running along them
function glowRun(node, cells) {
  const step = Math.min(14, 420 / cells.length);
  cells.forEach((c, n) => {
    setTimeout(() => {
      const b = node.term.buffer.active;
      glowCell(node, c.x, c.y - b.viewportY, c.w, null, c.ch);
    }, n * step);
  });
}

// After → or End took a suggestion, or Tab completed a word: whatever arrived
// on the line freezes like a paste. What arrived is told from what was there
// by comparing the line before the key with the line after: from the cursor
// on, a cell that changed its text or how it is drawn — a grey prediction
// turned to real text — and behind the cursor, only one whose text changed
// (Tab rewriting the start of a word). A cursor moving over text that was
// already there changes nothing, and lights nothing.
function glowAccepted(node, a) {
  const term = node.term;
  const buf = term.buffer.active;
  const end = { x: buf.cursorX, y: buf.baseY + buf.cursorY };
  // the cursor has to have gone forward, and not off the rows looked at
  if (end.y < a.y || end.y >= a.y + a.rows.length || (end.y === a.y && end.x <= a.x)) return;
  const filled = [];
  for (let y = a.y; y <= end.y; y++) {
    const line = buf.getLine(y);
    if (!line) break;
    const now = lineCells(line, term.cols);
    const before = a.rows[y - a.y];
    const to = y === end.y ? end.x : term.cols;
    for (let x = 0; x < to; x++) {
      const c = now[x];
      const was = before[x];
      if (!c.ch.trim() || c.w === 0) continue;
      const ahead = y > a.y || x >= a.x;
      const changed = ahead ? c.ch !== was.ch || c.look !== was.look : c.ch !== was.ch;
      if (changed) filled.push({ x, y, ch: c.ch, w: c.w || 1 });
    }
  }
  if (filled.length && filled.length <= PASTE_GLOW_MAX) glowRun(node, filled);
}

// True once the echo has come back and been lit, false to keep waiting. Back:
// the cursor moved left on the same row, and every cell it moved over held
// something. Forward: the cursor stayed, and the cell under it changed.
function glowErased(node, e) {
  const buf = node.term.buffer.active;
  const y = buf.baseY + buf.cursorY;
  if (!e.forward && y < e.y && y >= e.top) return glowErasedUp(node, e, y);
  if (y !== e.y) return false;
  const row = y - buf.viewportY;
  if (e.forward) {
    if (buf.cursorX !== e.x) return false;
    const was = e.cells[e.x];
    const now = buf.getLine(y)?.getCell(e.x)?.getChars() || '';
    if (!was?.ch || now === was.ch) return false;
    glowCell(node, e.x, row, was.w || 1, was.ch);
    return true;
  }
  if (buf.cursorX >= e.x) return false;
  const gone = e.cells.slice(buf.cursorX, e.x);
  const letters = gone.filter((c) => c.w > 0 && c.ch.trim());
  if (letters.length > 1) {
    // a word at once (Ctrl+Backspace, Ctrl+W) breaks as the one thing it was
    glowCell(node, buf.cursorX, row, e.x - buf.cursorX, gone);
  } else {
    for (let x = buf.cursorX; x < e.x; x++) {
      const c = e.cells[x];
      if (c && c.w > 0 && c.ch) glowCell(node, x, row, c.w, c.ch);
    }
  }
  return true;
}

// The cursor went back up onto a row the line wrapped from: what was rubbed
// out runs from the cursor to the end of its row, over any rows in between,
// to where the cursor was. Each row's part breaks as a word of its own —
// a block can't bend round the edge of the window.
function glowErasedUp(node, e, y) {
  const term = node.term;
  const buf = term.buffer.active;
  const rows = [...e.above, e.cells];
  const parts = [];
  for (let r = y; r <= e.y; r++) {
    const from = r === y ? buf.cursorX : 0;
    const to = r === e.y ? e.x : term.cols;
    const gone = rows[r - e.top].slice(from, to);
    // the blank end of a row is nothing that was rubbed out
    while (gone.length && !gone[gone.length - 1].ch.trim()) gone.pop();
    if (gone.some((c) => c.w > 0 && c.ch.trim())) parts.push({ r, from, gone });
  }
  const letters = parts.flatMap((p) => p.gone.filter((c) => c.w > 0 && c.ch.trim()));
  if (letters.length === 1) {
    // one Backspace from the start of a row, back over the edge: a character
    const p = parts[0];
    const x = p.from + p.gone.indexOf(letters[0]);
    glowCell(node, x, p.r - buf.viewportY, letters[0].w || 1, letters[0].ch);
  } else for (const p of parts) glowCell(node, p.from, p.r - buf.viewportY, p.gone.length, p.gone);
  return true;
}

// Frost, literally. A typed character (typed) freezes: drawn again exactly
// over itself in ice white, glowing, then thawing back into its own colour —
// nothing moves, so nothing reads as a second copy. An erased one (erased: the
// character that was there) dissolves: drawn again over where it was, red-hot,
// it blurs, swells a little and fades out — all in one piece, evenly.

function glowCell(node, x, row, width, erased = null, typed = null) {
  const screen = node.term.element?.querySelector('.xterm-screen');
  if (!screen || x < 0 || row < 0 || row >= node.term.rows) return;
  const cw = screen.clientWidth / node.term.cols;
  const ch = screen.clientHeight / node.term.rows;
  const g = document.createElement('div');
  g.className = erased === null ? 'type-glow' : 'type-glow erased';
  g.style.left = x * cw + 'px';
  g.style.top = row * ch + 'px';
  g.style.width = width * cw + 'px';
  g.style.height = ch + 'px';
  const flash = document.createElement('div');
  flash.className = 'flash';
  g.appendChild(flash);
  if (erased === null) {
    const ice = document.createElement('div');
    ice.className = 'ice';
    ice.textContent = typed || '';
    ice.style.fontFamily = node.term.options.fontFamily;
    ice.style.fontSize = node.term.options.fontSize + 'px';
    ice.style.fontWeight = node.term.options.fontWeight;
    ice.style.lineHeight = ch + 'px';
    g.appendChild(ice);
  } else {
    const word = Array.isArray(erased);
    const melt = document.createElement('div');
    melt.className = word ? 'melt word' : 'melt';
    melt.style.fontFamily = node.term.options.fontFamily;
    melt.style.fontSize = node.term.options.fontSize + 'px';
    melt.style.fontWeight = node.term.options.fontWeight;
    melt.style.lineHeight = ch + 'px';
    if (!word) melt.textContent = erased;
    // a box per cell, so the word sits on the grid it was drawn on
    else {
      for (const c of erased) {
        if (c.w === 0) continue;
        const span = document.createElement('span');
        span.textContent = c.ch || ' ';
        span.style.width = (c.w || 1) * cw + 'px';
        melt.appendChild(span);
      }
    }
    g.appendChild(melt);
  }
  screen.appendChild(g);
  // the longest of its parts has finished by then, at any --type-glow-ms
  setTimeout(() => g.remove(), 1200);
}

