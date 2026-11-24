const fs = require('fs');

const { AGENTS_FILE, CONFIG_DIR, CSS_FILE, KEYS_FILE, THEME_FILE } = require('../env');
const { detectProfiles } = require('../platform');

// Only overrides live in this file; the defaults stay in code so new versions
// can add keys without rewriting a file the user owns. Ctrl+Shift+P lists every
// command with its current key.
const DEFAULT_KEYS = {
  _help: [
    'Overrides for Frost built-in keys. Each entry: { "keys": "ctrl+shift+t", "command": "tab.new" }.',
    'Same "keys" as a built-in replaces it; "command": null unbinds it.',
    'Optional "args", e.g. { "keys": "ctrl+1", "command": "tab.go", "args": { "index": 1 } }.',
    'Keys are physical positions, so they behave the same on every layout.',
    'Press Ctrl+Shift+P for the command list.'
  ].join(' '),
  bindings: []
};

const DEFAULT_THEME = {
  // The look of everything around the terminal: 'frost', 'liquid', 'aurora',
  // 'graphite', 'terminal' or 'candy'. Pure CSS (src/renderer/designs/), so it switches live.
  design: 'frost',
  material: 'glass',
  colorMode: 'dark',
  glassBlur: 33,
  // Floor on how much the glass backdrop is darkened behind text. Tint alone is
  // a look; this is legibility, and a wallpaper can be arbitrarily bright.
  glassReadability: 0.3,
  // Off. It exists for palettes built for an opaque black background, and it
  // pays for legibility by dragging every colour towards the foreground: a
  // PowerShell error came out pastel pink rather than red. The palette below is
  // chosen to be readable over glass on its own, so nothing has to be recoloured.
  minContrast: 1,
  // Off by default, which is the opposite of what a terminal usually wants. The
  // GPU renderer rasterises each glyph once into a texture atlas and blends it
  // over whatever is behind the window; every pane in Frost is transparent, so
  // that blend is grayscale antialiasing against an unknown backdrop and the
  // text comes out gritty. The DOM renderer hands the text to the browser, which
  // hints and gamma-corrects it the way the rest of Windows does, and the
  // difference is plain at a glance. The toggle stays for anyone whose work is
  // firehose output rather than reading.
  // macOS draws all its text with greyscale antialiasing anyway, so on a Mac
  // the two look the same and the faster one is the default.
  gpuRenderer: process.platform === 'darwin',
  autoDetectAgents: true,
  // Off, like every other Windows terminal: a shell that comes back with
  // yesterday's tabs in it is a surprise, and the tabs it restores are empty
  // shells in the right directories rather than the work that was in them.
  restoreSession: false,
  // Off for the same reason: letters that freeze and shatter are a look to
  // choose, not one to find a terminal already wearing.
  typingGlow: false,
  notify: { agentBlocked: true, agentDone: true, commandSeconds: 20 },
  // check: look for a newer release at startup and every six hours. download:
  // fetch it when one is found. Either way the installer only runs when Frost
  // quits, or when you ask for it in settings.
  update: { check: true, download: true },
  agentLayout: { rail: 210, diff: 340 },
  copyOnSelect: true,
  // Text with line breaks in it is typed into the shell as typed input, and a
  // line ending in a newline runs. The clipboard is not always the user's own
  // writing, so the paste is confirmed once rather than trusted silently.
  // warnInAgent is off: inside a claude session a wall of logs is ordinary
  // input, nothing runs on arrival, and a prompt answered by reflex guards
  // nothing.
  paste: { warnMultiline: true, warnInAgent: false },
  unicodeVersion: '11',
  tint: 'rgba(0, 0, 0, 0.00)',
  accent: '#80a8ff',
  padding: 14,
  cornerRadius: 13,
  font: {
    family: '"Cascadia Mono", Consolas, monospace',
    // 16px, not 14. Windows Terminal's font size is in points and its default is
    // 12pt — 16px — so a terminal that says 14 looks smaller than the one people
    // compare it against, for no reason they can name.
    size: 16,
    lineHeight: 1.15,
    // Below normal, which is not what a transparent window suggests. Composited
    // text is antialiased in grayscale rather than with ClearType, and against a
    // white foreground over a photograph those soft edges read as extra mass
    // rather than as softness — 400 looks fat here where it looks ordinary on an
    // opaque terminal. 350 is Cascadia's variable axis interpolating genuinely
    // lighter (the axis runs 200–700), so the strokes thin without losing a pixel
    // anywhere, and bold at 700 is still bold.
    weight: 350,
    // On, and free where there is nothing to do: the renderer asks the font
    // whether it draws => as one glyph before changing anything, so the default
    // font here — Cascadia Mono, which has no ligatures, that being its whole
    // difference from Cascadia Code — is rendered exactly as it was. Pick a font
    // that has them and they appear without a setting to find.
    ligatures: true
  },
  cursor: { style: 'bar', blink: true },
  // smoothMs: 0 restores xterm's instant row-at-a-time scroll. lines is rows per
  // wheel notch, fastLines the same while Shift is held.
  scroll: { smoothMs: 90, lines: 3, fastLines: 10 },
  // Lines kept after they scroll off the top, per pane. What is not kept cannot
  // be scrolled to and cannot be found by search — it is gone rather than
  // hidden — and it is memory, so the renderer holds this to 1,000–200,000.
  scrollback: 10000,
  // Not Campbell. Windows Terminal's palette assumes an opaque black background,
  // and half of it — red, blue, magenta — is too dark to read through a window
  // that shows the wallpaper behind it. Nor is it a muted designer scheme: those
  // are tuned against one fixed background, and what reads as tasteful on it
  // reads as washed out over a photograph. Every colour here is near-full
  // saturation and kept bright enough to hold its own against a light
  // wallpaper — vivid first, and recognisably the colour it is named after.
  terminal: {
    // White, not the palette's blue-tinted white. Glass shows the wallpaper
    // through the text's own antialiasing, so a foreground that is 92% bright
    // and slightly blue reads as grey next to an opaque terminal's white.
    foreground: '#ffffff',
    cursor: '#ffffff',
    selectionBackground: 'rgba(255, 255, 255, 0.30)',
    black: '#12141f',
    red: '#ff3b4e',
    green: '#20e070',
    yellow: '#ffc21f',
    blue: '#3d97ff',
    magenta: '#f04bff',
    cyan: '#12dcf0',
    white: '#e4ebff',
    brightBlack: '#8d97c4',
    brightRed: '#ff6b78',
    brightGreen: '#4dff96',
    brightYellow: '#ffdc4d',
    brightBlue: '#6fb6ff',
    brightMagenta: '#ff7dff',
    brightCyan: '#5cf2ff',
    brightWhite: '#ffffff'
  }
};

