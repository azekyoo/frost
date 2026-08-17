/* global Terminal, FitAddon, WebLinksAddon, WebglAddon, Unicode11Addon, SearchAddon */

const state = {
  theme: null,
  tabs: [],
  activeTab: null,
  home: null
};

let tabCounter = 0;
let paneCounter = 0;
const panesByPty = new Map(); // ptyId -> leaf node

const glassState = { active: false, display: null, bounds: null };
// Whole-UI zoom in force for the monitor this window sits on; owned by the main
// process, mirrored here because screen-coordinate maths has to undo it.
let uiZoom = 1;

const el = {
  glassBg: document.getElementById('glass-bg'),
  tabstrip: document.getElementById('tabstrip'),
  content: document.getElementById('content'),
  settings: document.getElementById('settings'),
  toasts: document.getElementById('toasts'),
  profileMenu: document.getElementById('profile-menu'),
  palette: document.getElementById('palette'),
  paletteInput: document.getElementById('palette-input'),
  paletteList: document.getElementById('palette-list'),
  customCss: document.getElementById('custom-css')
};

// ---------- helpers ----------

// Messages stack rather than sharing one slot: a second toast used to overwrite
// the first, so a warning could vanish before it was read. Errors are given
// longer and marked, since they're the ones worth reading.
const TOAST_LIMIT = 3;

// opts: a number is a duration, or { error, ms }. Severity is declared by the
// caller rather than guessed from the wording — English phrasing is a poor
// signal, and getting it wrong means a failure looks like a confirmation.
function toast(msg, opts) {
  const text = String(msg ?? '').trim();
  if (!text) return;
  const { error: isError = false, ms } = typeof opts === 'number' ? { ms: opts } : opts || {};
  const node = document.createElement('div');
  node.className = 'toast' + (isError ? ' error' : '');
  node.textContent = text;
  node.title = 'Click to dismiss';

  const dismiss = () => {
    if (!node.isConnected) return;
    node.classList.remove('show');
    setTimeout(() => node.remove(), 200);
  };
  node.addEventListener('click', dismiss);
  el.toasts.appendChild(node);
  requestAnimationFrame(() => node.classList.add('show'));

  while (el.toasts.children.length > TOAST_LIMIT) el.toasts.firstElementChild.remove();
  setTimeout(dismiss, ms ?? (isError ? 6000 : 2600));
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------- theme ----------

// paste via term.paste(): respects bracketed paste mode, so multi-line
// pastes don't execute line-by-line in the shell
function pasteInto(term) {
  navigator.clipboard.readText().then((t) => {
    if (t) term.paste(t);
  });
}

// GPU (WebGL) renderer: enables customGlyphs box-drawing and faster rendering.
// Falls back to the DOM renderer if WebGL is unavailable.
function applyGpu(node) {
  // opt-in, not opt-out: see the note on gpuRenderer in the default theme
  const want = state.theme?.gpuRenderer === true;
  if (want && !node.webgl) {
    try {
      node.webgl = new WebglAddon.WebglAddon();
      node.webgl.onContextLoss(() => {
        node.webgl?.dispose();
        node.webgl = null;
      });
      node.term.loadAddon(node.webgl);
    } catch {
      node.webgl = null;
    }
  } else if (!want && node.webgl) {
    node.webgl.dispose();
    node.webgl = null;
  }
}

// The GPU renderer rasterises every glyph once, into a texture atlas sized for
// the device pixel ratio in force at the time. The ratio changes whenever the
// page zooms or the window crosses to a monitor with a different scale factor,
// and the old atlas is then sampled at a size it was never drawn for — which is
// what makes the text look chewed rather than merely small. Nothing in the
// addon watches for that, so the atlas is dropped by hand and redrawn sharp.
function resharpen() {
  for (const node of panesByPty.values()) {
    try {
      node.webgl?.clearTextureAtlas();
    } catch {}
    try {
      node.fit.fit();
    } catch {}
  }
}

// devicePixelRatio is not observable directly; a media query pinned to the
// current value stops matching the moment it changes, and is then re-armed
// against the new one.
function watchPixelRatio() {
  const mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  mq.addEventListener(
    'change',
    () => {
      resharpen();
      watchPixelRatio();
    },
    { once: true }
  );
}
watchPixelRatio();

function xtermTheme(theme) {
  const t = theme.terminal || {};
  return {
    ...t,
    background: 'rgba(0,0,0,0)' // acrylic tint comes from the page, not xterm
  };
}

function applyTheme(theme, css) {
  if (!theme) return;
  state.theme = theme;
  const r = document.documentElement.style;
  r.setProperty('--tint', theme.tint || 'rgba(10,12,20,0.55)');
  r.setProperty('--accent', theme.accent || '#7aa2f7');
  r.setProperty('--fg', theme.terminal?.foreground || '#c8d3f5');
  r.setProperty('--pad', (theme.padding ?? 14) + 'px');
  r.setProperty('--radius', (theme.cornerRadius ?? 8) + 'px');
  r.setProperty('--font', theme.font?.family || 'Consolas, monospace');
  r.setProperty('--glass-blur', (theme.glassBlur ?? 40) + 'px');
  // A scrim under the user's tint. Tint is an aesthetic choice and can legally
  // be fully transparent; text still has to be readable over whatever wallpaper
  // happens to be behind it, so the floor is kept separate from the tint.
  const readability = Math.min(1, Math.max(0, theme.glassReadability ?? 0.3));
  const scrim =
    (theme.colorMode || 'dark') === 'light'
      ? `rgba(238, 240, 246, ${readability})`
      : `rgba(6, 8, 14, ${readability})`;
  r.setProperty('--scrim', scrim);
  r.setProperty('--win-radius', (theme.windowRadius ?? 12) + 'px');
  // Keyed to how the window was actually created, not to the material that has
  // been picked. A frameless transparent window has to paint its own backdrop
  // whatever the setting says — dropping it the moment another material is
  // chosen just exposes a see-through window and makes the change look applied
  // when nothing has been applied at all.
  document.body.classList.toggle('glass', glassState.active);
  if (typeof css === 'string') el.customCss.textContent = css;

  for (const node of panesByPty.values()) {
    const term = node.term;
    term.options.fontFamily = theme.font?.family || 'Consolas, monospace';
    term.options.fontSize = theme.font?.size || 14;
    term.options.lineHeight = theme.font?.lineHeight || 1.2;
    term.options.cursorStyle = theme.cursor?.style || 'bar';
    term.options.cursorBlink = theme.cursor?.blink !== false;
    term.options.minimumContrastRatio = theme.minContrast ?? 1;
    term.options.smoothScrollDuration = theme.scroll?.smoothMs ?? 90;
    term.options.scrollSensitivity = theme.scroll?.lines ?? 3;
    term.options.fastScrollSensitivity = theme.scroll?.fastLines ?? 10;
    term.options.theme = xtermTheme(theme);
    try {
      term.unicode.activeVersion = theme.unicodeVersion || '11';
    } catch {}
    applyGpu(node);
    node.fit.fit();
  }
  for (const tab of agentTabs()) applyAgentColumns(tab);
  syncSettingsUI();
}

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

function refreshPaneTitle(node) {
  const tab = tabOfPane(node);
  if (!tab || tab.kind === 'agents' || tab.activePane !== node) return;
  const label = paneLabel(node);
  if (label === tab.title && node.cwd === tab.titleCwd) return;
  tab.title = label;
  tab.titleCwd = node.cwd;
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

// ---------- buffer search ----------

const SEARCH_DECORATIONS = {
  matchBackground: '#5a4a1f',
  matchBorder: '#8a7020',
  matchOverviewRuler: '#8a7020',
  activeMatchBackground: '#c98a1f',
  activeMatchBorder: '#ffb84d',
  activeMatchColorOverviewRuler: '#ffb84d'
};

function attachPaneSearch(node) {
  const search = new SearchAddon.SearchAddon();
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
  bar.append(input, count, prev, next, close);
  node.el.appendChild(bar);
  node.searchEl = bar;
  node.searchInput = input;

  search.onDidChangeResults(({ resultIndex, resultCount }) => {
    count.textContent = resultCount === 0 ? 'No results' : `${resultIndex + 1}/${resultCount}`;
  });

  function go(dir, incremental) {
    const query = input.value;
    if (!query) {
      search.clearDecorations();
      count.textContent = '';
      return;
    }
    const searchOpts = { decorations: SEARCH_DECORATIONS, incremental };
    if (dir === 'prev') search.findPrevious(query, searchOpts);
    else search.findNext(query, searchOpts);
  }

  input.addEventListener('input', () => go('next', true));
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      go(ev.shiftKey ? 'prev' : 'next', false);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      closePaneSearch(node);
    }
  });
  prev.addEventListener('click', () => go('prev', false));
  next.addEventListener('click', () => go('next', false));
  close.addEventListener('click', () => closePaneSearch(node));
}

function openPaneSearch(node) {
  if (!node?.searchEl) return;
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
    scrollback: 10000,
    fontFamily: theme.font?.family || 'Consolas, monospace',
    fontSize: theme.font?.size || 14,
    lineHeight: theme.font?.lineHeight || 1.2,
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
      pasteInto(term);
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
      pasteInto(term);
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

  const { id: ptyId, profileId, profileName } = await api.ptyCreate(term.cols, term.rows, opts);
  node.ptyId = ptyId;
  node.profileId = profileId;
  node.profileName = profileName;
  panesByPty.set(ptyId, node);
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

// ---------- tabs ----------

async function newTab({ profileId, cwd } = {}) {
  const tab = {
    id: 'tab-' + ++tabCounter,
    title: '',
    root: null,
    activePane: null,
    contentEl: document.createElement('div')
  };
  tab.contentEl.className = 'tab-content';
  const leaf = await createPane({ profileId, cwd });
  tab.title = leaf.profileName || 'shell';
  tab.root = leaf;
  state.tabs.push(tab);
  activateTab(tab);
  renderTab(tab);
  focusPane(leaf);
  saveSession();
}

function activateTab(tab) {
  state.activeTab = tab;
  el.content.replaceChildren(tab.contentEl);
  renderTabs();
  saveSession();
  if (tab.kind === 'agents') {
    const visible = [...tab.centerLeaves].find((l) => l.el.style.display !== 'none');
    if (visible) {
      visible.fit.fit();
      visible.term.focus();
    }
    return;
  }
  allLeaves(tab.root).forEach((leaf) => leaf.fit.fit());
  if (tab.activePane) focusPane(tab.activePane);
  else focusPane(firstLeaf(tab.root));
}

function closeTab(tab, { killPtys = true } = {}) {
  if (tab.kind === 'agents') {
    for (const leaf of tab.centerLeaves) {
      try {
        const agent = agentsByPty.get(leaf.ptyId);
        if (agent) {
          agentsByPty.delete(leaf.ptyId);
          globalAgents.delete(agent.id);
        }
        if (leaf.ptyId) {
          panesByPty.delete(leaf.ptyId);
          api.ptyKill(leaf.ptyId);
        }
        leaf.term.dispose();
        leaf.el.remove();
      } catch {}
    }
    api.agentsSelectDiff(null);
    api.agentsReleaseTab();
  } else if (killPtys) {
    allLeaves(tab.root).forEach(destroyLeaf);
  }
  const i = state.tabs.indexOf(tab);
  state.tabs.splice(i, 1);
  if (state.tabs.length === 0) {
    window.close();
    return;
  }
  if (state.activeTab === tab) {
    activateTab(state.tabs[Math.max(0, i - 1)]);
  } else {
    renderTabs();
  }
  saveSession();
}

function renderTabs() {
  el.tabstrip.replaceChildren(
    ...state.tabs.map((tab) => {
      const t = document.createElement('div');
      t.className = 'tab' + (tab === state.activeTab ? ' active' : '');
      if (tab.kind === 'agents') {
        const dot = document.createElement('span');
        dot.className = 'tab-dot st-' + worstAgentStatus(tab);
        t.appendChild(dot);
      }
      const pane = tab.activePane;
      t.title = [pane?.cwd, pane?.profileName].filter(Boolean).join('\n') || tab.title;
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = tab.title;
      const close = document.createElement('button');
      close.className = 'close';
      close.textContent = '×';
      close.title = 'Close tab';
      // stopPropagation on mousedown: otherwise the tab re-activates and the
      // tab strip re-renders, destroying this button before 'click' can fire
      close.addEventListener('mousedown', (ev) => ev.stopPropagation());
      close.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeTab(tab);
      });
      t.append(title, close);
      t.addEventListener('mousedown', () => activateTab(tab));
      return t;
    })
  );
  document.title = state.activeTab ? `${state.activeTab.title} — Frost` : 'Frost';
  // With many tabs the strip scrolls, so the one you just switched to has to be
  // brought into view or it may be off-screen entirely.
  el.tabstrip.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// A tab strip is horizontal, so a vertical wheel should scroll it sideways —
