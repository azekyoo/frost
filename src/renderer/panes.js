// A pane is one terminal: the tree they are arranged in, what each one is
// called, where its commands began and ended, the links in its output, the
// search bar over it, and zooming or resizing it.

// ---------- pane tree ----------
// leaf: { type:'leaf', id, ptyId, term, fit, el }
// split: { type:'split', dir:'row'|'col', children:[], sizes:[], el }

function findParent(node, target, parent = null) {
  if (node === target) return parent;
  if (node.type === 'split') {
    for (const c of node.children) {
      const found = findParent(c, target, node);
      if (found !== null || c === target) return found ?? node;
    }
  }
  return null;
}

function firstLeaf(node) {
  return node.type === 'leaf' ? node : firstLeaf(node.children[0]);
}

function allLeaves(node, out = []) {
  if (node.type === 'leaf') out.push(node);
  else node.children.forEach((c) => allLeaves(c, out));
  return out;
}

// ---------- pane titles ----------
// A pane's label is, in order of preference: a title the running program set
// (OSC 0/2 — claude, ssh, vim), else cwd + git branch reported by the shell's
// prompt hook (OSC 9;9), else the profile name.

function displayDir(cwd) {
  if (state.home && cwd.toLowerCase() === state.home.toLowerCase()) return '~';
  const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return base || cwd;
}

function paneLabel(node) {
  if (node.oscTitle) return node.oscTitle;
  if (node.cwd) {
    const dir = displayDir(node.cwd);
    return node.branch ? `${dir} · ${node.branch}` : dir;
  }
  return node.profileName || 'shell';
}

// What the strip shows: a name typed by hand wins over the live one, and
// clearing the rename brings the live one straight back — which is why the
// automatic title keeps being tracked underneath a rename rather than replaced.
function tabLabel(tab) {
  return tab.customTitle || tab.title;
}

function refreshPaneTitle(node) {
  const tab = tabOfPane(node);
  if (!tab || tab.kind === 'agents' || tab.activePane !== node) return;
  const label = paneLabel(node);
  if (label === tab.title && node.cwd === tab.titleCwd) return;
  tab.title = label;
  tab.titleCwd = node.cwd;
  if (tab.customTitle) return; // named by hand: nothing on screen changes
  renderTabs();
}

// A prompt means whatever was running has finished. Paired with the moment
// Enter was pressed, that's the command's duration — no shell integration
// beyond the cwd hook needed. Main decides whether it's worth a notification,
// since only it knows if the window has focus.
function reportCommandDuration(node) {
  if (!node.enterAt) return;
  const seconds = (Date.now() - node.enterAt) / 1000;
  node.enterAt = 0;
  if (seconds >= 2) api.notifyCommand({ seconds, cwd: node.cwd, exit: node.lastExit });
}