function ensureConfig() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(THEME_FILE)) {
    fs.writeFileSync(THEME_FILE, JSON.stringify(DEFAULT_THEME, null, 2));
  }
  // fill in shell profiles for configs written before profiles existed
  const t = readTheme();
  if (t && (!Array.isArray(t.profiles) || !t.profiles.length)) {
    t.profiles = detectProfiles();
    t.defaultProfile = t.defaultProfile || t.profiles[0].id;
    fs.writeFileSync(THEME_FILE, JSON.stringify(t, null, 2));
  }
  if (!fs.existsSync(AGENTS_FILE)) {
    fs.writeFileSync(AGENTS_FILE, JSON.stringify({ spaces: [] }, null, 2));
  }
  if (!fs.existsSync(KEYS_FILE)) {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(DEFAULT_KEYS, null, 2));
  }
  if (!fs.existsSync(CSS_FILE)) {
    fs.writeFileSync(
      CSS_FILE,
      [
        '/* theme.css — raw CSS injected into the terminal window. Hot-reloads on save. */',
        '/* Anything goes: override CSS variables, restyle tabs, add animations...   */',
        '/* Examples:                                                                */',
        '/*   :root { --tint: rgba(40, 0, 60, 0.4); }                                */',
        '/*   .tab.active { box-shadow: 0 0 12px var(--accent); }                    */',
        ''
      ].join('\n')
    );
  }
}

function readTheme() {
  try {
    return JSON.parse(fs.readFileSync(THEME_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function readCss() {
  try {
    return fs.readFileSync(CSS_FILE, 'utf8');
  } catch {
    return '';
  }
}

function readKeys() {
  try {
    const k = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    return Array.isArray(k.bindings) ? k.bindings : [];
  } catch {
    return null; // invalid JSON — caller keeps whatever is loaded
  }
}

function readAgentsCfg() {
  try {
    return JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
  } catch {
    return { spaces: [] };
  }
}

Object.assign(module.exports, {
  DEFAULT_KEYS,
  DEFAULT_THEME,
  ensureConfig,
  readTheme,
  readCss,
  readKeys,
  readAgentsCfg
});