// otherwise a mouse without a tilt wheel can't reach the overflow at all.
el.tabstrip.addEventListener(
  'wheel',
  (ev) => {
    if (!ev.deltaY || ev.shiftKey) return;
    if (el.tabstrip.scrollWidth <= el.tabstrip.clientWidth) return;
    ev.preventDefault();
    el.tabstrip.scrollLeft += ev.deltaY;
  },
  { passive: false }
);

// ---------- session persistence ----------
// The layout is pushed to the main process on every change rather than on exit,
// so a crash still leaves something restorable on disk. Agent tabs are left out
// on purpose: they have their own resumable-session list, and relaunching
// `claude` unasked on startup would be the wrong call.

let restoring = false;

function serializeNode(node) {
  if (node.type === 'leaf') {
    return { t: 'leaf', profileId: node.profileId || null, cwd: node.cwd || null };
  }
  return {
    t: 'split',
    dir: node.dir,
    sizes: node.sizes.slice(),
    children: node.children.map(serializeNode)
  };
}

const saveSession = debounce(() => {
  if (restoring) return;
  if (state.theme?.restoreSession === false) {
    api.sessionSave({ tabs: [], activeTab: 0 });
    return;
  }
  const tabs = state.tabs.filter((t) => t.kind !== 'agents' && t.root);
  api.sessionSave({
    tabs: tabs.map((t) => ({ root: serializeNode(t.root) })),
    activeTab: Math.max(0, tabs.indexOf(state.activeTab))
  });
}, 400);

function savedSizes(sizes, n) {
  const s = Array.isArray(sizes) && sizes.length === n ? sizes.map(Number) : null;
  return s && s.every((x) => Number.isFinite(x) && x > 0) ? s : Array(n).fill(1);
}

// window.json is a plain file the user can edit or corrupt, and every leaf
// costs a real shell process, so the tree is measured before anything spawns.
const MAX_TABS = 20;
const MAX_PANES_PER_TAB = 16;
const MAX_PANES = 40;
const MAX_DEPTH = 12;

function isSplit(saved, depth) {
  return (
    depth < MAX_DEPTH &&
    saved &&
    saved.t === 'split' &&
    Array.isArray(saved.children) &&
    saved.children.length > 0
  );
}

function countLeaves(saved, depth = 0) {
  if (!isSplit(saved, depth)) return 1;
  let n = 0;
  for (const c of saved.children) {
    n += countLeaves(c, depth + 1);
    if (n > MAX_PANES) return n; // already disqualifying, no point walking further
  }
  return n;
}

async function buildSavedNode(saved, depth = 0) {
  if (!isSplit(saved, depth)) {
    // a directory that no longer exists falls back to the start dir in main
    return createPane({ profileId: saved?.profileId || undefined, cwd: saved?.cwd || undefined });
  }
  const children = [];
  for (const c of saved.children) children.push(await buildSavedNode(c, depth + 1));
  return {
    type: 'split',
    dir: saved.dir === 'col' ? 'col' : 'row',
    children,
    sizes: savedSizes(saved.sizes, children.length),
    el: null
  };
}

async function restoreTabs(session) {
  let budget = MAX_PANES;
  const savedTabs = [];
  for (const t of session.tabs.slice(0, MAX_TABS)) {
    const panes = countLeaves(t?.root);
    if (panes > MAX_PANES_PER_TAB || panes > budget) continue;
    budget -= panes;
    savedTabs.push(t);
  }
  if (savedTabs.length < session.tabs.length) {
    toast(`Restored ${savedTabs.length} of ${session.tabs.length} saved tabs`);
  }
  restoring = true;
  try {
    for (const savedTab of savedTabs) {
      const tab = {
        id: 'tab-' + ++tabCounter,
        title: '',
        root: null,
        activePane: null,
        contentEl: document.createElement('div')
      };
      tab.contentEl.className = 'tab-content';
      tab.root = await buildSavedNode(savedTab.root);
      const first = firstLeaf(tab.root);
      tab.title = first.profileName || 'shell';
      state.tabs.push(tab);
      activateTab(tab);
      renderTab(tab);
      focusPane(first);
    }
  } finally {
    restoring = false;
  }
  const target = state.tabs[session.activeTab];
  if (target) activateTab(target);
  return state.tabs.length > 0;
}

// ---------- shell profiles ----------

let profiles = []; // [{ id, name, agentWrapper }] — from theme.json, detected on first run

// Agent mode needs a shell we can inject the `claude` wrapper into; cmd/WSL
// can't host it, so agent tabs fall back to the first shell that can.
function agentProfileId() {
  const def = profiles.find((p) => p.id === state.theme?.defaultProfile);
  if (def && def.agentWrapper !== 'none') return def.id;
  return profiles.find((p) => p.agentWrapper !== 'none')?.id;
}

function closeProfileMenu() {
  el.profileMenu.classList.remove('open');
}

function openProfileMenu(anchor) {
  if (el.profileMenu.classList.contains('open')) {
    closeProfileMenu();
    return;
  }
  el.profileMenu.replaceChildren(
    ...profiles.map((p, i) => {
      const item = document.createElement('button');
      item.className = 'menu-item';
      const name = document.createElement('span');
      name.textContent = p.name;
      item.appendChild(name);
      if (i < 9) {
        const kbd = document.createElement('em');
        kbd.textContent = `Ctrl+Shift+${i + 1}`;
        item.appendChild(kbd);
      }
      item.addEventListener('click', () => {
        closeProfileMenu();
        newTab({ profileId: p.id });
      });
      return item;
    })
  );
  if (!profiles.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No profiles — check theme.json';
    el.profileMenu.appendChild(p);
  }
  const r = anchor.getBoundingClientRect();
  el.profileMenu.style.left = Math.round(r.left) + 'px';
  el.profileMenu.style.top = Math.round(r.bottom + 4) + 'px';
  el.profileMenu.classList.add('open');
}

window.addEventListener('mousedown', (ev) => {
  if (!el.profileMenu.contains(ev.target) && ev.target.id !== 'btn-newtab-menu') closeProfileMenu();
});

// ---------- agent mode ----------

const globalAgents = new Map(); // agentId -> agent {id,name,cwd,branch,git,ptyId,leaf,status}
const agentsByPty = new Map(); // ptyId -> agent
const pendingNames = new Map(); // ptyId -> preferred display name
let sessions = []; // resumable past sessions [{name,cwd,branch,lastSeen}]
const STATUS_RANK = { blocked: 4, working: 3, done: 2, idle: 1, exited: 0 };

function agentTabs() {
  return state.tabs.filter((t) => t.kind === 'agents');
}

function worstAgentStatus() {
  let worst = 'idle';
  for (const a of globalAgents.values()) {
    if ((STATUS_RANK[a.status] ?? 0) > (STATUS_RANK[worst] ?? 0)) worst = a.status;
  }
  return worst;
}

function renderAgentLists() {
  for (const t of agentTabs()) renderAgentList(t);
  renderTabs();
}

// Agents are global, so a second agent tab renders a byte-identical list and
// clicking an agent in it jumps you to wherever its pane actually lives. It was
// never a second workspace — spaces are the grouping — so asking for one just
// returns you to the one that exists. That also makes the single diff watcher
// correct by construction rather than a race between tabs.
async function newAgentTab() {
  const existing = agentTabs()[0];
  if (existing) {
    activateTab(existing);
    return existing;
  }
  // Another window may already hold it; main focuses that one and tells us to
  // stand down rather than opening a duplicate here.
  const claim = await api.agentsClaimTab();
  if (!claim?.owned) return null;
  const tab = {
    id: 'tab-' + ++tabCounter,
    kind: 'agents',
    title: 'agents',
    root: null,
    activePane: null,
    contentEl: document.createElement('div'),
    centerLeaves: new Set(),
    selected: null,
    els: {}
  };
  tab.contentEl.className = 'tab-content';
  buildAgentLayout(tab);
  state.tabs.push(tab);
  activateTab(tab);
  // default center terminal: cd anywhere and run `claude` — auto-registers
  const leaf = await createPane({ profileId: agentProfileId() });
  addCenterLeaf(tab, leaf, true);
  const cfg = await api.agentsGetConfig();
  renderSpaces(tab, cfg);
  sessions = await api.agentsGetSessions();
  renderAgentList(tab);
  await refreshWorktrees();
  return tab;
}

function addCenterLeaf(tab, leaf, show) {
  tab.centerLeaves.add(leaf);
  leaf.el.classList.add('agent-pane');
  tab.els.empty.style.display = 'none';
  tab.els.center.appendChild(leaf.el);
  if (show) setCenterVisible(tab, leaf);
  else leaf.el.style.display = 'none';
}

function setCenterVisible(tab, leaf) {
  for (const l of tab.centerLeaves) l.el.style.display = l === leaf ? '' : 'none';
  if (leaf.ptyId) api.ptyMute(leaf.ptyId);
  requestAnimationFrame(() => {
    leaf.fit.fit();
    leaf.term.focus();
  });
}