function setPaneCwd(node, cwd) {
  if (!cwd) return;
  reportCommandDuration(node);
  // A prompt fired, so the shell is back in control: whatever title was set
  // before is stale — either a program that has now exited, or ConPTY's
  // startup title (which is the shell's own command line).
  const wasTitled = node.oscTitle !== null;
  node.oscTitle = null;
  const moved = cwd !== node.cwd;
  node.cwd = cwd;
  if (moved || wasTitled) {
    if (moved) node.branch = null;
    refreshPaneTitle(node);
    if (moved) saveSession(); // restore should reopen where the pane actually is
  }
  if (!moved && Date.now() - (node.branchAt || 0) < 1000) {
    // same directory, checked a moment ago — a `git checkout` lands next prompt
    return;
  }
  node.branchAt = Date.now();
  api.gitBranch(cwd).then((branch) => {
    if (node.cwd !== cwd || branch === node.branch) return;
    node.branch = branch;
    refreshPaneTitle(node);
  });
}

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
      const marker = node.term.registerMarker(0);
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
      }
      return true;
    }

    if (kind === 'D') {
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

    return false; // B, C and anything else aren't ours to claim
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
// that just ran, and the one a Send or a copy means.
function commandRegion(node) {
  const term = node?.term;
  if (!term) return null;
  const marks = liveMarks(node);
  if (marks.length < 2) return null;
  const buf = term.buffer.active;
  const index = marks.length - 2; // the last one that has finished

  // up to the next prompt — the first empty one after it, when there were any
  const own = marks[index].end;
  const stop = own && !own.isDisposed ? own.line : marks[index + 1].marker.line;
  let start = marks[index].marker.line + 1;
  // Past the rows the command line itself wrapped onto
  while (start < stop && buf.getLine(start)?.isWrapped) start++;
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
  const buf = term.buffer.active;
  const out = [];
  let joinNext = false;
  for (let i = start; i <= end; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if ((line.isWrapped || joinNext) && out.length) out[out.length - 1] += text;
    else out.push(text);
    const last = line.getCell(term.cols - 1)?.getChars() || '';
    joinNext = last !== '' && last !== ' ';
  }
  return out.map((l) => l.replace(/\s+$/, ''));
}

// A prompt drawn by a shell Frost's hooks aren't in — the far end of an ssh
// session, most often: "user@host:~# cmd", or a remote PowerShell's "PS x> cmd".
const FOREIGN_PROMPT = /^(?:\[?([\w.-]+@[\w.-]+)[^#$\n]{0,80}?[#$]|PS [^>\n]{1,200}>) ?(.*)$/;

// The last mark's command, while it is still running — ssh, a REPL, a watcher.
// Its output never ends in a mark of Frost's, so the command worth sending is
// found by the prompts inside it: the last one that ran something, up to the
// prompt after it. With none to go by, everything it has printed so far.
function runningOutput(node, marks) {
  const mark = marks[marks.length - 1];
  const buf = node.term.buffer.active;
  let start = mark.marker.line + 1;
  while (start < buf.length && buf.getLine(start)?.isWrapped) start++;
  let end = buf.length - 1;
  while (end >= start && !buf.getLine(end)?.translateToString(true).trim()) end--;
  if (end < start) return null; // an idle prompt: nothing is running
  const local = bufferText(node.term, mark.marker.line, start - 1).join(' ').replace(/^PS [^>]*>\s*/, '').trim();
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
  const region = commandRegion(node);
  if (!region) return null;
  const promptRows = bufferText(term, region.mark.marker.line, region.start - 1);
  let output = bufferText(term, region.start, region.end);
  let command = promptRows.join(' ').trim();
  if (/^\$ /.test(output[0] || '')) {
    command = output[0];
    output = output.slice(1);
  }
  command = command.replace(/^PS [^>]*>\s*/, '').replace(/^\$ /, '').trim();
  while (output.length && !output[output.length - 1]) output.pop();
  return { command, output, exit: region.mark.exit };
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

// ---------- clickable paths and URLs ----------
// Ctrl+click, matching Windows Terminal and VS Code: a bare click in a terminal
// is for selecting text, and opening an editor by accident is worse than one
// extra modifier.

// Trailing punctuation is almost always prose, not part of the name — but a
// closing bracket can be either (`foo[0].js`), so only strip pairs we opened.
function trimCandidate(token) {
  let out = token.replace(/^[('"`\[<{]+/, '');
  out = out.replace(/[)'"`\]>},;.]+$/, (tail) => (/^\.\w+$/.test(tail) ? tail : ''));
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

function bufferLineText(term, y) {
  const line = term.buffer.active.getLine(y - 1);
  return line ? line.translateToString(true) : '';
}

const lastOpened = { uri: '', at: 0 }; // the link last sent to the browser, and when

function attachLinks(node) {
  const term = node.term;

  // URLs: the addon finds them, we decide what opening means. window.open would
  // be handled by the main process anyway, but going through openExternal keeps
  // the scheme allowlist in one place.
  term.loadAddon(
    new WebLinksAddon.WebLinksAddon((ev, uri) => {
      if (!ev.ctrlKey) return;
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
      const text = bufferLineText(term, y);
      if (!text) return callback(undefined);

      // Python tracebacks put the line number in a separate word
      const py = /File "([^"]+)", line (\d+)/.exec(text);
      const found = [];
      const seen = new Set();
      const consider = (raw, index, loc) => {
        if (!raw || seen.has(index)) return;
        seen.add(index);
        found.push({ raw, index, loc });
      };

      // The traceback match spans the quoted path, so tokens inside it are
      // skipped — two overlapping links on the same text renders as a mess.
      let covered = null;
      if (py) {
        consider(py[0], py.index, { path: py[1], line: +py[2], column: 1 });
        covered = [py.index, py.index + py[0].length];
      }
      const token = /[^\s]+/g;
      let m;
      while ((m = token.exec(text))) {
        if (covered && m.index >= covered[0] && m.index < covered[1]) continue;
        const trimmed = trimCandidate(m[0]);
        if (!trimmed) continue;
        const loc = splitLocation(trimmed);
        if (!looksLikePath(loc.path)) continue;
        consider(trimmed, m.index + m[0].indexOf(trimmed), loc);
      }
      if (!found.length) return callback(undefined);

      api.resolvePaths(node.cwd, [...new Set(found.map((f) => f.loc.path))]).then((resolved) => {
        const links = [];
        for (const { raw, index, loc } of found) {
          if (!resolved[loc.path]) continue;
          links.push({
            range: { start: { x: index + 1, y }, end: { x: index + raw.length, y } },
            text: raw,
            activate(ev) {
              if (!ev.ctrlKey) return;
              api
                .openPath({ cwd: node.cwd, target: loc.path, line: loc.line, column: loc.column })
                .then((res) => {
                  if (res?.error && !res.opened) toast(res.error, { error: true });
                });
            }
          });
        }
        callback(links.length ? links : undefined);
      });
    }
  });
}

// ---------- ligatures ----------
// The official addon is not usable here: it reads the font file off disk to
// learn which ligatures it has, through font-finder and opentype.js, and this
// renderer has no Node — deliberately, since it draws whatever a program cares
// to print. What the addon does with that knowledge is register a character
// joiner, which tells the renderer to draw a run of characters as one piece of
// text rather than cell by cell; the font's own shaping does the rest. So the
// joiner is registered directly, against the sequences programming fonts
// actually ligate, and a font that has no ligature for one of them simply draws
// it as the characters it already was.
//
// Off by default because Frost's default font is Cascadia Mono, which has none —
// switch to Cascadia Code, Fira Code, JetBrains Mono or Iosevka to see anything.
const LIGATURES =
  /(<!--|-->|<==>|<=>|===|!==|=\/=|\.\.\.|\|\|=|&&=|<<=|>>=|\/\*|\*\/|\/\/|=>|->|<-|>=|<=|!=|==|\+\+|--|\|\||&&|::|\.\.|\|>|<\||>>|<<|\?\?|:=)/g;

// Whether this font actually has the ligatures, asked of the font rather than
// assumed from its name. Two glyphs drawn as one differ from the same two drawn
// side by side; a font with no ligature for the pair draws them identically. The
// answer decides whether the letter-spacing correction is worth dropping, so a
// font without ligatures pays nothing for the setting being on.
const ligatureFonts = new Map(); // font family -> boolean

function fontHasLigatures(family) {
  if (!family) return false;
  if (ligatureFonts.has(family)) return ligatureFonts.get(family);
  let answer = false;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 80;
    canvas.height = 40;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.font = `28px ${family}`;
    const advance = ctx.measureText('=').width;
    const pixels = () => [...new Uint8Array(ctx.getImageData(0, 0, 80, 40).data)].join(',');

    ctx.clearRect(0, 0, 80, 40);
    ctx.fillText('=>', 4, 30);
    const together = pixels();

    // The same two characters, placed by hand where the font would put them.
    // Identical pixels mean the font drew two characters either way.
    ctx.clearRect(0, 0, 80, 40);
    ctx.fillText('=', 4, 30);
    ctx.fillText('>', 4 + advance, 30);
    answer = together !== pixels();
  } catch {
    answer = false;
  }
  ligatureFonts.set(family, answer);
  return answer;
}

function applyLigatures(node, wanted) {
  // The joiner groups the characters into one run; the class is what lets the
  // browser shape that run, by dropping the letter-spacing that would otherwise
  // suppress the substitution. Neither does anything without the other, and
  // neither is worth doing for a font that has nothing to substitute.
  const family = node.term?.options?.fontFamily || state.theme?.font?.family;
  const on = Boolean(wanted) && fontHasLigatures(family);
  document.body.classList.toggle('ligatures', on);
  if (Boolean(on) === Boolean(node.ligatureId !== undefined)) return;
  if (!on) {
    try {
      node.term.deregisterCharacterJoiner(node.ligatureId);
    } catch {}
    node.ligatureId = undefined;
    return;
  }
  try {
    node.ligatureId = node.term.registerCharacterJoiner((text) => {
      const ranges = [];
      LIGATURES.lastIndex = 0;
      let m;
      while ((m = LIGATURES.exec(text))) ranges.push([m.index, m.index + m[0].length]);
      return ranges;
    });
  } catch {
    node.ligatureId = undefined;
  }
}

// ---------- buffer search ----------

const SEARCH_DECORATIONS = {
  matchBackground: '#5a4a1f',
  matchBorder: '#8a7020',
  matchOverviewRuler: '#8a7020',
  activeMatchBackground: '#c98a1f',
  activeMatchBorder: '#ffb84d',
  activeMatchColorOverviewRuler: '#ffb84d'
};

// Match case, whole word, regular expression — the three every editor has, and
// the addon has always supported them; the bar simply never asked. Held per app
// rather than per pane: a search is a habit, and having to set "match case"
// again in the next pane is the same annoyance as not having it at all. Not
// written to disk, so a new Frost starts plain.
const searchOptions = { caseSensitive: false, wholeWord: false, regex: false };

const SEARCH_TOGGLES = [
  { key: 'caseSensitive', label: 'Aa', title: 'Match case (Alt+C)', code: 'KeyC' },
  { key: 'wholeWord', label: 'ab', title: 'Whole word (Alt+W)', code: 'KeyW' },
  { key: 'regex', label: '.*', title: 'Regular expression (Alt+R)', code: 'KeyR' }
];

// The addon stops adding to its match list at this many and reports that number
// as the total, so a count equal to it is a floor rather than an answer. Named
// here because the bar has to know the same number to say so.
const SEARCH_HIGHLIGHT_LIMIT = 1000;

function attachPaneSearch(node) {
  const search = new SearchAddon.SearchAddon({ highlightLimit: SEARCH_HIGHLIGHT_LIMIT });
  node.term.loadAddon(search);
  node.search = search;

  const bar = document.createElement('div');
  bar.className = 'pane-search';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'pane-search-input';
  input.placeholder = 'Find';
  input.spellcheck = false;
  const count = document.createElement('span');
  count.className = 'pane-search-count';
  const prev = document.createElement('button');
  prev.textContent = '▲';
  prev.title = 'Previous match (Shift+Enter)';
  const next = document.createElement('button');
  next.textContent = '▼';
  next.title = 'Next match (Enter)';
  const close = document.createElement('button');
  close.textContent = '×';
  close.title = 'Close (Esc)';

  const toggles = SEARCH_TOGGLES.map(({ key, label, title }) => {
    const b = document.createElement('button');
    b.className = 'pane-search-toggle';
    b.textContent = label;
    b.title = title;
    b.addEventListener('mousedown', (ev) => ev.preventDefault()); // keep the caret in the box
    b.addEventListener('click', () => {
      searchOptions[key] = !searchOptions[key];
      applySearchOptions();
    });
    return b;
  });
  node.searchToggles = toggles;

  bar.append(input, ...toggles, count, prev, next, close);
  node.el.appendChild(bar);
  node.searchEl = bar;
  node.searchInput = input;

  search.onDidChangeResults(({ resultIndex, resultCount }) => {
    if (resultCount === 0) {
      count.textContent = 'No results';
      return;
    }
    // At the limit the total is a ceiling, not a count — there may be ten times
    // as many — and past it the addon stops tracking which match is current and
    // reports -1, which used to render as the position "0". Neither is a thing
    // to state as fact, so both say what is actually known.
    if (resultCount >= SEARCH_HIGHLIGHT_LIMIT || resultIndex < 0) {
      count.textContent = `${SEARCH_HIGHLIGHT_LIMIT}+ matches`;
      return;
    }
    count.textContent = `${resultIndex + 1}/${resultCount}`;
  });

  function go(dir, incremental) {
    const query = input.value;
    bar.classList.remove('bad');
    if (!query) {
      search.clearDecorations();
      count.textContent = '';
      return;
    }
    // A regex is typed a character at a time, so most of the way to a working
    // one it is a broken one. That is not an error to report, only a search
    // that cannot run yet — the box says so and the count stays quiet.
    if (searchOptions.regex) {
      try {
        new RegExp(query);
      } catch {
        search.clearDecorations();
        bar.classList.add('bad');
        count.textContent = 'Bad pattern';
        return;
      }
    }
    const searchOpts = { ...searchOptions, decorations: SEARCH_DECORATIONS, incremental };
    if (dir === 'prev') search.findPrevious(query, searchOpts);
    else search.findNext(query, searchOpts);
  }
  // Flipping an option is not typing. Incremental keeps the current selection
  // while it still matches, which is right for a query growing a letter at a
  // time and wrong here. clearDecorations() is the other half: the addon caches
  // its match list against the term it was built for, so with the term unchanged
  // the count would keep answering the old question — turning on match case
  // moved the selection but went on reporting every casing.
  function rerun() {
    search.clearDecorations();
    go('next', false);
  }
  node.searchRerun = rerun;

  input.addEventListener('input', () => go('next', true));
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      go(ev.shiftKey ? 'prev' : 'next', false);
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closePaneSearch(node);
      return;
    }
    // The same letters every editor uses, so the options are reachable without
    // leaving the box for the mouse
    if (ev.altKey && !ev.ctrlKey && !ev.shiftKey) {
      const hit = SEARCH_TOGGLES.find((t) => t.code === ev.code);
      if (!hit) return;
      ev.preventDefault();
      searchOptions[hit.key] = !searchOptions[hit.key];
      applySearchOptions();
    }
  });
  prev.addEventListener('click', () => go('prev', false));
  next.addEventListener('click', () => go('next', false));
  close.addEventListener('click', () => closePaneSearch(node));
}

// Every pane in every tab of this window: the options are one set, so the
// buttons showing them have to agree wherever they are on screen.
function allPanes() {
  const out = [];
  for (const tab of state.tabs) {
    if (tab.kind === 'agents') out.push(...tab.centerLeaves, ...(tab.dockLeaves || []));
    else if (tab.root) out.push(...allLeaves(tab.root));
  }
  return out;
}

// The options are one set, so every bar showing them updates — buttons and
// counts alike. A bar left open in another pane answering the old question is
// the same lie as the one this fixed in the pane you are looking at.
function applySearchOptions() {
  for (const pane of allPanes()) {
    syncSearchToggles(pane);
    if (pane.searchEl?.classList.contains('open')) pane.searchRerun?.();
  }
}

function syncSearchToggles(node) {
  if (!node?.searchToggles) return;
  node.searchToggles.forEach((b, i) => {
    b.classList.toggle('on', Boolean(searchOptions[SEARCH_TOGGLES[i].key]));
  });
}

function openPaneSearch(node) {
  if (!node?.searchEl) return;
  syncSearchToggles(node);
  node.searchEl.classList.add('open');
  node.searchInput.focus();
  node.searchInput.select();
}

function closePaneSearch(node) {
  if (!node?.searchEl) return;
  node.searchEl.classList.remove('open');
  node.search.clearDecorations();
  node.term.focus();
}

// ---------- dropping files and images on a pane ----------

// Windows Terminal parity: a file dragged onto a terminal types its path. The
// case that matters most here is an agent in the pane — claude reads an image
// off disk, so a screenshot dragged in from Explorer, dragged out of a browser,
// or pasted as a bitmap all have to arrive as a path on the prompt line.

function quotePath(p) {
  // The line goes to a shell, which splits it on spaces. A Windows filename
  // cannot contain a double quote, so wrapping is always enough.
  return /[\s'`&|;(){}\[\],]/.test(p) ? `"${p}"` : p;
}

function typeInto(node, text) {
  if (!text) return;
  focusPane(node);
  // paste() rather than input(): bracketed paste keeps a shell from acting on
  // it, and the trailing space separates one drop from the next
  node.term.paste(text + ' ');
  node.term.focus();
}

// Everything the drop carries has to be read before the first await —
// dataTransfer is emptied the moment the event handler returns.
async function droppedText(dt) {
  if (!dt) return '';
  const files = [...(dt.files || [])].map((f) => api.filePath(f)).filter(Boolean);
  if (files.length) return files.map(quotePath).join(' ');

  // Dragged out of a browser: a URL, sometimes only inside a fragment of HTML.
  // Downloading is worth it for an image and nothing else — any other link is
  // more useful on the prompt line as the link itself.
  const uri = (dt.getData('text/uri-list') || '')
    .split(/\r?\n/)
    .find((l) => l && !l.startsWith('#'));
  const html = dt.getData('text/html') || '';
  const plain = dt.getData('text/plain') || '';
  const src = uri || (/<img[^>]+src="([^"]+)"/i.exec(html) || [])[1] || '';
  if (src) {
    const saved = await api.imageFromUrl(src);
    if (saved) return quotePath(saved);
  }
  return plain || (src.startsWith('data:') ? '' : src);
}

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
  const absCursor = () => {
    const buf = term.buffer.active;
    return { x: buf.cursorX, y: buf.baseY + buf.cursorY };
  };
  term.onData((d) => {
    if (state.theme?.typingGlow !== true) return; // off unless turned on
    if (ERASE_BACK.has(d) || d === ERASE_FORWARD) {
      const buf = term.buffer.active;
      const y = buf.baseY + buf.cursorY;
      const line = buf.getLine(y);
      if (line) {
        // a word long enough to run past the edge started on a row above: keep
        // the rows this one wraps on from, so the cursor can go back up them
        let top = y;
        while (top > 0 && y - top < ERASE_ROWS && buf.getLine(top)?.isWrapped) top--;
        const above = [];
        for (let r = top; r < y; r++) above.push(lineCells(buf.getLine(r), term.cols));
        erasing = { y, x: buf.cursorX, cells: lineCells(line, term.cols), top, above, forward: d === ERASE_FORWARD, at: Date.now() };
      }
      fresh = true;
      return;
    }
    const text = d.startsWith(PASTE_START) ? d.slice(PASTE_START.length).replace(PASTE_END, '') : d;
    const isPaste = d.startsWith(PASTE_START) || ([...d].length > 1 && !d.startsWith('\x1b'));
    if (isPaste) {
      const chars = [...text].filter((c) => c.trim());
      if (chars.length && chars.length <= PASTE_GLOW_MAX) paste = { chars, ...absCursor(), at: Date.now() };
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
        accepting = { ...at, rows, at: Date.now() };
      }
      return;
    }
    // on from the last key typed, not the last still waiting: one that never
    // showed where it was looked for would drag every key after it off too
    const prev = pending.length ? newest : null;
    let at = fresh || !prev ? absCursor() : { x: prev.x + 1, y: prev.y };
    if (at.x >= term.cols) at = { x: at.x - term.cols, y: at.y + 1 };
    newest = { ch: d, ...at, at: Date.now() };
    pending.push(newest);
    fresh = false;
  });
  term.onWriteParsed(() => {
    if (erasing) {
      if (Date.now() - erasing.at > GLOW_WAIT_MS) erasing = null;
      else if (glowErased(node, erasing)) erasing = null;
    }
    if (paste) {
      // a paste echoes in several writes: wait for the last
      clearTimeout(pasteTimer);
      const p = paste;
      pasteTimer = setTimeout(() => {
        if (paste === p) paste = null;
        glowPasted(node, p);
      }, 70);
    }
    if (accepting) {
      if (Date.now() - accepting.at > 400) accepting = null;
      else {
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
    const now = Date.now();
    const buf = term.buffer.active;
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
      return now - p.at < GLOW_WAIT_MS;
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

function attachDrop(node) {
  const paneEl = node.el;
  const over = (ev) => {
    // Without preventDefault the drop falls through to the document and Chromium
    // navigates the window to the file — every shell in the window goes with it.
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    paneEl.classList.add('drop-over');
  };
  paneEl.addEventListener('dragenter', over);
  paneEl.addEventListener('dragover', over);
  paneEl.addEventListener('dragleave', (ev) => {
    // dragleave also fires for every child the pointer crosses on its way in
    if (!paneEl.contains(ev.relatedTarget)) paneEl.classList.remove('drop-over');
  });
  paneEl.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    paneEl.classList.remove('drop-over');
    const text = await droppedText(ev.dataTransfer);
    if (text) typeInto(node, text);
    else toast('Nothing in that drop a terminal can use', { error: true });
  });
}

async function createPane(opts = {}) {
  const id = 'pane-' + ++paneCounter;
  const paneEl = document.createElement('div');
  paneEl.className = 'pane';
  // unpadded inner host: FitAddon measures the terminal's parent, and the
  // pane's padding must not count as usable space or bottom rows get clipped
  const hostEl = document.createElement('div');
  hostEl.className = 'term-host';
  paneEl.appendChild(hostEl);

  const theme = state.theme || {};
  const term = new Terminal({
    allowProposedApi: true, // unicode width API is gated behind this in xterm 6
    allowTransparency: true,
    scrollback: scrollbackFor(theme),
    fontFamily: theme.font?.family || 'Consolas, monospace',
    fontSize: theme.font?.size || 16,
    lineHeight: theme.font?.lineHeight || 1.15,
    // A transparent window is composited, and Chromium draws text into a
    // composited layer with grayscale antialiasing — never ClearType. Over a
    // photograph those soft edges read as mass, so the default sits below normal
    // rather than above it. Weight leaves the metrics alone either way, so
    // nothing reflows when it changes.
    fontWeight: theme.font?.weight ?? 350,
    fontWeightBold: theme.font?.weightBold ?? 'bold',
    cursorStyle: theme.cursor?.style || 'bar',
    cursorBlink: theme.cursor?.blink !== false,
    // Windows Terminal parity: builtin box/block glyphs, auto-contrast text
    customGlyphs: true,
    rescaleOverlappingGlyphs: true,
    minimumContrastRatio: theme.minContrast ?? 1,
    // xterm scrolls a whole row at a time by default, which reads as a jolt
    // rather than movement. A short animation is what every other Windows app
    // does, and Shift held down still jumps a screenful at a time.
    smoothScrollDuration: theme.scroll?.smoothMs ?? 90,
    scrollSensitivity: theme.scroll?.lines ?? 3,
    fastScrollSensitivity: theme.scroll?.fastLines ?? 10,
    // tell xterm the backend is Windows ConPTY so it applies its quirk handling
    windowsPty: { backend: 'conpty' },
    theme: xtermTheme(theme)
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  // Modern character widths (emoji = 2 cols). theme.unicodeVersion picks the
  // active table ('11' or '6') and hot-reloads for live A/B testing.
  // Never let a broken addon kill terminal creation.
  try {
    term.loadAddon(new Unicode11Addon.Unicode11Addon());
    term.unicode.activeVersion = state.theme?.unicodeVersion || '11';
  } catch (e) {
    window.__unicodeError = String(e && e.stack ? e.stack : e);
    console.error('unicode11 addon failed', e);
  }
  term.open(hostEl);

  const node = {
    type: 'leaf',
    id,
    ptyId: null,
    term,
    fit,
    webgl: null,
    el: paneEl,
    cwd: null,
    branch: null,
    oscTitle: null
  };
  applyGpu(node);
  applyLigatures(node, theme.font?.ligatures !== false);
  attachPaneSearch(node);
  attachCwdTracking(node);
  attachCommandMarks(node);
  attachLinks(node);
  attachDrop(node);
  attachTypingGlow(node);
  attachOscCopy(node);

  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    // shortcut executed by the window-level listener; just keep it away from the pty
    if (matchShortcut(ev)) return false;
    // clipboard — Windows Terminal behavior
    const ctrlOnly = ev.ctrlKey && !ev.shiftKey && !ev.altKey;
    if (ctrlOnly && ev.code === 'KeyC' && term.hasSelection()) {
      // copy instead of interrupt when text is selected
      navigator.clipboard.writeText(term.getSelection());
      glowCopy(node);
      term.clearSelection();
      return false;
    }
    if ((ctrlOnly || (ev.ctrlKey && ev.shiftKey)) && ev.code === 'KeyV') {
      // single controlled paste: preventDefault kills the browser's native
      // paste event, returning false keeps ^V away from the shell (PSReadLine
      // would paste on raw ^V too) — then paste exactly once ourselves
      ev.preventDefault();
      pasteInto(node);
      return false;
    }
    if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyC' && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection());
      glowCopy(node);
      return false;
    }
    return true;
  });

  // copy-on-select (debounced: selection changes continuously while dragging)
  let selTimer = null;
  term.onSelectionChange(() => {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      // no scan here: selecting isn't copying, to the eye, even when it fills
      // the clipboard — the scan is for a copy made on purpose
      if (state.theme?.copyOnSelect !== false && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection());
      }
    }, 150);
  });

  paneEl.addEventListener('mousedown', () => focusPane(node));
  paneEl.addEventListener('contextmenu', async (ev) => {
    ev.preventDefault();
    if (term.hasSelection()) {
      // scanned before the write: the selection it shows is gone after it
      glowCopy(node);
      await navigator.clipboard.writeText(term.getSelection());
      term.clearSelection();
    } else {
      pasteInto(node);
    }
  });

  const refit = debounce(() => {
    // offsetParent is null while display:none — fitting then would measure zero
    // and resize the pty twice for nothing, once on hide and once on show
    if (paneEl.isConnected && paneEl.offsetParent !== null) fit.fit();
  }, 30);
  new ResizeObserver(refit).observe(paneEl);

  term.onResize(({ cols, rows }) => {
    if (node.ptyId) api.ptyResize(node.ptyId, cols, rows);
  });

  // A tab moved from another window brings its shells with it: main hands over
  // ownership rather than starting anything, and the scrollback the old window
  // serialised is written back in. A shell that died in the gap adopts as null,
  // and the pane opens a fresh one in the same directory instead of sitting inert.
  const adopt = opts.adopt || null;
  const spawnOpts = { profileId: opts.profileId, cwd: opts.cwd, run: opts.run };
  const claimed = adopt ? await api.ptyAdopt(adopt.ptyId, term.cols, term.rows) : null;
  if (adopt && !claimed) toast('That shell had already exited — opened a new one', { error: true });
  const { id: ptyId, profileId, profileName } =
    claimed || (await api.ptyCreate(term.cols, term.rows, spawnOpts));
  if (claimed) {
    node.cwd = adopt.cwd || null;
    node.branch = adopt.branch || null;
    node.oscTitle = adopt.oscTitle || null;
    // Before the replayed output, which main is already sending: it belongs
    // after everything the old window had on screen.
    if (adopt.text) term.write(adopt.text);
  }
  node.ptyId = ptyId;
  node.profileId = profileId;
  node.profileName = profileName;
  panesByPty.set(ptyId, node);
  // Now that this pane is the one output for that shell reaches, anything it
  // said earlier can be let through: a shell started before the window asked for
  // it, or one that changed windows. Nothing is held for a shell started here,
  // so this is a no-op in the ordinary case.
  api.ptyFlush(ptyId);
  term.onData((d) => {
    // Enter starts the clock that the next prompt stops
    if (d.includes('\r')) node.enterAt = Date.now();
    api.ptyInput(ptyId, d);
  });

  term.onTitleChange((title) => {
    const t = (title || '').trim();
    // Titles that are just a path get dropped: that's ConPTY echoing the shell
    // command line, or a prompt theme naming the cwd — which we render better.
    node.oscTitle = t && !/^([A-Za-z]:[\\/]|\/|~[\\/])/.test(t) ? t : null;
    refreshPaneTitle(node);
  });

  return node;
}

function tabOfPane(node) {
  return state.tabs.find((t) => t.root && allLeaves(t.root).includes(node)) || null;
}

function renderNode(node) {
  if (node.type === 'leaf') return node.el;
  const wrap = document.createElement('div');
  wrap.className = 'split ' + node.dir;
  node.el = wrap;
  node.children.forEach((child, i) => {
    const childEl = renderNode(child);
    childEl.style.flex = `${node.sizes[i]} 1 0%`;
    wrap.appendChild(childEl);
    if (i < node.children.length - 1) {
      wrap.appendChild(makeDivider(node, i));
    }
  });
  return wrap;
}

function makeDivider(splitNode, index) {
  const d = document.createElement('div');
  d.className = 'divider';
  d.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    d.setPointerCapture(ev.pointerId);
    d.classList.add('dragging');
    const horizontal = splitNode.dir === 'row';
    const rect = splitNode.el.getBoundingClientRect();
    const total = horizontal ? rect.width : rect.height;
    const startPos = horizontal ? ev.clientX : ev.clientY;
    const a = splitNode.sizes[index];
    const b = splitNode.sizes[index + 1];
    const sum = splitNode.sizes.reduce((x, y) => x + y, 0);

    const move = (mv) => {
      const delta = ((horizontal ? mv.clientX : mv.clientY) - startPos) / total * sum;
      let na = Math.max(0.08, a + delta);
      let nb = Math.max(0.08, b - delta);
      const pairSum = a + b;
      if (na + nb !== pairSum) {
        if (na <= 0.08) nb = pairSum - na;
        else na = pairSum - nb;
      }
      splitNode.sizes[index] = na;
      splitNode.sizes[index + 1] = nb;
      const kids = [...splitNode.el.children].filter((c) => !c.classList.contains('divider'));
      kids[index].style.flex = `${na} 1 0%`;
      kids[index + 1].style.flex = `${nb} 1 0%`;
    };
    const up = () => {
      d.classList.remove('dragging');
      d.releasePointerCapture?.(ev.pointerId);
      d.removeEventListener('pointermove', move);
      d.removeEventListener('pointerup', up);
      saveSession();
    };
    d.addEventListener('pointermove', move);
    d.addEventListener('pointerup', up);
  });
  return d;
}

