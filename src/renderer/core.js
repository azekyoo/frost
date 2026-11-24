/* global Terminal, FitAddon, WebLinksAddon, WebglAddon, Unicode11Addon, SearchAddon, SerializeAddon */

// The few labels and styles that differ by OS. osText takes the Windows wording
// first, so Windows shows exactly what it always has.
const IS_MAC = window.api.platform === 'darwin';
const osText = (win, mac) => (IS_MAC ? mac : win);
// The modifier for Frost's own shortcuts and Ctrl+click: Ctrl on Windows, Cmd
// on a Mac, where Ctrl belongs to the shell (Ctrl+C must always interrupt).
const modKey = (ev) => (IS_MAC ? ev.metaKey : ev.ctrlKey);
// A binding ('meta+shift+t') the way a Mac menu writes it (⌘⇧T).
const MAC_MODS = { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' };
const macKeys = (k) =>
  k.split('+').map((p) => MAC_MODS[p] || (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1))).join('');
// A shortcut label written the Windows way, said the Mac way.
const keyText = (s) => (IS_MAC ? s.replace(/Ctrl\+/g, 'Cmd+').replace(/Alt\+/g, 'Option+') : s);
if (IS_MAC) {
  document.body.classList.add('mac');
  // index.html carries the macOS wording beside the Windows one: data-mac
  // replaces an element's content, data-mac-title / data-mac-placeholder those
  // attributes, data-mac-keys only rewrites the shortcuts in it, and
  // data-win-only marks what has no meaning on a Mac (an option is removed, so
  // it can't be picked; anything else is hidden, so scripts still find it).
  for (const n of document.querySelectorAll('[data-mac]')) n.innerHTML = n.dataset.mac;
  for (const n of document.querySelectorAll('[data-mac-placeholder]')) n.placeholder = n.dataset.macPlaceholder;
  for (const n of document.querySelectorAll('[data-mac-title]')) n.title = n.dataset.macTitle;
  for (const n of document.querySelectorAll('[data-mac-keys]')) n.innerHTML = keyText(n.innerHTML);
  for (const n of document.querySelectorAll('[data-win-only]')) {
    if (n.tagName === 'OPTION') n.remove();
    else n.style.display = 'none';
  }
  window.api.onFullScreen((on) => document.body.classList.toggle('fullscreen', on));
}

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
  tabMenu: document.getElementById('tab-menu'),
  palette: document.getElementById('palette'),
  paletteInput: document.getElementById('palette-input'),
  paletteList: document.getElementById('palette-list'),
  customCss: document.getElementById('custom-css')
};

// A list rebuilt from scratch (the agent rail redraws on every status tick)
// still moves smoothly: rows are matched across the rebuild by key, any glide
// a row was in the middle of carries on, a row whose place changed slides
// there from where it showed, and a row new to the list drifts in. Rows that
// left simply leave, the ones below closing the gap.
const LIST_MOTION_MS = 180;

function flipList(list, keyOf, change) {
  const prior = new Map();
  for (const r of list.children) {
    const k = keyOf(r);
    if (!k) continue;
    const t = getComputedStyle(r).transform;
    const shift = t && t !== 'none' ? new DOMMatrixReadOnly(t).m42 : 0;
    const top = r.getBoundingClientRect().top;
    prior.set(k, {
      shown: top,
      laid: top - shift,
      anims: r
        .getAnimations()
        .filter((a) => a.id?.startsWith('motion-') && a.playState === 'running')
        .map((a) => ({ id: a.id, frames: a.effect.getKeyframes(), timing: a.effect.getTiming(), at: a.currentTime }))
    });
  }
  const painted = list.motionPainted;
  change();
  list.motionPainted = true;
  if (reduceMotion.matches || !painted) return;
  const rows = [...list.children].filter(keyOf).map((r) => [r, r.getBoundingClientRect().top]);
  for (const [r, top] of rows) {
    const p = prior.get(keyOf(r));
    if (!p) {
      r.animate([{ opacity: 0, transform: 'translateX(-10px)' }, { opacity: 1, transform: 'none' }], {
        duration: LIST_MOTION_MS,
        easing: MOTION_EASE
      }).id = 'motion-list-in';
      continue;
    }
    if (Math.abs(p.laid - top) >= 0.5) {
      r.animate([{ transform: `translateY(${p.shown - top}px)` }, { transform: 'none' }], {
        duration: LIST_MOTION_MS,
        easing: MOTION_EASE
      }).id = 'motion-list-move';
      continue;
    }
    for (const s of p.anims) {
      const a = r.animate(s.frames, s.timing);
      a.id = s.id;
      a.currentTime = s.at;
    }
  }
}