// ---------- agent layout sizing ----------
// The rail and the diff panel are draggable and remembered. Widths are stored as
// the user set them; when the window is too narrow to honour both, they're
// scaled down for display only, so widening the window restores them.

const AGENT_MIN = { rail: 150, diff: 220, center: 260 };
const GUTTER = 6;

function agentColumns() {
  const stored = state.theme?.agentLayout || {};
  return { rail: stored.rail ?? 210, diff: stored.diff ?? 340 };
}

function applyAgentColumns(tab) {
  if (!tab.els?.layout) return;
  let { rail, diff } = agentColumns();
  const total = tab.els.layout.clientWidth;
  if (total) {
    const available = total - AGENT_MIN.center - GUTTER * 2;
    if (rail + diff > available) {
      const scale = Math.max(0.15, available / (rail + diff));
      rail = Math.max(AGENT_MIN.rail, Math.round(rail * scale));
      diff = Math.max(AGENT_MIN.diff, Math.round(diff * scale));
    }
  }
  const columns = `${rail}px ${GUTTER}px 1fr ${GUTTER}px ${diff}px`;
  // guard against feeding the ResizeObserver its own change
  if (tab.appliedColumns === columns) return;
  tab.appliedColumns = columns;
  tab.els.layout.style.gridTemplateColumns = columns;
}

function wireGutter(tab, gutter, edge) {
  gutter.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    gutter.setPointerCapture(ev.pointerId);
    gutter.classList.add('dragging');
    const startX = ev.clientX;
    const startWidth = agentColumns()[edge];

    const move = (mv) => {
      // the diff panel grows leftwards, so its delta is inverted
      const delta = edge === 'rail' ? mv.clientX - startX : startX - mv.clientX;
      const other = agentColumns()[edge === 'rail' ? 'diff' : 'rail'];
      const room = tab.els.layout.clientWidth - other - AGENT_MIN.center - GUTTER * 2;
      const next = Math.max(AGENT_MIN[edge], Math.min(room, startWidth + delta));
      state.theme.agentLayout = { ...agentColumns(), [edge]: Math.round(next) };
      for (const t of agentTabs()) applyAgentColumns(t);
    };
    const up = () => {
      gutter.classList.remove('dragging');
      gutter.releasePointerCapture?.(ev.pointerId);
      gutter.removeEventListener('pointermove', move);
      gutter.removeEventListener('pointerup', up);
      saveTheme();
    };
    gutter.addEventListener('pointermove', move);
    gutter.addEventListener('pointerup', up);
  });
}

function buildAgentLayout(tab) {
  const layout = document.createElement('div');
  layout.className = 'agents-layout';
  layout.innerHTML = `
    <div class="agents-rail">
      <div class="rail-section">
        <div class="rail-head"><h4>Spaces</h4><button class="rail-add" title="Add a git repo">+</button></div>
        <div class="spaces-list"></div>
      </div>
      <div class="rail-section">
        <div class="rail-head"><h4>Agents</h4></div>
        <div class="agents-list"></div>
      </div>
      <div class="rail-section">
        <div class="rail-head">
          <h4>Worktrees</h4>
          <button class="rail-prune" title="Forget worktrees whose folder is gone">prune</button>
        </div>
        <div class="worktrees-list"></div>
      </div>
    </div>
    <div class="agents-gutter" data-edge="rail" title="Drag to resize"></div>
    <div class="agents-center">
      <div class="agents-empty">cd into a repo and run <b>claude</b> — it becomes an agent automatically.</div>
    </div>
    <div class="agents-gutter" data-edge="diff" title="Drag to resize"></div>
    <div class="agents-diff">
      <div class="diff-head">
        <span class="diff-title">Diff watch</span>
        <div class="diff-toggle">
          <button data-mode="session" class="active" title="Everything since the agent started, commits included">Session</button>
          <button data-mode="uncommitted" title="Working tree vs HEAD only">Uncommitted</button>
        </div>
      </div>
      <div class="diff-sub">
        <span class="diff-summary"></span>
        <div class="diff-tools">
          <button class="diff-fold" title="Collapse or expand every file">fold</button>
        </div>
      </div>
      <div class="diff-body"><p class="hint">No agent selected</p></div>
    </div>`;
  tab.contentEl.appendChild(layout);
  tab.diffMode = 'session';
  // The diff is recomputed on every file change, so what the reader has done to
  // it — folded a file away, scrolled to a hunk — has to outlive the re-render.
  tab.diffCollapsed = new Set();
  tab.diffCwd = null;
  tab.els = {
    layout,
    spacesList: layout.querySelector('.spaces-list'),
    agentsList: layout.querySelector('.agents-list'),
    worktreesList: layout.querySelector('.worktrees-list'),
    center: layout.querySelector('.agents-center'),
    empty: layout.querySelector('.agents-empty'),
    diffTitle: layout.querySelector('.diff-title'),
    diffBody: layout.querySelector('.diff-body'),
    diffSummary: layout.querySelector('.diff-summary'),
    diffFoldBtn: layout.querySelector('.diff-fold')
  };
  tab.els.diffFoldBtn.addEventListener('click', () => {
    const files = [...tab.els.diffBody.querySelectorAll('.diff-file')];
    // fold everything, unless it is already all folded
    const expand = files.length > 0 && files.every((f) => f.classList.contains('collapsed'));
    for (const f of files) {
      f.classList.toggle('collapsed', !expand);
      const p = f.dataset.path;
      if (!p) continue;
      if (expand) tab.diffCollapsed.delete(p);
      else tab.diffCollapsed.add(p);
    }
  });
  layout.querySelectorAll('.diff-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      tab.diffMode = btn.dataset.mode;
      layout.querySelectorAll('.diff-toggle button').forEach((b) => b.classList.toggle('active', b === btn));
      reselectDiff(tab);
    });
  });
  layout.querySelectorAll('.agents-gutter').forEach((g) => wireGutter(tab, g, g.dataset.edge));
  applyAgentColumns(tab);
  // re-clamp when the window changes size, so a narrow window can't squeeze the
  // terminal out entirely
  new ResizeObserver(() => applyAgentColumns(tab)).observe(layout);

  layout.querySelector('.rail-prune').addEventListener('click', async () => {
    const pruned = await api.worktreesPrune();
    const total = pruned.reduce((n, p) => n + p.count, 0);
    toast(total ? `Forgot ${total} missing worktree${total > 1 ? 's' : ''}` : 'Nothing to prune');
    refreshWorktrees();
  });
  layout.querySelector('.rail-add').addEventListener('click', async () => {
    const cfg = await api.agentsAddSpace();
    if (!cfg) return;
    if (cfg.error) {
      toast(cfg.error);
      return;
    }
    renderSpaces(tab, cfg);
    refreshWorktrees();
  });
}

function renderSpaces(tab, cfg) {
  tab.els.spacesList.replaceChildren(
    ...(cfg.spaces || []).map((space) => {
      const row = document.createElement('div');
      row.className = 'space-row';
      const name = document.createElement('span');
      name.className = 'space-name';
      name.textContent = space.name;
      name.title = space.path;
      const btn = document.createElement('button');
      btn.textContent = '+ agent';
      btn.title = 'Spawn a Claude Code agent here';
      btn.addEventListener('click', () => showSpawnForm(tab, space, row));
      const del = document.createElement('button');
      del.className = 'space-remove';
      del.textContent = '×';
      del.title = 'Remove this space (repo itself is untouched)';
      del.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const cfg = await api.agentsRemoveSpace(space.path);
        renderSpaces(tab, cfg);
        refreshWorktrees();
      });
      row.append(name, btn, del);
      return row;
    })
  );
  if (!(cfg.spaces || []).length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No spaces yet — add a git repo with +';
    tab.els.spacesList.appendChild(p);
  }
}

function showSpawnForm(tab, space, row) {
  if (row.nextElementSibling?.classList.contains('spawn-form')) {
    row.nextElementSibling.remove();
    return;
  }
  tab.els.spacesList.querySelectorAll('.spawn-form').forEach((f) => f.remove());
  const form = document.createElement('div');
  form.className = 'spawn-form';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'agent name';
  input.spellcheck = false;
  const wtLabel = document.createElement('label');
  wtLabel.className = 'spawn-wt';
  const wtCheck = document.createElement('input');
  wtCheck.type = 'checkbox';
  wtLabel.append(wtCheck, document.createTextNode(' isolate in worktree (own branch)'));
  form.append(input, wtLabel);
  row.after(form);
  input.focus();
  input.addEventListener('keydown', async (ev) => {
    if (ev.key === 'Escape') form.remove();
    if (ev.key === 'Enter' && input.value.trim()) {
      const task = input.value.trim();
      const useWorktree = wtCheck.checked;
      form.remove();
      await spawnAgent(tab, space, task, useWorktree);
    }
  });
}

async function spawnAgent(tab, space, task, useWorktree = false) {
  const res = await api.agentsSpawn({ spacePath: space.path, task, useWorktree });
  if (!res || res.error) {
    toast(res?.error || 'Agent spawn failed');
    return;
  }
  const leaf = await createPane({ cwd: res.cwd, run: res.run, profileId: agentProfileId() });
  addCenterLeaf(tab, leaf, true);
  if (useWorktree) refreshWorktrees();
  pendingNames.set(leaf.ptyId, task);
  if (res.agentId) {
    // auto-detect off: agent pre-registered by the main process
    api.agentsTrack({ agentId: res.agentId, ptyId: leaf.ptyId });
    registerAgent({
      agentId: res.agentId,
      ptyId: leaf.ptyId,
      cwd: res.cwd,
      name: task,
      branch: res.branch,
      git: true
    });
  }
}

function registerAgent({ agentId, ptyId, cwd, name, branch, git }) {
  const leaf = panesByPty.get(ptyId);
  if (!leaf) return null;
  const agent = {
    id: agentId,
    name: pendingNames.get(ptyId) || name,
    cwd,
    branch,
    git,
    ptyId,
    leaf,
    status: 'working'
  };
  pendingNames.delete(ptyId);
  resuming.delete(String(cwd || '').toLowerCase());
  globalAgents.set(agentId, agent);
  agentsByPty.set(ptyId, agent);
  // if an agent tab hosts this pane in its center, select it there
  const host = agentTabs().find((t) => t.centerLeaves.has(leaf));
  if (host) selectAgent(host, agentId, { focus: false });
  renderAgentLists();
  return agent;
}

