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
      node.marks.push({ marker, exit: null, decoration: null });
      // scrollback is finite, and so is the number of marks worth keeping
      while (node.marks.length > MARK_LIMIT) {
        const old = node.marks.shift();
        old.decoration?.dispose();
        old.marker.dispose();
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

// The command being looked at: the last finished one that starts at or above the
// top of the screen. Scrolled to the bottom that is the command that just ran;
// scrolled up it is the one whose output fills the screen, which is the one
// being read — anchoring on the top of the viewport rather than the bottom is
// what makes those the same rule. A screen showing no prompt at all falls back
// to the last finished command, since that is the only one it could mean.
function commandRegion(node) {
  const term = node?.term;
  if (!term) return null;
  const marks = liveMarks(node);
  if (marks.length < 2) return null;
  const buf = term.buffer.active;
  // At the bottom, the command being looked at is the one that just ran — and
  // saying "at or above the top of the screen" would pick the first command in
  // the session while everything still fits on one screen, where the top of the
  // screen is the top of the buffer.
  const scrolledBack = buf.viewportY < buf.baseY;
  let index = marks.length - 2; // the last one that has finished
  if (scrolledBack) {
    for (let i = 0; i < marks.length - 1; i++) {
      if (marks[i].marker.line <= buf.viewportY) index = i;
    }
  }

  let start = marks[index].marker.line + 1;
  // Past the rows the command line itself wrapped onto
  while (start < marks[index + 1].marker.line && buf.getLine(start)?.isWrapped) start++;
  const end = marks[index + 1].marker.line - 1;
  if (end < start) return null; // a command that printed nothing
  return { start, end };
}

function selectCommandOutput(node) {
  const region = commandRegion(node);
  if (!region) {
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

function lineText(term, y) {
  const line = term.buffer.active.getLine(y - 1);
  return line ? line.translateToString(true) : '';
}

function attachLinks(node) {
  const term = node.term;

  // URLs: the addon finds them, we decide what opening means. window.open would
  // be handled by the main process anyway, but going through openExternal keeps
  // the scheme allowlist in one place.
  term.loadAddon(
    new WebLinksAddon.WebLinksAddon((ev, uri) => {
      if (!ev.ctrlKey) return;
      api.openExternal(uri).then((ok) => {
        if (!ok) toast('Refused to open ' + uri.slice(0, 60), { error: true });
      });
    })
  );

  term.registerLinkProvider({
    provideLinks(y, callback) {
      const text = lineText(term, y);
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
    if (tab.kind === 'agents') out.push(...tab.centerLeaves);
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

  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    // shortcut executed by the window-level listener; just keep it away from the pty
    if (matchShortcut(ev)) return false;
    // clipboard — Windows Terminal behavior
    const ctrlOnly = ev.ctrlKey && !ev.shiftKey && !ev.altKey;
    if (ctrlOnly && ev.code === 'KeyC' && term.hasSelection()) {
      // copy instead of interrupt when text is selected
      navigator.clipboard.writeText(term.getSelection());
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
      return false;
    }
    return true;
  });

  // copy-on-select (debounced: selection changes continuously while dragging)
  let selTimer = null;
  term.onSelectionChange(() => {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      if (state.theme?.copyOnSelect !== false && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection());
      }
    }, 150);
  });

  paneEl.addEventListener('mousedown', () => focusPane(node));
  paneEl.addEventListener('contextmenu', async (ev) => {
    ev.preventDefault();
    if (term.hasSelection()) {
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