// ---------- helpers ----------

// A floating surface (menu, palette, Peek, a question) loses 'open' at once —
// as far as the code is concerned it is closed — but stays drawn under
// 'closing' while it plays its exit. Opening it again simply wins.
function closeSurface(node, after) {
  if (!node.classList.contains('open')) return;
  node.classList.remove('open');
  if (reduceMotion.matches) return after?.();
  node.classList.add('closing');
  let done = false;
  const end = (ev) => {
    if (done || (ev && ev.target !== node)) return;
    done = true;
    node.removeEventListener('animationend', end);
    node.classList.remove('closing');
    if (!node.classList.contains('open')) after?.();
  };
  node.addEventListener('animationend', end);
  setTimeout(end, 400); // in case the animation never runs (hidden window, a design without one)
}

// ---------- motion ----------
// Layout changes (a tab opening or closing, a pane splitting) play as a short
// glide instead of a jump, so the eye can follow what moved. All of it is off
// when the system asks for reduced motion.
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const MOTION_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

// Parts of the UI are rebuilt from scratch on every repaint (the tab strip is
// repainted whenever a title changes, which a busy shell does constantly). A
// glide running on the old node would be cut off, so it is replayed on its
// replacement from the same point.
function carryAnimations(from, to) {
  for (const a of from.getAnimations()) {
    if (!a.id?.startsWith('motion-') || a.playState !== 'running') continue;
    const b = to.animate(a.effect.getKeyframes(), a.effect.getTiming());
    b.id = a.id;
    b.currentTime = a.currentTime;
  }
  // the clip that hides a half-grown tab's insides has to come along too
  if (from.classList.contains('motion-clip') && !to.classList.contains('motion-clip')) {
    to.classList.add('motion-clip');
    Promise.all(to.getAnimations().map((x) => x.finished)).then(
      () => to.classList.remove('motion-clip'),
      () => {}
    );
  }
}


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
  // onClick: what a click does before dismissing, with clickTitle as its hover text
  const {
    error: isError = false,
    ms,
    onClick = null,
    clickTitle = ''
  } = typeof opts === 'number' ? { ms: opts } : opts || {};
  const node = document.createElement('div');
  node.className = 'toast' + (isError ? ' error' : '');
  node.textContent = text;
  node.title = onClick ? clickTitle || 'Click to open' : 'Click to dismiss';

  const dismiss = () => {
    if (!node.isConnected) return;
    node.classList.remove('show');
    setTimeout(() => node.remove(), 200);
  };
  node.addEventListener('click', () => {
    if (onClick) onClick();
    dismiss();
  });
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
// pastes don't execute line-by-line in the shell — where the shell supports it.
// PowerShell and bash do; a program reading raw input may not, and neither does
// a shell in the middle of a here-doc, which is why the warning below exists at
// all rather than being made redundant by bracketed paste.

// A newline in pasted text is a command the shell may run the instant it
// arrives, and clipboards are picked up from web pages, chat and other people's
// terminals. This is the one place Frost can put a step between "what I think I
// copied" and "what runs", so it does — an answer nobody reads is still cheaper
// than a command nobody meant.
function pasteWarningFor(text, theme, node) {
  if (theme?.paste?.warnMultiline === false) return null;
  // A claude session is the case the warning was never for: many lines of logs,
  // a stack trace or a diff is ordinary input there, it goes into a prompt box
  // rather than to a shell, and nothing runs until the agent is told to run it.
  // Asking every time trained the answer, which is how a guard stops working.
  if (theme?.paste?.warnInAgent !== true && agentsByPty.has(node?.ptyId)) return null;
  const lines = String(text).split(/\r\n|\r|\n/);
  // A single trailing newline still means "and press Enter", so it counts
  if (lines.length < 2) return null;
  const real = lines.filter((l) => l.trim().length > 0);
  const first = (real[0] || '').trim();
  return {
    count: real.length,
    // Enough of the first line to recognise the paste by, and no more: the
    // clipboard may hold something the person would rather not see printed on a
    // shared screen, and the modal is not a viewer.
    preview: first.length > 70 ? first.slice(0, 70) + '…' : first
  };
}