function selectAgent(tab, agentId, { focus = true } = {}) {
  const agent = globalAgents.get(agentId);
  if (!agent) return;
  if (tab.centerLeaves.has(agent.leaf)) {
    tab.selected = agentId;
    if (focus) setCenterVisible(tab, agent.leaf);
    else {
      for (const l of tab.centerLeaves) l.el.style.display = l === agent.leaf ? '' : 'none';
      agent.leaf.fit.fit();
    }
    tab.diffKey = 'agent:' + agentId;
    tab.els.diffTitle.textContent = `${agent.name} · ${agent.branch}`;
    tab.diffCwd = agent.cwd || null; // lets a line number in the diff open the file
    api.agentsSelectDiff({ agentId, mode: tab.diffMode });
    renderAgentList(tab);
    renderWorktrees(tab);
    return;
  }
  // pane lives elsewhere (normal tab or another agent tab) — jump to it
  const homeTab = agentTabs().find((t) => t.centerLeaves.has(agent.leaf)) || tabOfPane(agent.leaf);
  if (homeTab) {
    activateTab(homeTab);
    if (homeTab.kind === 'agents') selectAgent(homeTab, agentId);
    else focusPane(agent.leaf);
    return;
  }

  // Its pane is gone, so there is nothing to show and the entry is stale. This
  // used to do nothing at all, which read as the click being ignored. Say so and
  // stop listing it, rather than leaving a row that can never open.
  globalAgents.delete(agentId);
  agentsByPty.delete(agent.ptyId);
  for (const t of agentTabs()) {
    if (t.selected === agentId) t.selected = null;
    if (t.diffKey === 'agent:' + agentId) t.diffKey = null;
  }
  renderAgentLists();
  toast(`${agent.name} is no longer running`, { error: true });
}

// Resuming is slow: claude has to boot before it registers as an agent, and the
// row stays on screen until it does. Without a guard a second click starts a
// second session in the same directory.
const resuming = new Set(); // lowercased cwds with a resume in flight

const sameDir = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

async function resumeSession(tab, session) {
  const cwd = session.cwd;
  const key = String(cwd || '').toLowerCase();

  const live = [...globalAgents.values()].find((a) => sameDir(a.cwd, cwd));
  if (live) return selectAgent(tab, live.id);

  // Only a pane this resumed counts. Matching any pane that happens to sit in
  // the directory would focus an ordinary shell and never resume anything —
  // the agent tab's own starting pane is usually already there.
  const open = [...tab.centerLeaves].find((l) => sameDir(l.resumedCwd, cwd));
  if (open) return setCenterVisible(tab, open);

  if (resuming.has(key)) return;
  resuming.add(key);
  renderAgentList(tab);
  try {
    const leaf = await createPane({
      cwd,
      run: 'claude --continue',
      profileId: agentProfileId()
    });
    leaf.resumedCwd = cwd;
    addCenterLeaf(tab, leaf, true);
    pendingNames.set(leaf.ptyId, session.name);
  } finally {
    // released when the agent registers; this is the backstop for a claude that
    // never starts, so the row doesn't stay stuck forever
    setTimeout(() => {
      if (resuming.delete(key)) renderAgentLists();
    }, 30000);
  }
}

function renderAgentList(tab) {
  const rows = [];
  for (const agent of globalAgents.values()) {
    const row = document.createElement('div');
    row.className = 'agent-row' + (tab.selected === agent.id ? ' selected' : '');
    row.innerHTML = `
      <span class="agent-dot st-${agent.status}"></span>
      <span class="agent-name"></span>
      <span class="agent-meta"></span>`;
    row.querySelector('.agent-name').textContent = agent.name;
    row.querySelector('.agent-meta').textContent = `${agent.branch} · ${agent.status}`;
    row.addEventListener('click', () => selectAgent(tab, agent.id));
    rows.push(row);
  }
  // compared case-insensitively: main canonicalises the separators, but Windows
  // paths can still differ in case for the same directory
  const liveCwds = new Set([...globalAgents.values()].map((a) => String(a.cwd || '').toLowerCase()));
  for (const s of sessions) {
    if (liveCwds.has(String(s.cwd || '').toLowerCase())) continue;
    const row = document.createElement('div');
    const busy = resuming.has(String(s.cwd || '').toLowerCase());
    row.className = 'agent-row dormant' + (busy ? ' busy' : '');
    row.title = busy ? `Resuming in ${s.cwd}` : `Resume last Claude session in ${s.cwd}`;
    row.innerHTML = `
      <span class="agent-dot st-exited"></span>
      <span class="agent-name"></span>
      <button class="session-remove" title="Forget this session">×</button>
      <span class="agent-meta"></span>`;
    row.querySelector('.agent-name').textContent = s.name;
    row.querySelector('.agent-meta').textContent = `${s.branch} · ${busy ? 'resuming…' : 'resume'}`;
    if (!busy) row.addEventListener('click', () => resumeSession(tab, s));
    row.querySelector('.session-remove').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      sessions = await api.agentsRemoveSession(s.cwd);
      renderAgentLists();
    });
    rows.push(row);
  }
  tab.els.agentsList.replaceChildren(...rows);
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No agents yet — run claude in the terminal';
    tab.els.agentsList.appendChild(p);
  }
}

// ---------- worktrees ----------
// An agent isolated in a worktree leaves behind a checkout under <repo>/.frost
// and a branch. This lists them so the work can be found and reviewed after the
// agent is gone, instead of only while it's selected.

let worktrees = [];

async function refreshWorktrees() {
  worktrees = await api.worktreesList();
  for (const tab of agentTabs()) renderWorktrees(tab);
}

// Re-issues the diff request for whatever the tab is currently showing, so the
// Session/Uncommitted toggle works for agents and worktrees alike.
function reselectDiff(tab) {
  if (!tab.diffKey) return;
  if (tab.diffKey.startsWith('agent:')) {
    api.agentsSelectDiff({ agentId: tab.diffKey.slice(6), mode: tab.diffMode });
  } else if (tab.diffKey.startsWith('wt:')) {
    const wt = worktrees.find((w) => 'wt:' + w.path === tab.diffKey);
    if (wt) api.worktreesSelectDiff({ cwd: wt.path, base: wt.base, mode: tab.diffMode });
  }
}

function selectWorktree(tab, wt) {
  tab.selected = null;
  tab.diffKey = 'wt:' + wt.path;
  tab.els.diffTitle.textContent = `${wt.name} · ${wt.branch || 'detached'}`;
  tab.diffCwd = wt.path || null;
  api.worktreesSelectDiff({ cwd: wt.path, base: wt.base, mode: tab.diffMode });
  renderAgentList(tab);
  renderWorktrees(tab);
}

function renderWorktrees(tab) {
  const spaces = new Set(worktrees.map((w) => w.space));
  const rows = worktrees.map((wt) => {
    const row = document.createElement('div');
    row.className = 'wt-row' + (tab.diffKey === 'wt:' + wt.path ? ' selected' : '');
    row.title = wt.path;

    const name = document.createElement('span');
    name.className = 'wt-name';
    // The branch is what you act on, so it gets the row; the space is only worth
    // naming when more than one is configured.
    const label = wt.branch || wt.name + ' (detached)';
    name.textContent = spaces.size > 1 ? `${wt.space}/${label}` : label;

    const actions = document.createElement('span');
    actions.className = 'wt-actions';

    const act = (label, title, run) => {
      const b = document.createElement('button');
      b.className = 'wt-act';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        b.disabled = true;
        try {
          await run();
        } finally {
          b.disabled = false;
        }
      });
      actions.appendChild(b);
      return b;
    };

    if (wt.exists) {
      act('open', 'Open a tab in this worktree', () => newTab({ cwd: wt.path }));
      act(
        'merge',
        `Merge ${wt.branch || 'this branch'} into ${wt.base}`,
        async () => {
          const res = await api.worktreesMerge(wt.path);
          if (res?.cancelled) return;
          if (res?.error) return toast(res.error, { error: true });
          toast(`Merged ${res.branch} into ${res.base}`);
          refreshWorktrees();
        }
      );
    }
    act('discard', 'Delete this worktree and its branch', async () => {
      const res = await api.worktreesDiscard(wt.path);
      if (res?.cancelled) return;
      if (res?.error) return toast(res.error, { error: true });
      if (res?.warning) toast(res.warning, { error: true });
      else toast(`Discarded ${wt.name}`);
      // the diff panel may have been showing what we just deleted
      if (tab.diffKey === 'wt:' + wt.path) {
        tab.diffKey = null;
        tab.diffCwd = null;
        tab.els.diffTitle.textContent = 'Diff watch';
        tab.els.diffSummary.textContent = '';
        tab.els.diffBody.innerHTML = '<p class="hint">No agent selected</p>';
        api.agentsSelectDiff(null);
      }
      refreshWorktrees();
    });

    const meta = document.createElement('span');
    meta.className = 'wt-meta';
    // No branch here: it's the row's title now, and repeating it only crowded
    // out the part that actually changes.
    const bits = [];
    if (!wt.exists) bits.push('folder missing');
    else {
      if (wt.ahead) bits.push(`${wt.ahead} commit${wt.ahead > 1 ? 's' : ''}`);
      if (wt.dirty) bits.push('uncommitted');
      if (!wt.ahead && !wt.dirty) bits.push('no changes');
    }
    if (wt.locked) bits.push('locked');
    meta.textContent = bits.join(' · ');

    row.append(name, actions, meta);
    if (wt.exists) row.addEventListener('click', () => selectWorktree(tab, wt));
    else row.classList.add('gone');
    return row;
  });

  tab.els.worktreesList.replaceChildren(...rows);
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No worktrees — tick "isolate in worktree" when spawning an agent';
    tab.els.worktreesList.appendChild(p);
  }
}

// ---------- diff viewer ----------

