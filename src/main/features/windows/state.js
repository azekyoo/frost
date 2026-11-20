const { ipcMain, screen } = require('electron');
const fs = require('fs');

const { DEFAULT_THEME, readTheme } = require('../config');
const { SHOT, TITLEBAR_H, WINDOW_FILE } = require('../../env');
const { displayKeyOf } = require('./zoom');
const { liveWindows, windowOf } = require('./registry');

// ---------- window + session state ----------
// window.json is written continuously rather than on close, so a crash or a
// kill still leaves the last layout on disk.

const sessionLayouts = new Map(); // frostId -> { tabs, activeTab } as reported
const lastBounds = new Map(); // frostId -> bounds, for windows that are minimised
const pendingLayouts = new Map(); // frostId -> the layout a new window should restore
// Closing three windows one at a time is how a person leaves; closing one and
// carrying on with the other two is a decision to have one window fewer. The
// difference is only visible in the timing, so a closed window's entry is kept
// for a while: long enough to cover the last few clicks of leaving, short
// enough that a window closed and forgotten about does not come back tomorrow.
const CLOSE_GRACE_MS = SHOT?.closeGraceMs ?? 20000;
const recentlyClosed = new Map(); // frostId -> { at, entry }, pruned on write

// Every shell in a moved tab's saved tree, however deeply it is split
function ptyIdsOf(node) {
  if (!node) return [];
  if (node.t === 'split') return (node.children || []).flatMap(ptyIdsOf);
  return node.ptyId ? [node.ptyId] : [];
}
let sessionTimer = null;
let quitting = false;
const isQuitting = () => quitting;
const markQuitting = () => {
  quitting = true;
};

// window.json holds one entry per window. Files written before that was true had
// a single window's fields at the top level, so they're read as one window.
function readWindowState() {
  try {
    const raw = JSON.parse(fs.readFileSync(WINDOW_FILE, 'utf8'));
    if (Array.isArray(raw.windows)) return raw.windows;
    return raw.tabs || raw.bounds ? [raw] : [];
  } catch {
    return [];
  }
}

// Reject bounds that no longer land on a monitor — an unplugged second screen
// would otherwise park the window somewhere unreachable.
function boundsVisible(b) {
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.width)) return false;
  return screen.getAllDisplays().some(({ workArea: w }) => {
    return (
      b.x < w.x + w.width - 40 &&
      b.x + b.width > w.x + 40 &&
      b.y < w.y + w.height - 40 &&
      b.y + b.height > w.y + 40
    );
  });
}

// A window size is only meaningful next to the screen it was chosen on: two
// thirds of a laptop panel is a third of a 4K one, and restoring the rectangle
// verbatim onto a different monitor produces a window nobody asked for. The
// saved geometry therefore carries the work area it was measured against, and
// is re-proportioned when it comes back to a screen of another size.
function scaleBoundsTo(b, from, to) {
  if (!b || !from || !from.width || !from.height) return null;
  const fw = Math.min(1, b.width / from.width);
  const fh = Math.min(1, b.height / from.height);
  const width = Math.max(480, Math.round(to.width * fw));
  const height = Math.max(300, Math.round(to.height * fh));
  const fx = Math.min(Math.max((b.x - from.x) / from.width, 0), 1);
  const fy = Math.min(Math.max((b.y - from.y) / from.height, 0), 1);
  return {
    width,
    height,
    x: Math.max(to.x, Math.min(Math.round(to.x + fx * to.width), to.x + to.width - width)),
    y: Math.max(to.y, Math.min(Math.round(to.y + fy * to.height), to.y + to.height - height))
  };
}

// A window with nothing to restore is sized the way Windows Terminal sizes its
// own: 120 columns by 30 rows. A share of the display was the other candidate,
// and it makes a terminal that is two thirds of a 4K monitor wide for no reason
// anyone asked for. Frost's default font is Windows Terminal's default font at
// its default size, so the same grid lands on the same window.
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

