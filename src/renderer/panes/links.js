// ---------- clickable paths and URLs ----------
// Ctrl+click, matching Windows Terminal and VS Code: a bare click in a terminal
// is for selecting text, and opening an editor by accident is worse than one
// extra modifier.

// Trailing punctuation is almost always prose, not part of the name — but a
// closing bracket can be either (`foo[0].js`), so only strip pairs we opened.
// A colon too: "panes.js: the link code" — a line number after one is kept,
// since only a colon at the very end goes.
function trimCandidate(token) {
  let out = token.replace(/^[('"`\[<{]+/, '');
  out = out.replace(/[)'"`\]>},;.:]+$/, (tail) => (/^\.\w+$/.test(tail) ? tail : ''));
  return out;
}

// Splits src/foo.js:12:5 — and grep's src/foo.js:12:matched text — into the
// path and whatever line/column were appended.
function splitLocation(token) {
  const m = /^(.*?):(\d+)(?::(\d+))?(?::.*)?$/.exec(token);
  if (m && m[1]) return { path: m[1], line: +m[2], column: m[3] ? +m[3] : 1 };
  return { path: token, line: 0, column: 1 };
}

// Worth asking the main process about: has a separator, or looks like a
// filename with an extension. Existence is what actually decides.
function looksLikePath(value) {
  if (!value || value.length < 2 || value.length > 400) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) return false; // a URL, handled elsewhere
  return /[\\/]/.test(value) || /^[\w.@$+-]+\.[A-Za-z][\w]{0,9}$/.test(value);
}

// One row's text, with the cell each character sits in — a wide character is
// one character but two cells, so the string index alone can't say where a
// link starts on screen.
function rowCells(term, row) {
  const line = term.buffer.active.getLine(row);
  const out = { text: '', xs: [], wrapped: !!line?.isWrapped };
  if (!line) return out;
  const cell = term.buffer.active.getNullCell();
  for (let x = 0; x < term.cols; x++) {
    line.getCell(x, cell);
    if (cell.getWidth() === 0) continue; // the right half of a wide character
    const chars = cell.getChars() || ' ';
    out.text += chars;
    for (let i = 0; i < chars.length; i++) out.xs.push(x);
  }
  return out;
}

// A row that runs to the right edge with no space before it is cut there, not
// ended: a program that wraps its own text (Claude Code does) breaks a long
// path wherever the width runs out and indents the rest. Nothing marks that
// in the buffer, so it is guessed — and a guess that joins two unrelated rows
// costs nothing, because only a path that exists on disk becomes a link.
function runsToEdge(term, r) {
  const trimmed = r.text.replace(/\s+$/, '');
  return trimmed.length > 0 && r.xs[trimmed.length - 1] >= term.cols - 2;
}

// The row at y joined with the rows it continues and is continued by, so a
// path wrapped onto the next row is one string again. map[i] is the 1-based
// screen cell of text[i].
const LOGICAL_ROWS = 8;
function logicalLine(term, y) {
  const at = (row) => rowCells(term, row);
  const continues = (prev, cur) => cur.wrapped || runsToEdge(term, prev);
  let first = y - 1;
  let cur = at(first);
  while (first > 0 && y - 1 - first < LOGICAL_ROWS) {
    const prev = at(first - 1);
    if (!continues(prev, cur)) break;
    first--;
    cur = prev;
  }
  let text = '';
  const map = [];
  let row = first;
  let r = at(row);
  for (;;) {
    let rowText = r.text;
    let xs = r.xs;
    const next = row + 1 < term.buffer.active.length && row - first < LOGICAL_ROWS ? at(row + 1) : null;
    const goesOn = next && continues(r, next);
    // the indent a self-wrapping program gives its continuation rows is
    // layout, not part of what was wrapped
    if (row > first && !r.wrapped) {
      const lead = rowText.length - rowText.trimStart().length;
      rowText = rowText.slice(lead);
      xs = xs.slice(lead);
    }
    // a soft-wrapped row is full to the edge, spaces included, and those
    // spaces are real; anything else ends at its last character
    if (!goesOn || !next.wrapped) rowText = rowText.replace(/\s+$/, '');
    text += rowText;
    for (let i = 0; i < rowText.length; i++) map.push({ x: xs[i] + 1, y: row + 1 });
    if (!goesOn) break;
    row++;
    r = next;
  }
  return { text, map };
}

const lastOpened = { uri: '', at: 0 }; // the link last sent to the browser, and when

// ---------- image paths: a look on hover ----------
// Ctrl+click hands an image to its Windows viewer; most of the time the point
// is only to see which picture a path is, so resting the pointer on it shows
// the picture in a card beside it. No modifier: the card asks nothing of the
// click and is gone the moment the pointer moves off.
const IMAGE_PATH = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i;
const IMAGE_CARD_DELAY = 300;
const IMAGE_CARD_GAP = 14;

const imageCard = { node: null, timer: null, seq: 0 };

function hideImageCard() {
  clearTimeout(imageCard.timer);
  imageCard.timer = null;
  imageCard.seq++; // a preview still on its way is for a card no longer wanted
  imageCard.node?.classList.remove('show');
}

function placeImageCard(x, y) {
  const node = imageCard.node;
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  // below-right of the pointer, so the path itself stays readable; flipped
  // to whichever side has room near the window's edges
  let left = x + IMAGE_CARD_GAP;
  let top = y + IMAGE_CARD_GAP;
  if (left + w > window.innerWidth - 6) left = x - w - IMAGE_CARD_GAP;
  if (top + h > window.innerHeight - 6) top = y - h - IMAGE_CARD_GAP;
  node.style.transform = `translate(${Math.round(Math.max(6, left))}px, ${Math.round(Math.max(6, top))}px)`;
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function showImageCard(node, target, x, y) {
  hideImageCard();
  const seq = imageCard.seq;
  imageCard.timer = setTimeout(async () => {
    const res = await api.imagePreview({ cwd: node.cwd, target });
    if (seq !== imageCard.seq || !res) return;
    if (!imageCard.node) {
      imageCard.node = document.createElement('div');
      imageCard.node.id = 'image-card';
      document.body.appendChild(imageCard.node);
    }
    const card = imageCard.node;
    const name = res.path.replace(/^.*[\\/]/, '');
    const foot = Object.assign(document.createElement('div'), { className: 'image-card-foot' });
    const say = (dims) => (foot.textContent = [name, dims, formatBytes(res.bytes)].filter(Boolean).join(' · '));
    if (res.tooBig) {
      say('too big to preview');
      card.replaceChildren(foot);
    } else {
      const img = new Image();
      img.src = res.src;
      try {
        await img.decode();
      } catch {
        return; // not a picture after all, whatever its name says
      }
      if (seq !== imageCard.seq) return;
      say(img.naturalWidth ? `${img.naturalWidth}×${img.naturalHeight}` : '');
      // a tiny icon drawn at its own size reads as a smudge; pixel art and
      // icons are scaled up without blurring them
      if (img.naturalWidth && img.naturalWidth < 96) img.classList.add('pixel');
      card.replaceChildren(Object.assign(document.createElement('div'), { className: 'image-card-pic' }), foot);
      card.firstChild.appendChild(img);
    }
    placeImageCard(x, y);
    card.classList.add('show');
  }, IMAGE_CARD_DELAY);
}

// typing or scrolling means the pointer's resting place is no longer the point
document.addEventListener('keydown', hideImageCard, true);
document.addEventListener('wheel', hideImageCard, { capture: true, passive: true });

function attachLinks(node) {
  const term = node.term;

  // URLs: the addon finds them, we decide what opening means. window.open would
  // be handled by the main process anyway, but going through openExternal keeps
  // the scheme allowlist in one place.
  term.loadAddon(
    new WebLinksAddon.WebLinksAddon((ev, uri) => {
      if (!modKey(ev)) return;
      // One click, one tab. Under Claude Code, which turns mouse tracking on,
      // a single Ctrl+click reached here twice and the browser opened the link
      // twice; a second ask for the same link straight after the first is
      // that, not a second click.
      const now = Date.now();
      if (lastOpened.uri === uri && now - lastOpened.at < 1000) return;
      lastOpened.uri = uri;
      lastOpened.at = now;
      api.openExternal(uri).then((ok) => {
        if (!ok) toast('Refused to open ' + uri.slice(0, 60), { error: true });
      });
    })
  );

  term.registerLinkProvider({
    provideLinks(y, callback) {
      const found = [];
      const seen = new Set();
      const consider = (raw, start, last, loc) => {
        const key = `${start.y}:${start.x}:${last.y}:${last.x}`;
        if (!raw || seen.has(key)) return;
        seen.add(key);
        found.push({ raw, start, last, loc });
      };

      const collect = ({ text, map }) => {
        if (!text) return;
        // Python tracebacks put the line number in a separate word
        const py = /File "([^"]+)", line (\d+)/.exec(text);
        // The traceback match spans the quoted path, so tokens inside it are
        // skipped — two overlapping links on the same text renders as a mess.
        let covered = null;
        if (py) {
          consider(py[0], map[py.index], map[py.index + py[0].length - 1], { path: py[1], line: +py[2], column: 1 });
          covered = [py.index, py.index + py[0].length];
        }
        const words = [...text.matchAll(/[^\s]+/g)].map((w) => ({ index: w.index, end: w.index + w[0].length }));
        words.forEach((w, i) => {
          if (covered && w.index >= covered[0] && w.index < covered[1]) return;
          // A folder name can have spaces in it (Program Files, Frost (source)),
          // and splitting on them leaves halves no file has. So a word that
          // starts a drive path is also tried with the next few words on; the
          // disk decides, and the longest that exists wins below.
          const drive = /^[('"`\[<{]*[A-Za-z]:[\\/]/.test(text.slice(w.index, w.end));
          for (let k = i; k < Math.min(words.length, i + (drive ? 5 : 1)); k++) {
            const span = text.slice(w.index, words[k].end);
            const trimmed = trimCandidate(span);
            if (!trimmed) continue;
            const index = w.index + span.indexOf(trimmed);
            // a name cut short to fit a column (PowerShell's ls: CHANGEL…) is
            // looked for as the start of a name, in the folder listed
            if (/^[^\\/…]{2,}…$/.test(trimmed)) {
              consider(trimmed, map[index], map[index + trimmed.length - 1], { path: trimmed, line: 0, column: 1 });
              continue;
            }
            const loc = splitLocation(trimmed);
            // a bare word may still be a folder (ls lists them so); only one
            // that exists right where the shell is becomes a link
            const folder = /^[\w.@+-]{2,}[\\/]?$/.test(trimmed);
            if (!looksLikePath(loc.path) && !folder) continue;
            consider(trimmed, map[index], map[index + trimmed.length - 1], folder && !looksLikePath(loc.path) ? { path: trimmed, line: 0, column: 1 } : loc);
          }
        });
      };

      // The line as a whole, for a path wrapped onto the next row — and this
      // row alone, since a row that merely ends at the edge (a column listing
      // filled to the width) isn't wrapped, and joined it glues two names into
      // one no file has. Both are tried; the disk decides.
      const whole = logicalLine(term, y);
      collect(whole);
      if (whole.map.length && (whole.map[0].y !== y || whole.map[whole.map.length - 1].y !== y)) {
        const r = rowCells(term, y - 1);
        const text = r.text.replace(/\s+$/, '');
        collect({ text, map: r.xs.slice(0, text.length).map((x) => ({ x: x + 1, y })) });
      }
      if (!found.length) return callback(undefined);

      api.resolvePaths(node.cwd, [...new Set(found.map((f) => f.loc.path))]).then((resolved) => {
        // longest first, so a path with spaces claims its words before any of
        // them can be a link of its own
        const where = (p) => resolved.paths[p] || resolved.dirs[p] || resolved.cuts[p];
        const hits = found.filter((f) => where(f.loc.path)).sort((a, b) => b.raw.length - a.raw.length);
        const cell = (c) => c.y * 100000 + c.x;
        const taken = [];
        const links = [];
        for (const { raw, start, last, loc } of hits) {
          const s0 = cell(start);
          const e0 = cell(last);
          if (taken.some(([s, e]) => s0 <= e && e0 >= s)) continue;
          taken.push([s0, e0]);
          // the line may span rows; only links on the row asked about go back
          if (start.y > y || last.y < y) continue;
          // where the path was found, which for a bare name may be a folder
          // of the repo other than the shell's: opening goes there directly
          const target = where(loc.path);
          const isCut = !!resolved.cuts[loc.path];
          const isDir = !isCut && !resolved.paths[loc.path];
          const isImage = !isDir && !isCut && IMAGE_PATH.test(target);
          links.push({
            range: { start, end: last },
            text: raw,
            // a path under the pointer is what it is pointing at, more than
            // the command around it: the block holds off until it moves off
            hover(ev) {
              node.onLink = true;
              node.holdBlock?.();
              if (isImage) showImageCard(node, target, ev.clientX, ev.clientY);
            },
            leave() {
              node.onLink = false;
              if (isImage) hideImageCard();
            },
            activate(ev) {
              if (!modKey(ev)) return;
              hideImageCard();
              const opts = { cwd: node.cwd, target, line: loc.line, column: loc.column };
              // Ctrl+click looks without leaving Frost; Shift added goes
              // straight to the editor (Explorer, for a folder), for when the
              // point is to change it
              if (ev.shiftKey) openOutside(opts);
              else if (isCut) peekCutName(target, loc.path.slice(0, -1), node.cwd);
              else if (isDir) peekFolder(target, node.cwd);
              else peekPath(opts, node.cwd);
            }
          });
        }
        callback(links.length ? links : undefined);
      });
    }
  });
}