// A unified patch carries more than the +/- prefix each line starts with: which
// side of the change a line belongs to, what it is numbered in the file you
// would open, whether the file was added, deleted or renamed. Reading it as
// plain text throws all of that away, so it is parsed once into a shape the view
// can be built from.
function parsePatch(patch) {
  const files = [];
  let file = null;
  let hunk = null;
  for (const line of String(patch || '').split('\n')) {
    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      file = {
        path: m ? m[2] : line.slice(11).trim(),
        oldPath: m ? m[1] : '',
        status: 'modified',
        binary: false,
        adds: 0,
        dels: 0,
        hunks: []
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (line.startsWith('new file')) {
      file.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file')) {
      file.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      file.oldPath = line.slice(12);
      file.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      file.path = line.slice(10);
      file.status = 'renamed';
      continue;
    }
    if (line.startsWith('Binary files')) {
      file.binary = true;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      hunk = { context: m ? m[3].trim() : '', oldNo: m ? +m[1] : 0, newNo: m ? +m[2] : 0, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    // headers we have either already read or have no use for
    if (
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('old mode') ||
      line.startsWith('new mode') ||
      line.startsWith('similarity index') ||
      line.startsWith('\\') // "\ No newline at end of file"
    ) {
      continue;
    }
    if (!hunk) continue;
    const kind = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx';
    const entry = { kind, text: line.slice(1) };
    if (kind === 'add') {
      entry.newNo = hunk.newNo++;
      file.adds++;
    } else if (kind === 'del') {
      entry.oldNo = hunk.oldNo++;
      file.dels++;
    } else {
      entry.oldNo = hunk.oldNo++;
      entry.newNo = hunk.newNo++;
    }
    hunk.lines.push(entry);
  }
  return files;
}

// Where a removed line and the line replacing it differ. Only the run between
// the common prefix and the common suffix can have changed, which is cheap to
// find and is the part worth pointing at — a renamed variable in a long line is
// otherwise a whole red line beside a whole green one, and the eye has to hunt.
function inlineSpan(a, b) {
  if (!a || !b) return null;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a[start] === b[start]) start++;
  let tail = 0;
  while (tail < max - start && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  // nothing shared at either end: the line was rewritten, and marking all of it
  // says no more than the +/- already does
  if (start === 0 && tail === 0) return null;
  return { start, endA: a.length - tail, endB: b.length - tail };
}

function lineText(parent, text, span, side) {
  const code = document.createElement('span');
  code.className = 'dl-text';
  if (!span) {
    code.textContent = text || ' ';
  } else {
    const end = side === 'del' ? span.endA : span.endB;
    const mid = text.slice(span.start, end);
    code.append(text.slice(0, span.start));
    if (mid) {
      const mark = document.createElement('span');
      mark.className = 'dl-word';
      mark.textContent = mid;
      code.appendChild(mark);
    }
    code.append(text.slice(end));
  }
  parent.appendChild(code);
}

// Pair each removed line with the line that replaced it, so the two can be
// compared. Only balanced runs are paired: three lines deleted and one added is
// a rewrite, not three edits, and guessing which is which would mislead.
function pairRuns(lines) {
  const pairs = new Map();
  for (let i = 0; i < lines.length; ) {
    if (lines[i].kind !== 'del') {
      i++;
      continue;
    }
    let d = i;
    while (d < lines.length && lines[d].kind === 'del') d++;
    let a = d;
    while (a < lines.length && lines[a].kind === 'add') a++;
    const dels = d - i;
    const adds = a - d;
    if (dels && dels === adds) {
      for (let k = 0; k < dels; k++) pairs.set(i + k, d + k);
    }
    i = a > d ? a : d;
  }
  return pairs;
}

const DIFF_LINE_CAP = 600; // per file, before a "show the rest" button

function diffLineRow(tab, file, entry, span) {
  const row = document.createElement('div');
  row.className = 'diff-line ' + entry.kind;
  const oldNo = document.createElement('span');
  oldNo.className = 'dl-no';
  oldNo.textContent = entry.oldNo || '';
  const newNo = document.createElement('span');
  newNo.className = 'dl-no';
  newNo.textContent = entry.newNo || '';
  const sign = document.createElement('span');
  sign.className = 'dl-sign';
  sign.textContent = entry.kind === 'add' ? '+' : entry.kind === 'del' ? '−' : ' ';
  row.append(oldNo, newNo, sign);
  lineText(row, entry.text, span, entry.kind);
  // the number is the one place in the row where "take me there" is unambiguous
  if (entry.newNo && tab.diffCwd && file.status !== 'deleted') {
    newNo.classList.add('linkable');
    newNo.title = `Open ${file.path}:${entry.newNo}`;
    newNo.addEventListener('click', (ev) => {
      ev.stopPropagation();
      api.openPath({ cwd: tab.diffCwd, target: file.path, line: entry.newNo });
    });
  }
  return row;
}

function renderDiffFile(tab, file) {
  const el = document.createElement('div');
  el.className = 'diff-file';
  el.dataset.path = file.path;
  if (tab.diffCollapsed.has(file.path)) el.classList.add('collapsed');

  const head = document.createElement('div');
  head.className = 'diff-file-head';
  const chev = document.createElement('span');
  chev.className = 'df-chev';
  chev.textContent = '▾';
  const badge = document.createElement('span');
  badge.className = 'df-badge ' + file.status;
  badge.textContent = file.status[0].toUpperCase();
  badge.title = file.status;
  // basename first and whole, directory after it as context — a column of
  // truncated paths that all begin "src/renderer/…" identifies nothing
  const slash = file.path.lastIndexOf('/');
  const name = document.createElement('span');
  name.className = 'df-name';
  name.textContent = file.path.slice(slash + 1);
  const dir = document.createElement('span');
  dir.className = 'df-dir';
  dir.textContent = slash > -1 ? file.path.slice(0, slash) : '';
  const title = file.status === 'renamed' ? `${file.oldPath} → ${file.path}` : file.path;
  name.title = title;
  dir.title = title;
  const stat = document.createElement('span');
  stat.className = 'df-stat';
  if (file.adds) {
    const s = document.createElement('span');
    s.className = 'add';
    s.textContent = '+' + file.adds;
    stat.appendChild(s);
  }
  if (file.dels) {
    const s = document.createElement('span');
    s.className = 'del';
    s.textContent = '−' + file.dels;
    stat.appendChild(s);
  }
  head.append(chev, badge, name, dir, stat);
  head.addEventListener('click', () => {
    el.classList.toggle('collapsed');
    if (el.classList.contains('collapsed')) tab.diffCollapsed.add(file.path);
    else tab.diffCollapsed.delete(file.path);
  });

  const body = document.createElement('div');
  body.className = 'diff-file-body';
  if (file.binary) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Binary file';
    body.appendChild(p);
  }

  let drawn = 0;
  const overflow = [];
  for (const hunk of file.hunks) {
    const hd = document.createElement('div');
    hd.className = 'diff-line hunk';
    hd.textContent = hunk.context || `line ${hunk.newNo}`;
    (drawn < DIFF_LINE_CAP ? body : overflow).appendChild(hd);
    const pairs = pairRuns(hunk.lines);
    const partner = new Map();
    for (const [d, a] of pairs) {
      partner.set(d, a);
      partner.set(a, d);
    }
    hunk.lines.forEach((entry, i) => {
      let span = null;
      const other = partner.get(i);
      if (other !== undefined) {
        const a = entry.kind === 'del' ? entry.text : hunk.lines[other].text;
        const b = entry.kind === 'del' ? hunk.lines[other].text : entry.text;
        span = inlineSpan(a, b);
      }
      const row = diffLineRow(tab, file, entry, span);
      if (drawn < DIFF_LINE_CAP) body.appendChild(row);
      else overflow.push(row);
      drawn++;
    });
  }
  if (overflow.length) {
    const more = document.createElement('button');
    more.className = 'diff-more';
    more.textContent = `Show ${overflow.length} more lines`;
    more.addEventListener('click', () => {
      more.replaceWith(...overflow);
    });
    body.appendChild(more);
  }

  el.append(head, body);
  return el;
}

function renderDiff(tab, patch, statusText) {
  const files = parsePatch(patch);
  const untracked = (statusText || '')
    .split('\n')
    .filter((l) => l.startsWith('??'))
    .map((l) => l.slice(3).trim())
    .filter(Boolean);

  const adds = files.reduce((n, f) => n + f.adds, 0);
  const dels = files.reduce((n, f) => n + f.dels, 0);
  const count = files.length + untracked.length;
  if (!count) {
    tab.els.diffSummary.textContent = '';
  } else {
    // same green and red as the per-file counts, so the totals read as the same
    // quantity summed rather than as a separate label
    const plus = document.createElement('span');
    plus.className = 'add';
    plus.textContent = `+${adds}`;
    const minus = document.createElement('span');
    minus.className = 'del';
    minus.textContent = `−${dels}`;
    tab.els.diffSummary.replaceChildren(`${count} file${count > 1 ? 's' : ''} · `, plus, ' ', minus);
  }

  if (!files.length && !untracked.length) {
    tab.els.diffBody.replaceChildren(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'No changes yet' }));
    return;
  }

  const out = files.map((f) => renderDiffFile(tab, f));

  if (untracked.length) {
    const el = document.createElement('div');
    el.className = 'diff-file';
    el.dataset.path = ' untracked';
    if (tab.diffCollapsed.has(' untracked')) el.classList.add('collapsed');
    const head = document.createElement('div');
    head.className = 'diff-file-head';
    const chev = document.createElement('span');
    chev.className = 'df-chev';
    chev.textContent = '▾';
    const badge = document.createElement('span');
    badge.className = 'df-badge untracked';
    badge.textContent = '?';
    badge.title = 'untracked';
    const name = document.createElement('span');
    name.className = 'df-name';
    name.textContent = `untracked (${untracked.length})`;
    head.append(chev, badge, name);
    head.addEventListener('click', () => {
      el.classList.toggle('collapsed');
      if (el.classList.contains('collapsed')) tab.diffCollapsed.add(' untracked');
      else tab.diffCollapsed.delete(' untracked');
    });
    const body = document.createElement('div');
    body.className = 'diff-file-body';
    for (const f of untracked) {
      const row = document.createElement('div');
      row.className = 'diff-line add untracked-row';
      const text = document.createElement('span');
      text.className = 'dl-text';
      text.textContent = f;
      row.appendChild(text);
      if (tab.diffCwd) {
        row.title = `Open ${f}`;
        row.addEventListener('click', () => api.openPath({ cwd: tab.diffCwd, target: f }));
      }
      body.appendChild(row);
    }
    el.append(head, body);
    out.push(el);
  }

  // Written to every 400ms while an agent works: replacing the contents would
  // otherwise throw the reader back to the top of the panel mid-sentence.
  const keep = tab.els.diffBody.scrollTop;
  tab.els.diffBody.replaceChildren(...out);
  tab.els.diffBody.scrollTop = keep;
}

api.onAgentStatus(({ agentId, status }) => {
  const agent = globalAgents.get(agentId);
  if (!agent) return;
  agent.status = status;
  renderAgentLists();
});

api.onAgentDiff(({ key, patch, status, nogit }) => {
  for (const tab of agentTabs()) {
    if (tab.diffKey !== key) continue;
    if (nogit) {
      tab.els.diffBody.innerHTML = '<p class="hint">Not a git repository — no diff available</p>';
    } else {
      renderDiff(tab, patch, status);
    }
  }
});

api.onAgentDetected((msg) => {
  sessions = msg.sessions || sessions;
  const existing = agentsByPty.get(msg.ptyId);
  if (existing) {
    // claude re-launched in the same pane: refresh identity
    globalAgents.delete(existing.id);
    agentsByPty.delete(msg.ptyId);
  }
  registerAgent(msg);
});

// Clicking a notification should land you on the agent it was about.
api.onAgentReveal((agentId) => {
  const agent = globalAgents.get(agentId);
  if (!agent) return;
  const host = agentTabs().find((t) => t.centerLeaves.has(agent.leaf));
  if (host) {
    activateTab(host);
    selectAgent(host, agentId);
    return;
  }
  const tab = tabOfPane(agent.leaf);
  if (tab) {
    activateTab(tab);
    focusPane(agent.leaf);
  }
});

