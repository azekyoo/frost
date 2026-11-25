const { BrowserWindow } = require('electron');

const stalls = require('../../stalls');
const { DEFAULT_THEME, readTheme } = require('../config');
const { SPARE_DEFAULT, SPARE_HIDE_CAP_MS, SPARE_MAX, SPARE_QUIET_MS, SPARE_REFILL_MS, SPARE_STALE_MS } = require('./spare-timing');
const { detachedPtys, ptyMeta, ptyOwners, ptys } = require('./registry');
const { findProfile, shellCwd, startDir } = require('../profiles');
const { late } = require('../../late');
const { holdForRun, spawnShell } = late(require('./shells'), ['holdForRun', 'spawnShell']);

const spares = []; // { id, key, born, ready }
const spareHiding = new Map(); // ptyId -> { osc, timer }: claimed, output not shown yet
let spareTimer = null;
let lastTyped = 0;
const noteTyped = () => {
  lastTyped = Date.now();
};

function spareCount() {
  const n = readTheme()?.spareShells;
  return Number.isInteger(n) ? Math.max(0, Math.min(SPARE_MAX, n)) : SPARE_DEFAULT;
}

// Everything a shell is started with that a setting can change. null: the
// default profile isn't one spares are kept for.
function spareKey() {
  const profile = findProfile();
  if (!profile || profile.agentWrapper !== 'powershell') return null;
  const t = readTheme() || DEFAULT_THEME;
  return JSON.stringify([profile, t.autoDetectAgents !== false, startDir()]);
}

function killSpare(spare) {
  const i = spares.indexOf(spare);
  if (i >= 0) spares.splice(i, 1);
  detachedPtys.delete(spare.id);
  try {
    stalls.during('pty kill spare', () => ptys.get(spare.id)?.kill());
  } catch {}
}

function fillSpares(delay = 0) {
  clearTimeout(spareTimer);
  spareTimer = setTimeout(() => {
    spareTimer = null;
    const key = spareKey();
    for (const s of [...spares]) if (s.key !== key) killSpare(s);
    spares.slice(spareCount()).forEach(killSpare);
    // one at a time: each runs the whole profile, and two at once only slows both
    if (!key || spares.length >= spareCount() || spares.some((s) => !s.ready)) return;
    if (!BrowserWindow.getAllWindows().length) return;
    try {
      const { id } = spawnShell({ cols: 120, rows: 30, spare: true });
      spares.push({ id, key, born: Date.now(), ready: false });
    } catch {}
  }, delay);
}

// a spare is ready at its first prompt; the next one starts then
function spareWatch(id, data) {
  const spare = spares.find((s) => s.id === id);
  if (!spare || spare.ready || !data.includes('\x1b]133;A')) return;
  spare.ready = true;
  fillSpares(SPARE_REFILL_MS);
}

function spareGone(id) {
  const spare = spares.find((s) => s.id === id);
  if (spare) {
    killSpare(spare);
    fillSpares(SPARE_REFILL_MS);
  }
  clearTimeout(spareHiding.get(id)?.timer);
  spareHiding.delete(id);
}

// Until the prompt after the move, nothing a claimed spare prints is shown.
// That prompt starts at its 133;A; the cwd report the hook writes just before
// it is kept, or the pane would not know its folder until the next prompt.
function spareFilter(id, data) {
  const hide = spareHiding.get(id);
  if (!hide) return data;
  const at = data.indexOf('\x1b]133;A');
  const before = at < 0 ? data : data.slice(0, at);
  const cwds = before.match(/\x1b\]9;9;[^\x07]*\x07/g);
  if (cwds) hide.osc = cwds[cwds.length - 1];
  if (at < 0) return '';
  clearTimeout(hide.timer);
  spareHiding.delete(id);
  return hide.osc + data.slice(at);
}

function claimSpare(owner, opts) {
  if (opts.adopt) return null;
  const profile = findProfile(opts.profileId);
  if (profile.id !== findProfile().id) return null;
  const key = spareKey();
  const spare = key && spares.find((s) => s.ready && s.key === key && ptys.has(s.id));
  if (!spare) return null;
  const { id } = spare;
  spares.splice(spares.indexOf(spare), 1);
  detachedPtys.delete(id); // the banner and the old prompt: never shown
  ptyOwners.set(id, owner);
  const p = ptys.get(id);
  try {
    if (opts.cols > 0 && opts.rows > 0) p.resize(opts.cols, opts.rows);
  } catch {}
  spareHiding.set(id, {
    osc: '',
    timer: setTimeout(() => spareHiding.delete(id), SPARE_HIDE_CAP_MS)
  });
  const cwd = shellCwd(profile, opts.cwd).replace(/'/g, "''");
  try {
    p.write(`Set-Location -LiteralPath '${cwd}'; Clear-Host #frost-spare\r`);
  } catch {}
  // a pane opened to run claude types it at the prompt the move ends on
  if (opts.run) holdForRun(id, opts.run, true);
  fillSpares(SPARE_REFILL_MS);
  const meta = ptyMeta.get(id) || {};
  return { id, profileId: meta.profileId || profile.id, profileName: meta.profileName || profile.name };
}

// a spare old enough to have missed a change to PATH is replaced, but only
// while nothing is being typed: starting one costs seconds of CPU
setInterval(() => {
  if (Date.now() - lastTyped < SPARE_QUIET_MS) return;
  const stale = spares.find((s) => s.ready && Date.now() - s.born > SPARE_STALE_MS);
  if (stale) {
    killSpare(stale);
    fillSpares();
  }
}, 60000);

Object.assign(module.exports, {
  noteTyped,
  spares,
  spareHiding,
  spareCount,
  spareKey,
  killSpare,
  fillSpares,
  spareWatch,
  spareGone,
  spareFilter,
  claimSpare
});