// ---------- zooming a pane ----------
// Splitting is cheap, so panes get small; then one of them is where the work is
// and the others are context you want back in a keystroke. Zoom lays the focused
// pane over its tab rather than rebuilding the layout: the tree, the sizes and
// every other shell are untouched, which is what makes it a view state that can
// be turned off without anything having moved.

function setPaneZoom(tab, leaf) {
  if (!tab || tab.kind === 'agents') return;
  const previous = tab.zoomedPane || null;
  if (previous) previous.el.classList.remove('zoomed');
  tab.zoomedPane = leaf || null;
  if (leaf) leaf.el.classList.add('zoomed');
  tab.contentEl.classList.toggle('has-zoom', Boolean(leaf));
  renderTabs(); // the strip carries the marker: a zoomed tab hides its own splits
  // The pane changed size, so the shell it holds has a different window than it
  // did a moment ago and has to be told
  const affected = leaf || previous;
  if (affected) requestAnimationFrame(() => affected.fit.fit());
}

// Anything that changes the layout has to let go of the zoom first, or it
// changes a layout nobody can see.
function unzoom(tab) {
  if (tab?.zoomedPane) setPaneZoom(tab, null);
}

function toggleZoom() {
  const tab = state.activeTab;
  if (!tab || tab.kind === 'agents' || !tab.root) return;
  if (tab.zoomedPane) {
    setPaneZoom(tab, null);
    return;
  }
  const leaf = tab.activePane || firstLeaf(tab.root);
  // One pane already fills the tab, so zooming it would look like nothing
  // happened. Says how to get a second one rather than only that there is not:
  // zoom is the answer to a split layout, so whoever presses it here has most
  // likely not met splitting yet.
  if (!leaf || allLeaves(tab.root).length < 2) {
    toast('Zoom fills the tab with one terminal — split first with Alt+Shift+= or Alt+Shift+-', {
      ms: 6000
    });
    return;
  }
  setPaneZoom(tab, leaf);
  focusPane(leaf);
}