api.onAgentEnded(({ agentId, sessions: s }) => {
  if (s) sessions = s;
  const agent = globalAgents.get(agentId);
  if (agent) {
    globalAgents.delete(agentId);
    agentsByPty.delete(agent.ptyId);
    for (const tab of agentTabs()) {
      if (tab.selected === agentId) tab.selected = null;
      if (tab.diffKey === 'agent:' + agentId) tab.diffKey = null;
    }
  }
  renderAgentLists();
  refreshWorktrees();
});

// ---------- keys ----------
// Bindings are matched on physical key position (ev.code), so they land in the
// same place on every keyboard layout. config/keybindings.json overrides them.

const KEY_ALIASES = {
  Equal: '=',
  NumpadAdd: '=',
  Minus: '-',
  NumpadSubtract: '-',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Backquote: '`',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Space: 'space',
  Enter: 'enter',
  NumpadEnter: 'enter',
  Tab: 'tab',
  Escape: 'escape',
  Backspace: 'backspace',
  Delete: 'delete',
  Insert: 'insert',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down'
};

const NAME_ALIASES = {
  control: 'ctrl',
  esc: 'escape',
  del: 'delete',
  return: 'enter',
  plus: '=',
  add: '=',
  minus: '-',
  subtract: '-',
  arrowleft: 'left',
  arrowright: 'right',
  arrowup: 'up',
  arrowdown: 'down'
};

function keyName(code) {
  if (KEY_ALIASES[code]) return KEY_ALIASES[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code.toLowerCase();
  return null;
}

function eventKeys(ev) {
  const name = keyName(ev.code);
  if (!name) return null;
  const parts = [];
  if (ev.ctrlKey) parts.push('ctrl');
  if (ev.altKey) parts.push('alt');
  if (ev.shiftKey) parts.push('shift');
  if (ev.metaKey) parts.push('meta');
  parts.push(name);
  return parts.join('+');
}

function normalizeKeys(str) {
  const raw = String(str || '')
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => NAME_ALIASES[p] || p);
  const key = raw.pop();
  const parts = ['ctrl', 'alt', 'shift', 'meta'].filter((m) => raw.includes(m));
  parts.push(key);
  return parts.join('+');
}

// ---------- commands ----------

const commands = [];
const commandsById = new Map();

function cmd(id, label, run) {
  const c = { id, label, run };
  commands.push(c);
  commandsById.set(id, c);
}

function cycleTab(dir) {
  if (state.tabs.length < 2) return;
  const i = state.tabs.indexOf(state.activeTab);
  activateTab(state.tabs[(i + dir + state.tabs.length) % state.tabs.length]);
}

function activePane() {
  const tab = state.activeTab;
  if (!tab) return null;
  if (tab.kind === 'agents') return [...tab.centerLeaves].find((l) => l.el.style.display !== 'none') || null;
  return tab.activePane;
}

// Geometric pane navigation: works for any split tree, unlike walking the tree,
// because what "left" means on screen is a question about rectangles.
function focusDirection(dir) {
  const tab = state.activeTab;
  if (!tab || !tab.root || tab.kind === 'agents') return;
  const cur = tab.activePane;
  if (!cur) return;
  const a = cur.el.getBoundingClientRect();
  const horizontal = dir === 'left' || dir === 'right';
  let best = null;
  let bestGap = Infinity;
  for (const leaf of allLeaves(tab.root)) {
    if (leaf === cur) continue;
    const b = leaf.el.getBoundingClientRect();
    // must overlap on the other axis, else it isn't "beside" the current pane
    const overlaps = horizontal
      ? b.bottom > a.top + 1 && b.top < a.bottom - 1
      : b.right > a.left + 1 && b.left < a.right - 1;
    if (!overlaps) continue;
    const gap =
      dir === 'left' ? a.left - b.right
      : dir === 'right' ? b.left - a.right
      : dir === 'up' ? a.top - b.bottom
      : b.top - a.bottom;
    if (gap < -1 || gap >= bestGap) continue;
    best = leaf;
    bestGap = gap;
  }
  if (best) focusPane(best);
}

let bootFontSize = null;

function setFontSize(px) {
  const t = state.theme;
  if (!t) return;
  t.font = t.font || {};
  t.font.size = Math.min(28, Math.max(8, px));
  applyTheme(t, undefined);
  saveTheme();
}

cmd('window.new', 'New window', () => api.winNew());
cmd('tab.new', 'New tab', () => newTab());
cmd('tab.newProfile', 'New tab: Nth shell profile', ({ index, profile }) => {
  const p = profile ? profiles.find((x) => x.id === profile) : profiles[(index || 1) - 1];
  if (p) newTab({ profileId: p.id });
});
cmd('tab.duplicate', 'Duplicate tab (same shell and directory)', () => {
  const pane = activePane();
  if (pane) newTab({ profileId: pane.profileId, cwd: pane.cwd });
});
cmd('tab.agent', 'New agent tab', () => newAgentTab());
cmd('tab.close', 'Close tab', () => state.activeTab && closeTab(state.activeTab));
cmd('tab.next', 'Next tab', () => cycleTab(1));
cmd('tab.prev', 'Previous tab', () => cycleTab(-1));
cmd('tab.go', 'Go to tab N', ({ index }) => {
  const t = state.tabs[(index || 1) - 1];
  if (t) activateTab(t);
});
cmd('tab.last', 'Go to last tab', () => {
  if (state.tabs.length) activateTab(state.tabs[state.tabs.length - 1]);
});
cmd('shell.menu', 'Choose a shell profile…', () => openProfileMenu(document.getElementById('btn-newtab-menu')));

cmd('pane.splitRight', 'Split pane right', () => splitPane('row'));
cmd('pane.splitDown', 'Split pane down', () => splitPane('col'));
cmd('pane.close', 'Close pane', () => {
  const tab = state.activeTab;
  if (!tab) return;
  if (tab.activePane) removePane(tab.activePane);
  else closeTab(tab); // agent tabs have no pane tree to close into
});
cmd('pane.focusLeft', 'Focus pane left', () => focusDirection('left'));
cmd('pane.focusRight', 'Focus pane right', () => focusDirection('right'));
cmd('pane.focusUp', 'Focus pane up', () => focusDirection('up'));
cmd('pane.focusDown', 'Focus pane down', () => focusDirection('down'));

cmd('font.zoomIn', 'Terminal font bigger', () => setFontSize((state.theme?.font?.size || 14) + 1));
cmd('font.zoomOut', 'Terminal font smaller', () => setFontSize((state.theme?.font?.size || 14) - 1));
cmd('font.zoomReset', 'Reset terminal font size', () => setFontSize(bootFontSize || 14));

// Whole-UI zoom, remembered by the main process against the monitor the window
// is on: the size that suits a laptop panel is not the size that suits a 4K
// screen at arm's length, and the two should not have to be reconciled.
const zoomStep = async (dir) => {
  const factor = await api.zoomStep(dir);
  toast(`Zoom ${Math.round(factor * 100)}% on this screen`);
};
cmd('view.zoomIn', 'Zoom in', () => zoomStep(1));
cmd('view.zoomOut', 'Zoom out', () => zoomStep(-1));
cmd('view.zoomReset', 'Reset zoom', () => zoomStep(0));

cmd('view.search', 'Find in buffer', () => {
  const pane = activePane();
  if (pane) openPaneSearch(pane);
});
cmd('view.clear', 'Clear buffer', () => {
  const pane = activePane();
  if (pane) pane.term.clear();
});
cmd('command.previous', 'Jump to previous command', () => jumpToMark(activePane(), -1));
cmd('command.next', 'Jump to next command', () => jumpToMark(activePane(), 1));
cmd('view.scrollToTop', 'Scroll to top', () => activePane()?.term.scrollToTop());
cmd('view.scrollToBottom', 'Scroll to bottom', () => activePane()?.term.scrollToBottom());

cmd('app.settings', 'Settings', () => toggleSettings());
cmd('app.palette', 'Command palette', () => openPalette());
cmd('app.openKeys', 'Edit keybindings.json', () => api.themeOpenFile('keys'));
cmd('app.openTheme', 'Edit theme.json', () => api.themeOpenFile('json'));
cmd('app.openCss', 'Edit theme.css', () => api.themeOpenFile('css'));

// ---------- bindings ----------

const DEFAULT_BINDINGS = [
  { keys: 'ctrl+shift+t', command: 'tab.new' },
  { keys: 'ctrl+shift+n', command: 'window.new' },
  { keys: 'ctrl+shift+a', command: 'tab.agent' },
  { keys: 'ctrl+shift+d', command: 'tab.duplicate' },
  { keys: 'ctrl+shift+w', command: 'pane.close' },
  { keys: 'ctrl+tab', command: 'tab.next' },
  { keys: 'ctrl+shift+tab', command: 'tab.prev' },
  { keys: 'ctrl+9', command: 'tab.last' },
  { keys: 'alt+shift+=', command: 'pane.splitRight' },
  { keys: 'alt+shift+-', command: 'pane.splitDown' },
  { keys: 'alt+left', command: 'pane.focusLeft' },
  { keys: 'alt+right', command: 'pane.focusRight' },
  { keys: 'alt+up', command: 'pane.focusUp' },
  { keys: 'alt+down', command: 'pane.focusDown' },
  { keys: 'ctrl+=', command: 'view.zoomIn' },
  { keys: 'ctrl+shift+=', command: 'view.zoomIn' },
  { keys: 'ctrl+-', command: 'view.zoomOut' },
  { keys: 'ctrl+0', command: 'view.zoomReset' },
  { keys: 'ctrl+,', command: 'app.settings' },
  { keys: 'ctrl+f', command: 'view.search' },
  { keys: 'ctrl+shift+k', command: 'view.clear' },
  { keys: 'ctrl+shift+up', command: 'command.previous' },
  { keys: 'ctrl+shift+down', command: 'command.next' },
  { keys: 'ctrl+shift+p', command: 'app.palette' },
  // Ctrl+1..8 pick a tab, Ctrl+Shift+1..9 open the Nth shell profile
  ...Array.from({ length: 8 }, (_, i) => ({
    keys: `ctrl+${i + 1}`,
    command: 'tab.go',
    args: { index: i + 1 }
  })),
  ...Array.from({ length: 9 }, (_, i) => ({
    keys: `ctrl+shift+${i + 1}`,
    command: 'tab.newProfile',
    args: { index: i + 1 }
  }))
];

let keymap = new Map(); // 'ctrl+shift+t' -> { command, args }

function buildKeymap(user = []) {
  const m = new Map();
  for (const b of DEFAULT_BINDINGS) m.set(normalizeKeys(b.keys), { command: b.command, args: b.args });
  for (const b of user) {
    if (!b || !b.keys) continue;
    const k = normalizeKeys(b.keys);
    // command: null unbinds the key entirely
    if (!b.command || b.command === 'none') m.delete(k);
    else m.set(k, { command: b.command, args: b.args });
  }
  keymap = m;
}