function defaultBoundsFor(display) {
  const theme = readTheme() || DEFAULT_THEME;
  const font = theme.font || DEFAULT_THEME.font;
  const size = Number(font.size) > 0 ? Number(font.size) : DEFAULT_THEME.font.size;
  const lineHeight =
    Number(font.lineHeight) > 0 ? Number(font.lineHeight) : DEFAULT_THEME.font.lineHeight;
  const pad = Number.isFinite(theme.padding) ? theme.padding : DEFAULT_THEME.padding;
  // 0.6em is the advance width of Cascadia Mono and of the faces Windows falls
  // back to. The real cell is only known once the renderer has measured the
  // font, so this is close rather than exact — a couple of columns either way.
  const wa = display.workArea;
  const width = Math.min(wa.width, Math.round(DEFAULT_COLS * size * 0.6 + pad * 2));
  const height = Math.min(
    wa.height,
    Math.round(DEFAULT_ROWS * size * lineHeight + pad * 2) + TITLEBAR_H
  );
  return {
    width,
    height,
    x: wa.x + Math.round((wa.width - width) / 2),
    y: wa.y + Math.round((wa.height - height) / 2)
  };
}

const cursorDisplay = () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

// Everything worth writing down about one window, measured now.
function windowEntry(w) {
  // A minimised window reports nonsense bounds, so keep the last real ones.
  if (!w.isMinimized()) {
    const d = screen.getDisplayMatching(w.getBounds());
    lastBounds.set(w.frostId, {
      bounds: w.getNormalBounds(),
      maximized: w.isMaximized(),
      display: { key: displayKeyOf(d), workArea: d.workArea }
    });
  }
  const geometry = lastBounds.get(w.frostId) || {};
  return { ...geometry, ...(sessionLayouts.get(w.frostId) || { tabs: [], activeTab: 0 }) };
}

function flushWindowState() {
  clearTimeout(sessionTimer);
  sessionTimer = null;
  const now = Date.now();
  for (const [id, rec] of recentlyClosed) {
    if (now - rec.at > CLOSE_GRACE_MS) recentlyClosed.delete(id);
  }
  // A window in the middle of closing is still live, and its entry was taken
  // when the close began — the one in hand is the better of the two.
  const entries = [
    ...liveWindows()
      .filter((w) => !recentlyClosed.has(w.frostId))
      .map((w) => ({ seq: w.frostId, entry: windowEntry(w) })),
    ...[...recentlyClosed].map(([id, rec]) => ({ seq: id, entry: rec.entry }))
  ].sort((a, b) => a.seq - b.seq);
  // Nothing left to describe: an empty file would throw away the layout we're
  // trying to preserve.
  if (!entries.length) return;
  const windows = entries.map((e) => e.entry);
  try {
    fs.writeFileSync(WINDOW_FILE, JSON.stringify({ windows }, null, 2));
  } catch {}
}

function saveWindowStateSoon() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(flushWindowState, 500);
}

ipcMain.handle('session:get', (event) => {
  const w = windowOf(event);
  const mine = w && pendingLayouts.get(w.frostId);
  if (w) pendingLayouts.delete(w.frostId); // restored once, not on every reload
  return { tabs: mine?.tabs || [], activeTab: mine?.activeTab || 0 };
});

ipcMain.on('session:layout', (event, layout) => {
  const w = windowOf(event);
  if (!w) return;
  if (layout && Array.isArray(layout.tabs)) sessionLayouts.set(w.frostId, layout);
  else sessionLayouts.delete(w.frostId);
  saveWindowStateSoon();
});

Object.assign(module.exports, {
  isQuitting,
  markQuitting,
  sessionLayouts,
  lastBounds,
  pendingLayouts,
  CLOSE_GRACE_MS,
  recentlyClosed,
  ptyIdsOf,
  readWindowState,
  boundsVisible,
  scaleBoundsTo,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  defaultBoundsFor,
  cursorDisplay,
  windowEntry,
  flushWindowState,
  saveWindowStateSoon
});