// ---------- resizing panes from the keyboard ----------
// The dividers can be dragged, which needs a mouse, a small target and a steady
// hand. These move the same boundary a step at a time.

const RESIZE_STEP = 0.06; // of the split's own total, so it feels the same at any depth
const RESIZE_MIN = 0.08; // the floor the divider drag uses too

// The nearest ancestor split running along the axis being resized, and which of
// its children the pane sits inside — a pane deep in a column stack still
// widens by moving the boundary of the row split above it.
function splitAlong(tab, leaf, dir) {
  const wanted = dir === 'left' || dir === 'right' ? 'row' : 'col';
  let node = leaf;
  let parent = tab.root === node ? null : findParent(tab.root, node);
  while (parent) {
    if (parent.dir === wanted) return { split: parent, index: parent.children.indexOf(node) };
    node = parent;
    parent = tab.root === node ? null : findParent(tab.root, node);
  }
  return null;
}

function resizePane(dir) {
  const tab = state.activeTab;
  if (!tab || tab.kind === 'agents' || !tab.activePane) return;
  // A zoomed pane has no visible neighbours to take space from
  if (tab.zoomedPane) return;
  const found = splitAlong(tab, tab.activePane, dir);
  if (!found) return;
  const { split, index } = found;
  const last = split.children.length - 1;
  const forward = dir === 'right' || dir === 'down';
  // The boundary this pane owns in that direction — and if it has none, because
  // it is the last child, the one on its other side. Moving that one the same
  // way shrinks the pane, which is what "the edge moves right" means when the
  // pane is already against the wall.
  const edge = forward ? (index < last ? index : index - 1) : index > 0 ? index - 1 : index;
  if (edge < 0 || edge >= last + 1) return;
  const sum = split.sizes.reduce((a, b) => a + b, 0);
  const step = (forward ? 1 : -1) * RESIZE_STEP * sum;
  const a = split.sizes[edge] + step;
  const b = split.sizes[edge + 1] - step;
  if (a < RESIZE_MIN || b < RESIZE_MIN) return; // already as far as it goes
  split.sizes[edge] = a;
  split.sizes[edge + 1] = b;
  const kids = [...split.el.children].filter((c) => !c.classList.contains('divider'));
  kids[edge].style.flex = `${a} 1 0%`;
  kids[edge + 1].style.flex = `${b} 1 0%`;
  saveSession(); // each pane refits itself: they are watched for resize
}