function pasteInto(node) {
  const term = node.term;
  navigator.clipboard.readText().then(async (text) => {
    if (!text) {
      // A screenshot on the clipboard has no text at all, and a terminal cannot
      // be handed pixels. Writing it to a file and typing that path is the only
      // paste it can do — and the one an agent in the pane can act on.
      const file = await api.imageFromClipboard();
      if (file) typeInto(node, quotePath(file));
      return;
    }
    const warn = pasteWarningFor(text, state.theme, node);
    if (!warn) {
      term.paste(text);
      return;
    }
    askModal(
      {
        title: `Paste ${warn.count} lines?`,
        detail:
          'Pasted text with line breaks in it is typed into the shell as if you had typed it, and any line that ends in a newline runs. Check it is what you meant to copy.',
        note: warn.preview ? `First line: ${warn.preview}` : '',
        confirmLabel: 'Paste',
        cancelLabel: 'Cancel'
      },
      () => {
        term.paste(text);
        term.focus();
      }
    );
  });
}

// GPU (WebGL) renderer: enables customGlyphs box-drawing and faster rendering.
// Falls back to the DOM renderer if WebGL is unavailable.
//
// Each WebGL pane owns a whole GL context in the GPU process: its own canvas,
// glyph atlas and buffers. Handing one to every shell, hidden tabs and spare
// shells included, put a dozen contexts in the GPU process and made typing lag,
// against a Chromium ceiling of about sixteen. So a pane holds a context only
// while it is on screen, plus a couple of recently hidden ones, so flipping
// between tabs comes back already drawn rather than rebuilding the atlas.
const GPU_HIDDEN_KEEP = 2;
const gpuPanes = new Map(); // pane element -> node, for the observer below

const gpuWatch = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const node = gpuPanes.get(e.target);
    if (!node) continue;
    node.onScreen = e.isIntersecting;
    if (!node.onScreen) node.hiddenAt = Date.now();
    applyGpu(node);
  }
  trimHiddenGpu();
});

// Called once per pane: from then on its context follows its visibility. The
// addon is never used as an addon; xterm disposes it with the terminal, which
// is the one place every way of closing a pane goes through.
function watchGpu(node) {
  node.onScreen = false;
  gpuPanes.set(node.el, node);
  gpuWatch.observe(node.el);
  node.term.loadAddon({
    activate() {},
    dispose() {
      gpuWatch.unobserve(node.el);
      gpuPanes.delete(node.el);
    }
  });
}

// The observer only reports a pane coming into view after that frame has been
// painted, so a pane switched to would flash one frame from the DOM renderer
// before the GPU one took over. Whatever shows a pane calls this right after,
// and the context is there for the very first frame.
function gpuShowWithin(root) {
  if (state.theme?.gpuRenderer !== true || !root) return;
  for (const [el, node] of gpuPanes) {
    // offsetParent is null under display:none, which is how hidden panes hide
    if (!root.contains(el) || el.offsetParent === null) continue;
    node.onScreen = true;
    applyGpu(node);
    drawNow(node);
  }
  trimHiddenGpu();
}

// xterm pauses a terminal that is out of the page and only resumes on its own
// IntersectionObserver, which, like ours, reports after the frame is painted.
// A WebGL canvas made while paused is blank until then: one empty frame, the
// blink on a tab shown for the first time. Resume it and draw once, now. These
// are xterm internals (kept by its build, see tools/patch-xterm-alpha.js for
// another reach-in); if a version renames them this does nothing, and the
// observer still catches up a frame later.
function drawNow(node) {
  const rs = node.term?._core?._renderService;
  if (!rs || typeof rs._handleIntersectionChange !== 'function' || typeof rs._renderRows !== 'function') return;
  try {
    rs._handleIntersectionChange({ isIntersecting: true, intersectionRatio: 1 });
    rs._renderRows(0, node.term.rows - 1);
  } catch {}
}

