/* global Terminal, FitAddon, WebLinksAddon, WebglAddon, Unicode11Addon, SearchAddon, SerializeAddon */

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
  navigator.clipboard.readText().then((text) => {
    if (!text) return;
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