function renderTab(tab) {
  tab.contentEl.replaceChildren(renderNode(tab.root));
  allLeaves(tab.root).forEach((leaf) => leaf.fit.fit());
}

function focusPane(node) {
  const tab = tabOfPane(node);
  if (!tab) return;
  tab.activePane = node;
  document.querySelectorAll('.pane.focused').forEach((p) => p.classList.remove('focused'));
  node.el.classList.add('focused');
  // focusing can make a TUI redraw; that repaint isn't the agent working
  if (node.ptyId) api.ptyMute(node.ptyId);
  node.term.focus();
  refreshPaneTitle(node);
}

async function splitPane(dir) {
  const tab = state.activeTab;
  if (!tab || !tab.activePane) return;
  unzoom(tab); // a new pane hidden behind a zoomed one reads as a split that failed
  const target = tab.activePane;
  // a split keeps the shell and directory you were already in
  const newLeaf = await createPane({ profileId: target.profileId, cwd: target.cwd });
  const parent = tab.root === target ? null : findParent(tab.root, target);

  if (parent && parent.dir === dir) {
    const i = parent.children.indexOf(target);
    parent.children.splice(i + 1, 0, newLeaf);
    const half = parent.sizes[i] / 2;
    parent.sizes[i] = half;
    parent.sizes.splice(i + 1, 0, half);
  } else {
    const split = { type: 'split', dir, children: [target, newLeaf], sizes: [1, 1], el: null };
    if (!parent) {
      tab.root = split;
    } else {
      parent.children[parent.children.indexOf(target)] = split;
    }
  }
  renderTab(tab);
  focusPane(newLeaf);
  saveSession();
}

function destroyLeaf(node) {
  if (node.ptyId) {
    panesByPty.delete(node.ptyId);
    api.ptyKill(node.ptyId);
  }
  node.term.dispose();
  node.el.remove();
}

function removePane(node, { killPty = true } = {}) {
  const tab = tabOfPane(node);
  if (!tab) return;
  unzoom(tab);

  if (killPty) destroyLeaf(node);
  else {
    node.term.dispose();
    node.el.remove();
  }

  if (tab.root === node) {
    closeTab(tab, { killPtys: false });
    return;
  }

  const parent = findParent(tab.root, node);
  const i = parent.children.indexOf(node);
  parent.children.splice(i, 1);
  parent.sizes.splice(i, 1);

  if (parent.children.length === 1) {
    const survivor = parent.children[0];
    if (tab.root === parent) {
      tab.root = survivor;
    } else {
      const gp = findParent(tab.root, parent);
      gp.children[gp.children.indexOf(parent)] = survivor;
    }
  }
  renderTab(tab);
  focusPane(firstLeaf(tab.root));
  saveSession();
}