// Hidden panes past the newest few give their context back.
function trimHiddenGpu() {
  const hidden = [...gpuPanes.values()]
    .filter((n) => n.webgl && !n.onScreen)
    .sort((a, b) => b.hiddenAt - a.hiddenAt);
  for (const node of hidden.slice(GPU_HIDDEN_KEEP)) dropGpu(node);
}

function dropGpu(node) {
  try {
    node.webgl?.dispose();
  } catch {}
  node.webgl = null;
}

function applyGpu(node) {
  // opt-in, not opt-out: see the note on gpuRenderer in the default theme.
  // A pane going off screen keeps what it has; trimHiddenGpu decides that.
  const want = state.theme?.gpuRenderer === true && (node.onScreen || !!node.webgl);
  if (want && !node.webgl) {
    try {
      node.webgl = new WebglAddon.WebglAddon();
      node.webgl.onContextLoss(() => dropGpu(node));
      node.term.loadAddon(node.webgl);
    } catch {
      node.webgl = null;
    }
  } else if (!want && node.webgl) {
    dropGpu(node);
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

// How much of what has scrolled off the top is kept. It is memory, and wide
// output is roughly a kilobyte a line, so the range is bounded rather than
// unlimited: a million lines would be a gigabyte per pane with nothing on screen
// to suggest where it went.
const SCROLLBACK_MIN = 1000;
const SCROLLBACK_MAX = 200000;

function scrollbackFor(theme) {
  const asked = Number(theme?.scrollback);
  if (!Number.isFinite(asked)) return 10000;
  return Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, Math.round(asked)));
}

// The designs Settings offers, in the order it shows them; 'frost' is the
// default and the only one without a stylesheet of its own.
const DESIGNS = ['frost', 'liquid', 'aurora', 'graphite', 'terminal', 'candy'];

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
  // Keyed to how the window was actually created, not to the material that has
  // been picked. A frameless transparent window has to paint its own backdrop
  // whatever the setting says — dropping it the moment another material is
  // chosen just exposes a see-through window and makes the change look applied
  // when nothing has been applied at all.
  document.body.classList.toggle('glass', glassState.active);
  // Frost is the stylesheet itself; any other design is a layer over it, keyed
  // to this attribute, so a switch is instant and needs nothing rebuilt.
  const design = DESIGNS.includes(theme.design) ? theme.design : 'frost';
  if (design === 'frost') delete document.body.dataset.design;
  else document.body.dataset.design = design;
  // Each of the other designs keeps an accent of its own, unset until picked:
  // set on the body, it sits over the design's signature colour, and taking it
  // away falls straight back to that. Frost's is theme.accent, on the root.
  const own = design === 'frost' ? null : theme.accents?.[design];
  if (/^#[0-9a-f]{6}$/i.test(own || '')) {
    document.body.style.setProperty('--accent', own);
    document.body.dataset.customAccent = '';
  } else {
    document.body.style.removeProperty('--accent');
    delete document.body.dataset.customAccent;
  }
  if (typeof css === 'string') el.customCss.textContent = css;

  for (const node of panesByPty.values()) {
    const term = node.term;
    term.options.fontFamily = theme.font?.family || 'Consolas, monospace';
    term.options.fontSize = theme.font?.size || 16;
    term.options.lineHeight = theme.font?.lineHeight || 1.15;
    term.options.fontWeight = theme.font?.weight ?? 350;
    term.options.fontWeightBold = theme.font?.weightBold ?? 'bold';
    term.options.cursorStyle = theme.cursor?.style || 'bar';
    term.options.cursorBlink = theme.cursor?.blink !== false;
    term.options.minimumContrastRatio = theme.minContrast ?? 1;
    term.options.smoothScrollDuration = theme.scroll?.smoothMs ?? 90;
    term.options.scrollSensitivity = theme.scroll?.lines ?? 3;
    term.options.fastScrollSensitivity = theme.scroll?.fastLines ?? 10;
    // Live: xterm keeps what it already holds when the limit grows, and drops
    // the oldest when it shrinks, so this needs no new pane and no restart
    term.options.scrollback = scrollbackFor(theme);
    applyLigatures(node, theme.font?.ligatures !== false);
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