function keysFor(commandId, args) {
  const want = JSON.stringify(args ?? null);
  for (const [k, b] of keymap) {
    if (b.command !== commandId) continue;
    if (JSON.stringify(b.args ?? null) !== want) continue;
    return k;
  }
  return null;
}

function runCommand(id, args) {
  const c = commandsById.get(id);
  if (!c) {
    toast('Unknown command: ' + id, { error: true });
    return;
  }
  c.run(args || {});
}

function matchShortcut(ev) {
  const k = eventKeys(ev);
  if (!k) return null;
  const b = keymap.get(k);
  return b ? () => runCommand(b.command, b.args) : null;
}

buildKeymap();

// ---------- modal ----------
// For the rare question that must not be missed. A toast was wrong for this:
// it faded after a couple of seconds and the setting looked broken.

const modal = {
  root: document.getElementById('modal'),
  title: document.querySelector('#modal .modal-title'),
  detail: document.querySelector('#modal .modal-detail'),
  note: document.querySelector('#modal .modal-note'),
  confirm: document.querySelector('#modal .modal-confirm'),
  later: document.querySelector('#modal .modal-later')
};

function closeModal() {
  modal.root.classList.remove('open');
  activePane()?.term.focus();
}

function askModal({ title, detail, note, confirmLabel = 'Restart now' }, onConfirm) {
  modal.title.textContent = title;
  modal.detail.textContent = detail;
  modal.note.textContent = note || '';
  modal.note.style.display = note ? '' : 'none';
  modal.confirm.textContent = confirmLabel;
  modal.root.classList.add('open');
  modal.confirm.focus();
  modal.onConfirm = onConfirm;
}

modal.confirm.addEventListener('click', () => {
  const run = modal.onConfirm;
  closeModal();
  run?.();
});
modal.later.addEventListener('click', closeModal);
modal.root.addEventListener('mousedown', (ev) => {
  if (ev.target === modal.root) closeModal();
});
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && modal.root.classList.contains('open')) {
    ev.preventDefault();
    closeModal();
  }
});

api.onNeedsRestart((info) => askModal(info, () => api.appRelaunch()));

// ---------- command palette ----------
// Doubles as the shortcut reference: every command shows the key it answers to,
// which is why the defaults don't need to be duplicated into a config file.

const palette = { items: [], index: 0, returnTo: null };

function paletteItems() {
  // tab.go / tab.newProfile take an index, so they're listed per tab / profile
  const items = commands
    .filter((c) => c.id !== 'tab.go' && c.id !== 'tab.newProfile')
    .map((c) => ({ label: c.label, command: c.id, args: null }));
  profiles.forEach((p, i) =>
    items.push({ label: `New tab: ${p.name}`, command: 'tab.newProfile', args: { index: i + 1 } })
  );
  state.tabs.forEach((t, i) =>
    items.push({ label: `Go to tab ${i + 1}: ${t.title}`, command: 'tab.go', args: { index: i + 1 } })
  );
  return items;
}

// subsequence match: "ndt" finds "New tab", "spr" finds "Split pane right"
function fuzzy(hay, needle) {
  if (!needle) return true;
  const h = hay.toLowerCase();
  let i = 0;
  for (const ch of needle.toLowerCase()) {
    if (ch === ' ') continue;
    i = h.indexOf(ch, i);
    if (i < 0) return false;
    i++;
  }
  return true;
}

function renderPalette() {
  const query = el.paletteInput.value.trim();
  palette.items = paletteItems().filter((it) => fuzzy(it.label, query));
  palette.index = Math.min(palette.index, Math.max(0, palette.items.length - 1));
  el.paletteList.replaceChildren(
    ...palette.items.map((it, i) => {
      const row = document.createElement('button');
      row.className = 'palette-item' + (i === palette.index ? ' selected' : '');
      const label = document.createElement('span');
      label.textContent = it.label;
      row.appendChild(label);
      const keys = keysFor(it.command, it.args);
      if (keys) {
        const kbd = document.createElement('em');
        kbd.textContent = keys;
        row.appendChild(kbd);
      }
      row.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        choosePalette(i);
      });
      return row;
    })
  );
  if (!palette.items.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No matching command';
    el.paletteList.appendChild(p);
  }
  el.paletteList.querySelector('.palette-item.selected')?.scrollIntoView({ block: 'nearest' });
}

function openPalette() {
  palette.returnTo = activePane();
  palette.index = 0;
  el.paletteInput.value = '';
  el.palette.classList.add('open');
  renderPalette();
  el.paletteInput.focus();
}

function closePalette() {
  el.palette.classList.remove('open');
  palette.returnTo?.term.focus();
}

function choosePalette(i) {
  const it = palette.items[i];
  if (!it) return;
  closePalette();
  runCommand(it.command, it.args);
}

function movePalette(delta) {
  if (!palette.items.length) return;
  palette.index = (palette.index + delta + palette.items.length) % palette.items.length;
  renderPalette();
}

el.paletteInput.addEventListener('input', () => {
  palette.index = 0;
  renderPalette();
});

el.paletteInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowDown') movePalette(1);
  else if (ev.key === 'ArrowUp') movePalette(-1);
  else if (ev.key === 'Enter') choosePalette(palette.index);
  else if (ev.key === 'Escape') closePalette();
  else return;
  ev.preventDefault();
});

el.palette.addEventListener('mousedown', (ev) => {
  if (ev.target === el.palette) closePalette();
});

window.addEventListener('focus', () => document.body.classList.add('win-focused'));
window.addEventListener('blur', () => document.body.classList.remove('win-focused'));
if (document.hasFocus()) document.body.classList.add('win-focused');

function inTextField() {
  const t = document.activeElement;
  return t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
}

window.addEventListener('keydown', (ev) => {
  // typing in the search box or palette: only modified keys count as shortcuts
  if (inTextField() && !ev.ctrlKey && !ev.altKey && !ev.metaKey) return;
  const action = matchShortcut(ev);
  if (action) {
    ev.preventDefault();
    ev.stopPropagation();
    action();
  }
});

api.onKeysChanged(({ keys, error }) => {
  if (error) {
    toast(error, { error: true });
    return;
  }
  buildKeymap(keys);
  toast('Keybindings reloaded');
});

// ---------- settings UI ----------

const s = {
  material: document.getElementById('s-material'),
  colorMode: document.getElementById('s-colormode'),
  glassBlur: document.getElementById('s-glass-blur'),
  readability: document.getElementById('s-readability'),
  readabilityVal: document.getElementById('s-readability-val'),
  glassBlurVal: document.getElementById('s-glass-blur-val'),
  contrast: document.getElementById('s-contrast'),
  gpu: document.getElementById('s-gpu'),
  defaultProfile: document.getElementById('s-profile'),
  restoreSession: document.getElementById('s-restore'),
  notifyBlocked: document.getElementById('s-notify-blocked'),
  notifyDone: document.getElementById('s-notify-done'),
  notifySeconds: document.getElementById('s-notify-seconds'),
  notifySecondsVal: document.getElementById('s-notify-seconds-val'),
  autoDetect: document.getElementById('s-autodetect'),
  copyOnSelect: document.getElementById('s-copyonselect'),
  startDir: document.getElementById('s-startdir'),
  editor: document.getElementById('s-editor'),
  tintColor: document.getElementById('s-tint-color'),
  tintAlpha: document.getElementById('s-tint-alpha'),
  tintAlphaVal: document.getElementById('s-tint-alpha-val'),
  accent: document.getElementById('s-accent'),
  fontFamily: document.getElementById('s-font-family'),
  fontSize: document.getElementById('s-font-size'),
  fontSizeVal: document.getElementById('s-font-size-val'),
  lineHeight: document.getElementById('s-line-height'),
  lineHeightVal: document.getElementById('s-line-height-val'),
  padding: document.getElementById('s-padding'),
  paddingVal: document.getElementById('s-padding-val'),
  radius: document.getElementById('s-radius'),
  radiusVal: document.getElementById('s-radius-val'),
  cursorStyle: document.getElementById('s-cursor-style'),
  cursorBlink: document.getElementById('s-cursor-blink')
};

function toggleSettings() {
  el.settings.classList.toggle('open');
  const diag = document.getElementById('diag');
  if (el.settings.classList.contains('open') && diag) {
    const node = state.activeTab ? firstLeaf(state.activeTab.root) : null;
    diag.textContent = node
      ? `diag — renderer: ${node.webgl ? 'webgl' : 'dom'} · unicode: ${node.term.unicode.activeVersion} · ${node.term.cols}x${node.term.rows} · cwd: ${node.cwd || '(none reported)'} · branch: ${node.branch || '-'} · title: ${node.oscTitle || '-'}`
      : 'diag — no terminal';
  }
}

document.getElementById('btn-settings').addEventListener('click', toggleSettings);
document.getElementById('btn-settings-close').addEventListener('click', toggleSettings);
const btnNewTab = document.getElementById('btn-newtab');
btnNewTab.addEventListener('click', () => newTab());
btnNewTab.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  openProfileMenu(btnNewTab);
});
const btnNewTabMenu = document.getElementById('btn-newtab-menu');
btnNewTabMenu.addEventListener('click', () => openProfileMenu(btnNewTabMenu));
document.getElementById('btn-agents').addEventListener('click', () => newAgentTab());

function populateProfileSelect() {
  s.defaultProfile.replaceChildren(
    ...profiles.map((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      return o;
    })
  );
  if (state.theme?.defaultProfile) s.defaultProfile.value = state.theme.defaultProfile;
}
async function populateFontList() {
  const families = await api.fontsList();
  const ctx = document.createElement('canvas').getContext('2d');
  const isMono = (f) => {
    ctx.font = `16px "${f}"`;
    return Math.abs(ctx.measureText('iiiiii').width - ctx.measureText('WWWWWW').width) < 0.5;
  };
  const monos = families.filter(isMono);
  const current = s.fontFamily.value;
  s.fontFamily.replaceChildren(
    ...monos.map((f) => {
      const o = document.createElement('option');
      o.value = f;
      o.textContent = f;
      return o;
    })
  );
  if (current && !monos.includes(current)) {
    const o = document.createElement('option');
    o.value = current;
    o.textContent = current;
    s.fontFamily.prepend(o);
  }
  if (current) s.fontFamily.value = current;
}

document.getElementById('s-startdir-browse').addEventListener('click', async () => {
  const dir = await api.pickDir();
  if (dir) {
    s.startDir.value = dir;
    onSettingChange();
  }
});
document.getElementById('btn-open-theme').addEventListener('click', () => api.themeOpenFile('json'));
document.getElementById('btn-open-css').addEventListener('click', () => api.themeOpenFile('css'));
document.getElementById('btn-open-keys').addEventListener('click', () => api.themeOpenFile('keys'));

function parseTint(tint) {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\)/.exec(tint || '');
  if (!m) return { hex: '#0a0c14', alpha: 0.55 };
  const hex =
    '#' + [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, '0')).join('');
  return { hex, alpha: m[4] !== undefined ? +m[4] : 1 };
}

function hexToRgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

let syncing = false;

function syncSettingsUI() {
  const t = state.theme;
  if (!t) return;
  syncing = true;
  const tint = parseTint(t.tint);
  s.material.value = t.material || 'acrylic';
  s.colorMode.value = t.colorMode || 'dark';
  s.glassBlur.value = t.glassBlur ?? 40;
  s.glassBlurVal.textContent = (t.glassBlur ?? 40) + 'px';
  const readability = Math.round((t.glassReadability ?? 0.3) * 100);
  s.readability.value = readability;
  s.readabilityVal.textContent = readability + '%';
  s.contrast.value = String(t.minContrast ?? 1);
  if (profiles.length) s.defaultProfile.value = t.defaultProfile || profiles[0].id;
  s.gpu.checked = t.gpuRenderer === true;
  s.restoreSession.checked = t.restoreSession !== false;
  const notify = t.notify || {};
  s.notifyBlocked.checked = notify.agentBlocked !== false;
  s.notifyDone.checked = notify.agentDone !== false;
  const secs = notify.commandSeconds ?? 20;
  s.notifySeconds.value = secs;
  s.notifySecondsVal.textContent = secs ? secs + 's' : 'Off';
  s.autoDetect.checked = t.autoDetectAgents !== false;
  s.copyOnSelect.checked = t.copyOnSelect !== false;
  s.startDir.value = t.startDir || '';
  s.editor.value = t.editor || '';
  s.tintColor.value = tint.hex;
  s.tintAlpha.value = Math.round(tint.alpha * 100);
  s.tintAlphaVal.textContent = Math.round(tint.alpha * 100) + '%';
  s.accent.value = t.accent || '#7aa2f7';
  const fam = (t.font?.family || '').split(',')[0].replace(/"/g, '').trim();
  if (fam && ![...s.fontFamily.options].some((o) => o.value === fam)) {
    const o = document.createElement('option');
    o.value = fam;
    o.textContent = fam;
    s.fontFamily.prepend(o);
  }
  s.fontFamily.value = fam;
  s.fontSize.value = t.font?.size || 14;
  s.fontSizeVal.textContent = (t.font?.size || 14) + 'px';
  s.lineHeight.value = t.font?.lineHeight ?? 1.25;
  s.lineHeightVal.textContent = String(t.font?.lineHeight ?? 1.25);
  s.padding.value = t.padding ?? 14;
  s.paddingVal.textContent = (t.padding ?? 14) + 'px';
  s.radius.value = t.cornerRadius ?? 8;
  s.radiusVal.textContent = (t.cornerRadius ?? 8) + 'px';
  s.cursorStyle.value = t.cursor?.style || 'bar';
  s.cursorBlink.checked = t.cursor?.blink !== false;
  syncing = false;
}

const saveTheme = debounce(() => {
  if (state.theme) api.themeSave(state.theme);
}, 200);

function onSettingChange() {
  if (syncing || !state.theme) return;
  const t = state.theme;
  const [r, g, b] = hexToRgb(s.tintColor.value);
  const alpha = (+s.tintAlpha.value / 100).toFixed(2);
  t.material = s.material.value;
  t.colorMode = s.colorMode.value;
  t.glassBlur = +s.glassBlur.value;
  t.glassReadability = +s.readability.value / 100;
  t.minContrast = parseFloat(s.contrast.value);
  if (s.defaultProfile.value) t.defaultProfile = s.defaultProfile.value;
  t.gpuRenderer = s.gpu.checked;
  t.restoreSession = s.restoreSession.checked;
  t.notify = {
    agentBlocked: s.notifyBlocked.checked,
    agentDone: s.notifyDone.checked,
    commandSeconds: +s.notifySeconds.value
  };
  t.autoDetectAgents = s.autoDetect.checked;
  t.copyOnSelect = s.copyOnSelect.checked;
  t.startDir = s.startDir.value.trim();
  t.editor = s.editor.value.trim();
  t.tint = `rgba(${r}, ${g}, ${b}, ${alpha})`;
  t.accent = s.accent.value;
  t.font = t.font || {};
  if (s.fontFamily.value) t.font.family = `"${s.fontFamily.value}", Consolas, monospace`;
  t.font.size = +s.fontSize.value;
  t.font.lineHeight = +s.lineHeight.value;
  t.padding = +s.padding.value;
  t.cornerRadius = +s.radius.value;
  t.cursor = t.cursor || {};
  t.cursor.style = s.cursorStyle.value;
  t.cursor.blink = s.cursorBlink.checked;
  applyTheme(t, undefined);
  saveTheme();
  saveSession(); // toggling restore off clears the stored layout
}

for (const input of Object.values(s)) {
  if (input && input.tagName) {
    input.addEventListener('input', onSettingChange);
    input.addEventListener('change', onSettingChange);
  }
}

// ---------- glass background ----------

function updateGlassPos({ bounds, display }) {
  if (bounds) glassState.bounds = bounds;
  if (display) glassState.display = display;
  const b = glassState.bounds;
  const d = glassState.display;
  if (!b || !d) return;
  // Screen geometry arrives in unzoomed device-independent pixels; a zoomed page
  // measures itself in smaller CSS pixels, so the wallpaper has to be divided
  // down or it drifts out of alignment with the desktop behind the window.
  const z = uiZoom || 1;
  // #glass-bg is inset -80px, so shift the wallpaper by +80 to stay screen-aligned
  el.glassBg.style.backgroundSize = `${d.width / z}px ${d.height / z}px`;
  el.glassBg.style.backgroundPosition = `${(d.x - b.x) / z + 80}px ${(d.y - b.y) / z + 80}px`;
}

async function initGlass() {
  const info = await api.glassInfo();
  if (!info.wallpaper) {
    toast('Glass mode: could not read wallpaper — tint only');
    return;
  }
  el.glassBg.style.backgroundImage = `url("${info.wallpaper}")`;
  updateGlassPos(info);
  api.onWinBounds(updateGlassPos);
}

api.onZoom(({ factor }) => {
  uiZoom = factor || 1;
  // the wallpaper has no observer to refit it, and the glyph atlas is stale the
  // instant the zoom lands — the pixel ratio it was drawn for no longer applies
  updateGlassPos({});
  resharpen();
});

// ---------- pty events ----------

api.onPtyData(({ id, data }) => {
  panesByPty.get(id)?.term.write(data);
});

api.onPtyExit(({ id }) => {
  const agent = agentsByPty.get(id);
  if (agent) {
    agentsByPty.delete(id);
    globalAgents.delete(agent.id);
    for (const tab of agentTabs()) {
      if (tab.selected === agent.id) tab.selected = null;
      if (tab.diffKey === 'agent:' + agent.id) tab.diffKey = null;
    }
    renderAgentLists();
    refreshWorktrees();
  }
  const node = panesByPty.get(id);
  if (!node) return;
  // panes hosted in an agent-tab center stay as frozen output; others close
  const inAgentCenter = agentTabs().some((t) => t.centerLeaves.has(node));
  if (inAgentCenter) return;
  panesByPty.delete(id);
  removePane(node, { killPty: false });
});

api.onThemeChanged(async ({ theme, css, error }) => {
  if (error) {
    toast(error, { error: true });
    return;
  }
  // profiles live in theme.json, so an edit there can add/remove shells
  profiles = await api.profilesList();
  applyTheme(theme, css);
  populateProfileSelect();
});

// ---------- boot ----------

document.getElementById('btn-min').addEventListener('click', () => api.winMinimize());
document.getElementById('btn-max').addEventListener('click', () => api.winMaximize());
document.getElementById('btn-close').addEventListener('click', () => api.winClose());

(async () => {
  const { theme, css, frameless, home, openDir } = await api.themeGet();
  state.home = home || null;
  glassState.active = Boolean(frameless);
  if (frameless) {
    document.body.classList.add('frameless');
    await initGlass();
  }
  profiles = await api.profilesList();
  bootFontSize = theme.font?.size || 14; // what Ctrl+0 returns to
  buildKeymap(await api.keysGet());
  applyTheme(theme, css);
  populateProfileSelect();
  populateFontList();

  // Wait for the terminal font before opening the first terminal — opening
  // with a fallback font bakes wrong glyph metrics into the renderer atlas
  // (garbled emoji/status lines until a manual renderer reset).
  try {
    await document.fonts.load(`${theme.font?.size || 14}px ${theme.font?.family || 'monospace'}`);
    await document.fonts.ready;
  } catch {}

  // launched as `frost <dir>` or from "Open Frost here": that directory is the
  // whole point of the launch, so it wins over the saved layout
  if (openDir) {
    await newTab({ cwd: openDir });
  } else {
    const session = theme.restoreSession === false ? null : await api.sessionGet();
    const restored = session?.tabs?.length ? await restoreTabs(session) : false;
    if (!restored) await newTab();
  }

  api.onOpenDir((dir) => newTab({ cwd: dir }));

  // Belt and braces: one atlas rebuild after boot in case a font swapped late
  setTimeout(() => {
    for (const node of panesByPty.values()) {
      try {
        node.webgl?.clearTextureAtlas();
        node.term.refresh(0, node.term.rows - 1);
      } catch {}
    }
  }, 1500);

  // Write renderer diagnostics to config/diag.json (debugging aid)
  setTimeout(() => {
    try {
      const node = state.activeTab ? firstLeaf(state.activeTab.root) : null;
      const report = {
        when: new Date().toISOString(),
        unicodeActive: node ? node.term.unicode.activeVersion : null,
        unicodeRegistered: node ? node.term.unicode.versions : null,
        unicodeError: window.__unicodeError || null,
        renderer: node ? (node.webgl ? 'webgl' : 'dom') : null,
        cols: node?.term.cols,
        rows: node?.term.rows,
        themeUnicodeVersion: state.theme?.unicodeVersion || null,
        wideTest: null
      };

      // probe: write "🚦 X" into a hidden terminal, inspect cell layout
      const probe = new Terminal({ allowProposedApi: true });
      try {
        probe.loadAddon(new Unicode11Addon.Unicode11Addon());
        probe.unicode.activeVersion = state.theme?.unicodeVersion || '11';
      } catch (e) {
        report.probeUnicodeError = String(e);
      }
      const div = document.createElement('div');
      div.style.cssText = 'position:absolute;left:-9999px;top:0;width:400px;height:120px;';
      document.body.appendChild(div);
      probe.open(div);
      probe.write('\u{1F6A6} X', () => {
        const line = probe.buffer.active.getLine(0);
        const cells = [];
        for (let i = 0; i < 6; i++) {
          const c = line.getCell(i);
          cells.push({ i, ch: c ? c.getChars() : null, w: c ? c.getWidth() : null });
        }
        report.wideTest = cells;
        api.diagReport(report);
        probe.dispose();
        div.remove();
      });
    } catch (e) {
      api.diagReport({ diagError: String(e) });
    }
  }, 2500);
})();
