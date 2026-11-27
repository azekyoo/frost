// Records what the main process was doing when it stopped answering. Windows
// closes a window that hasn't pumped messages for a few seconds ("stopped
// interacting with Windows"), and the process dies without a dump or a stack,
// so the only way to learn which handler held it up is to have written that
// down beforehand.
//
// Two kinds of entry end up in stalls.log:
// - "slow": an IPC handler or labelled callback that ran longer than SLOW_MS
//   and then returned. Logged by the main thread itself, after the fact.
// - "frozen": the main thread hasn't ticked for FROZEN_MS. Logged by a worker
//   thread, which keeps running while the main one is stuck, and reads the
//   label of whatever is running out of shared memory. A hang that ends in
//   Windows killing the app is only ever seen this way.
// Only the synchronous part of a handler is timed: an await hands the thread
// back, so it can't be what froze it.
// Labelled: every IPC handler, every timer (named after its function, or its
// source quoted when slow), shell start (and node-pty's deferred process start
// on Windows), kill, output and exit, and the events
// of the windows, app, screen, power monitor and updater. What is left
// unlabelled is a promise callback, which there is no cheap way to name, or
// native code a library runs on its own. For those, a frozen entry also says
// which labelled call finished last and how long before, and a garbage
// collection pause long enough to matter is logged as "gc".
// Beside those: a window's own long frames (renderer/stalls.js), a window
// Electron finds unresponsive, and a GPU, utility or window process that died.
// A machine that sleeps stops every thread, and on waking the main one looked
// frozen for as long as it slept (and a call cut in half by it, slow). The
// watchdog notices its own timer ran late as well, logs "suspended" instead,
// and the time asleep is taken out of any freeze or slow call it fell inside.

const { Worker } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const SLOW_MS = 300;
const FROZEN_MS = 2000;
const TICK_MS = 250;
const MAX_LOG = 1024 * 1024;
const LABEL_BYTES = 256;
const GC_MS = 500;
// the watchdog checks every 500ms: a check this late means it was stopped too
const SUSPENDED_MS = 1500;

// kept before labelTimers wraps it: reporting a slow call is not itself a call
const rawTimeout = setTimeout;

let logFile = null;
// [last tick, start of the running labelled call or 0, end of the last one,
//  total ms the process has spent suspended]
let beat = null;
let label = null; // utf8, zero-padded
let lastLabel = null; // the outermost labelled call that finished last, same form
let lastName = '';

function write(line) {
  if (!logFile) return;
  try {
    if (fs.statSync(logFile).size > MAX_LOG) fs.renameSync(logFile, logFile + '.old');
  } catch {}
  fs.appendFile(logFile, `${new Date().toISOString()} ${line}\n`, () => {});
}

// The bytes for each name are made once: labels are set on every shell's
// output and every timer, and building a buffer each time would cost more
// than the call being labelled.
const labelBytes = new Map();
function setLabel(name, into = label) {
  if (!into) return;
  let bytes = labelBytes.get(name);
  if (!bytes) {
    bytes = Buffer.from(String(name)).subarray(0, LABEL_BYTES);
    if (labelBytes.size < 2000) labelBytes.set(name, bytes);
  }
  into.fill(0);
  into.set(bytes);
}

// The labelled calls running right now, outermost first, joined with " > ".
let current = '';

// Runs fn under `name`, logging it if it held the thread too long. A call made
// inside another labelled one is named by the whole chain ("status tick >
// titles > scan transcripts"), so a freeze points at the step that held it,
// and the outer label is put back on the way out.
// `detail`, if given, is only asked for when the call was slow: a timer is
// named after its function, and an anonymous one says nothing until its source
// is quoted.
function run(name, fn, self, args, detail) {
  const outer = current;
  const outerStart = beat ? beat[1] : 0;
  current = outer ? outer + ' > ' + name : name;
  setLabel(current);
  const t = performance.now();
  const slept = beat ? beat[3] : 0;
  if (beat) beat[1] = Date.now();
  try {
    return fn.apply(self, args);
  } finally {
    const ms = performance.now() - t;
    if (ms > SLOW_MS) reportSlow(ms, current, detail, slept);
    // the last thing known to have run, for a freeze that comes between calls
    // (written only when it changes: most calls are the same "pty data")
    if (!outer && beat) {
      if (name !== lastName) setLabel((lastName = name), lastLabel);
      beat[2] = Date.now();
    }
    current = outer;
    setLabel(outer);
    if (beat) beat[1] = outerStart;
  }
}

// A call the machine slept through is only slow by what it ran awake. The
// watchdog may count the sleep a moment after the call has ended (both threads
// wake together), so the entry waits a second for that before it is written.
function reportSlow(ms, chain, detail, slept) {
  const line = (held, asleep) =>
    `slow ${Math.round(held)}ms ${chain}${asleep ? ` (+${Math.round(asleep / 1000)}s asleep)` : ''}${detail ? ' — ' + detail() : ''}`;
  if (!beat) return write(line(ms, 0));
  rawTimeout(() => {
    const asleep = beat[3] - slept;
    if (ms - asleep > SLOW_MS) write(line(ms - asleep, asleep));
  }, 1000).unref?.();
}

// Marks a function timed() made, so a timer given one isn't labelled again
// (that logged every slow call twice, once as "timer anonymous" quoting this
// wrapper's own source).
const TIMED = Symbol('timed');

function timed(name, fn, detail) {
  const wrapper = function (...args) {
    return run(name, fn, this, args, detail);
  };
  wrapper[TIMED] = true;
  return wrapper;
}

// One call, run under `name`: for a native call (starting or killing a shell)
// made somewhere no handler or timer label already covers.
const during = (name, fn) => run(name, fn, null, []);

const sourceOf = (fn) => String(fn).replace(/\s+/g, ' ').slice(0, 160);

// Timers, Frost's own and its libraries': a freeze in one used to be logged as
// "unlabelled", with nothing to go on.
function labelTimers() {
  for (const k of ['setTimeout', 'setInterval', 'setImmediate']) {
    const orig = global[k];
    const wrapped = function (fn, ...rest) {
      if (typeof fn !== 'function' || fn[TIMED]) return orig.call(this, fn, ...rest);
      return orig.call(this, timed('timer ' + (fn.name || 'anonymous'), fn, () => sourceOf(fn)), ...rest);
    };
    // util.promisify(setTimeout) looks for this
    const custom = require('util').promisify.custom;
    if (orig[custom]) wrapped[custom] = orig[custom];
    global[k] = wrapped;
  }
}

// Every event an object emits, run under `prefix event`: window moves and
// resizes, power and display changes, the updater. Its listeners are named by
// the event that called them.
function labelEmitter(obj, prefix) {
  if (!obj || typeof obj.emit !== 'function') return;
  const emit = obj.emit;
  obj.emit = function (ev, ...args) {
    return run(prefix + ' ' + String(ev), emit, this, [ev, ...args]);
  };
}

// A process that crashed or a window that stopped answering for good leaves no
// slow call and no long frame behind (a frame is only reported once it ends):
// the window turns black or stuck, and the log said nothing.
// Processes ending cleanly (a closed window, a finished utility) aren't news.
function logProcessesGone(app) {
  const gone = (what, d) => {
    if (d.reason !== 'clean-exit') write(`${what} gone: ${d.reason}, exit code ${d.exitCode}`);
  };
  app.on('child-process-gone', (_e, d) => gone(`process ${d.type}${d.name ? ' (' + d.name + ')' : ''}`, d));
  app.on('render-process-gone', (_e, _wc, d) => gone('window process', d));
}

// ---------- a window that stopped answering ----------
// A window frozen for minutes (2026-11-27) left only "window unresponsive" six
// times and a length counted from the last of them, and no long frame. Now one
// hang is one entry with its real length, what each process was doing (a
// window spinning in script, or idle and waiting on the GPU), the window's
// script stack if it is running script, and the last ten minutes of CPU and
// memory. The trend is kept in memory and written only when a window hangs.

const TREND_EVERY_MS = 30000;
const TREND_SAMPLES = 20;
const STACK_WAIT_MS = 3000;
const STACK_LINES = 12;
// Chromium's hung-window timeout: a window is reported this long after it
// stopped answering an input event
const NOTICED_AFTER_MS = 15000;
// [{ at, procs: Map pid -> { type, cpu, mem } }], oldest first
const trend = [];
let watching = false;

// CPU as % of one core since the previous sample, from each process's total
// CPU seconds: Electron's own percentCPUUsage is spread over all cores on
// Windows (a window spinning one core read 6%) and 0 the first time a process
// is seen. A process seen for the first time is counted from when it started.
let lastCpu = new Map(); // pid -> { secs, at }
function sampleProcesses() {
  const { app } = require('electron');
  const now = Date.now();
  const procs = new Map();
  const cpuNow = new Map();
  for (const m of app.getAppMetrics()) {
    const secs = m.cpu?.cumulativeCPUUsage;
    let cpu = '?';
    if (Number.isFinite(secs)) {
      const before = lastCpu.get(m.pid) || { secs: 0, at: m.creationTime || now };
      const wall = (now - before.at) / 1000;
      if (wall > 0.5) cpu = Math.round(((secs - before.secs) / wall) * 100);
      cpuNow.set(m.pid, { secs, at: now });
    }
    procs.set(m.pid, { type: m.type, cpu, mem: Math.round((m.memory?.workingSetSize || 0) / 1024) });
  }
  lastCpu = cpuNow;
  return procs;
}

// The window's own process, the GPU process and main, by name
function namedProcesses(procs, windowPid) {
  const out = [];
  if (procs.has(windowPid)) out.push(['window', procs.get(windowPid)]);
  for (const p of procs.values()) {
    if (p.type === 'GPU') out.push(['gpu', p]);
    else if (p.type === 'Browser') out.push(['main', p]);
  }
  return out;
}

const processLine = (procs, windowPid) =>
  namedProcesses(procs, windowPid)
    .map(([name, p]) => `${name} cpu ${p.cpu}% mem ${p.mem}MB`)
    .join(', ');

function trendLine(windowPid) {
  if (!trend.length) return '';
  const series = [];
  const pick = (name, procs) => namedProcesses(procs, windowPid).find(([n]) => n === name)?.[1];
  for (const name of ['window', 'gpu', 'main']) {
    const points = trend.map((s) => pick(name, s.procs));
    if (!points.some(Boolean)) continue;
    const list = (k) => points.map((p) => (p ? p[k] : '-')).join(' ');
    series.push(`${name} cpu% ${list('cpu')} | mem MB ${list('mem')}`);
  }
  const mins = Math.round((Date.now() - trend[0].at) / 60000);
  return `trend, last ${mins} min every ${TREND_EVERY_MS / 1000}s: ${series.join(' ; ')}`;
}

// "file:///C:/…/src/renderer/panes/glow.js:12:5" -> "panes/glow.js:12:5"
const stackLine = (s) =>
  String(s)
    .trim()
    .split('\n')
    .map((l) => l.trim().replace(/^at /, '').replace(/file:\/\/\S*?\/(?:src\/renderer|node_modules)\//g, ''))
    .filter(Boolean)
    .slice(0, STACK_LINES)
    .join(' < ');

// Chromium hands out a window's stack only to a page that asks for it, with a
// Document-Policy header. A page loaded from a file has no headers, so the
// header is added to Frost's own pages here, and nothing else is touched.
function allowWindowStacks() {
  const { session } = require('electron');
  const { pathToFileURL } = require('url');
  const { RENDERER_DIR } = require('./env');
  const pages = pathToFileURL(RENDERER_DIR).href + '/*';
  session.defaultSession.webRequest.onHeadersReceived({ urls: [pages] }, (d, done) => {
    if (d.resourceType !== 'mainFrame') return done({});
    done({ responseHeaders: { ...d.responseHeaders, 'Document-Policy': ['include-js-call-stacks-in-crash-reports'] } });
  });
}

// Started with the first window (the app is ready by then).
function watchProcesses() {
  if (watching) return;
  watching = true;
  try {
    allowWindowStacks();
  } catch (e) {
    write(`window stacks not available: ${e.message}`);
  }
  const sample = () => {
    try {
      trend.push({ at: Date.now(), procs: sampleProcesses() });
      if (trend.length > TREND_SAMPLES) trend.shift();
    } catch {}
  };
  sample();
  setInterval(sample, TREND_EVERY_MS).unref();
}

// The stack of whatever script the window is running. The promise never
// settles when it runs none, which says as much: it is stuck in layout, paint,
// the GPU or native code.
async function windowStack(w) {
  try {
    const wait = new Promise((r) => rawTimeout(() => r(null), STACK_WAIT_MS));
    const s = await Promise.race([w.webContents.mainFrame.collectJavaScriptCallStack(), wait]);
    if (s === null) return `no script running (no stack after ${STACK_WAIT_MS / 1000}s)`;
    if (!s || /not opted in/i.test(s)) return 'stack not available' + (s ? ': ' + s : '');
    return stackLine(s) || 'empty stack';
  } catch (e) {
    return `stack not available: ${e.message}`;
  }
}

// Electron's own "not answering" for a window, and how long it lasted.
// Electron says "unresponsive" again every few seconds while a hang lasts:
// the length is counted from the first, and the repeats only counted.
function logUnresponsive(w) {
  watchProcesses();
  let since = 0;
  let repeats = 0;
  const pid = () => {
    try {
      return w.webContents.getOSProcessId();
    } catch {
      return 0;
    }
  };
  w.on('unresponsive', async () => {
    if (since) return void repeats++;
    // Electron notices a few seconds in; the window was already stuck
    since = Date.now();
    repeats = 1;
    let procs = '';
    try {
      procs = processLine(sampleProcesses(), pid());
    } catch {}
    write(`window unresponsive (stuck for ${NOTICED_AFTER_MS / 1000}s already) | cpu: ${procs}`);
    const t = trendLine(pid());
    if (t) write(t);
    write(`window stack: ${await windowStack(w)}`);
  });
  w.on('responsive', () => {
    if (!since) return;
    // CPU use since the sample taken when the hang began: what the hang cost
    let procs = '';
    try {
      procs = processLine(sampleProcesses(), pid());
    } catch {}
    const times = repeats > 1 ? `, reported unresponsive ${repeats} times` : '';
    const ms = Date.now() - since;
    write(
      `window responsive again: hung about ${Math.round((ms + NOTICED_AFTER_MS) / 1000)}s ` +
        `(${ms}ms after Electron noticed, which takes ${NOTICED_AFTER_MS / 1000}s${times}) | cpu since: ${procs}`
    );
    since = 0;
    repeats = 0;
  });
}

const WATCHDOG = `
const { workerData } = require('worker_threads');
const fs = require('fs');
const beat = new Float64Array(workerData.beat);
const label = new Uint8Array(workerData.label);
const lastLabel = new Uint8Array(workerData.lastLabel);
const text = (bytes) => { const end = bytes.indexOf(0); return Buffer.from(bytes.subarray(0, end < 0 ? bytes.length : end)).toString(); };
const log = (line) => { try { fs.appendFileSync(workerData.logFile, new Date().toISOString() + ' ' + line + '\\n'); } catch {} };
let reported = 0;
let lastCheck = Date.now();
let woke = 0; // when the process last came back from being suspended
setInterval(() => {
  const now = Date.now();
  // This thread was stopped as well, so the whole process was (the machine
  // slept): not a freeze. Time is counted again from the moment it woke.
  const late = now - lastCheck - 500;
  lastCheck = now;
  if (late > ${SUSPENDED_MS} - 500) {
    beat[3] += late;
    woke = now;
    if (reported) reported += late;
    log('suspended ' + Math.round(late) + 'ms (the machine slept, or the process was paused)');
  }
  const still = now - Math.max(beat[0], woke);
  if (still < ${FROZEN_MS}) {
    if (reported) {
      log('unfrozen after ' + Math.round(now - reported) + 'ms');
      reported = 0;
    }
    return;
  }
  if (reported) return;
  reported = Math.max(beat[0], woke);
  const name = text(label) || '(unlabelled: a promise callback, or native code between calls)';
  const last = text(lastLabel);
  const since = beat[1]
    ? Math.round(now - Math.max(beat[1], woke)) + 'ms in it'
    : 'not in a labelled call' + (last && beat[2] ? '; last labelled: ' + last + ', ended ' + Math.round(now - beat[2]) + 'ms ago' : '');
  log('frozen ' + Math.round(still) + 'ms, running: ' + name + ' (' + since + ')');
}, 500);
`;

function install(ipcMain, userData) {
  logFile = path.join(userData, 'stalls.log');
  // lets a hung window's script stack be read (logUnresponsive); a second
  // enable-features switch set anywhere else would replace this one, so add to
  // this list instead. Must be set before the app is ready.
  try {
    require('electron').app.commandLine.appendSwitch('enable-features', 'DocumentPolicyIncludeJSCallStacksInCrashReports');
  } catch {}
  try {
    const beatBuf = new SharedArrayBuffer(32);
    const labelBuf = new SharedArrayBuffer(LABEL_BYTES);
    const lastBuf = new SharedArrayBuffer(LABEL_BYTES);
    beat = new Float64Array(beatBuf);
    label = new Uint8Array(labelBuf);
    lastLabel = new Uint8Array(lastBuf);
    beat[0] = Date.now();
    // the heartbeat itself stays unlabelled: started before labelTimers
    setInterval(() => (beat[0] = Date.now()), TICK_MS).unref();
    new Worker(WATCHDOG, { eval: true, workerData: { beat: beatBuf, label: labelBuf, lastLabel: lastBuf, logFile } }).unref();
  } catch (e) {
    beat = label = lastLabel = null; // still log slow calls
    write(`watchdog not started: ${e.message}`);
  }

  // A long garbage collection stops the thread with no call of ours running
  try {
    const { PerformanceObserver } = require('perf_hooks');
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.duration > GC_MS) write(`gc ${Math.round(e.duration)}ms (kind ${e.detail?.kind ?? e.kind})`);
    }).observe({ entryTypes: ['gc'] });
  } catch {}

  const on = ipcMain.on.bind(ipcMain);
  const handle = ipcMain.handle.bind(ipcMain);
  // a window's own long frames (renderer/stalls.js), written as they come
  on('stalls:window', (_e, line) => write(String(line).replace(/\s+/g, ' ').slice(0, 600)));
  ipcMain.on = (channel, fn) => on(channel, timed('ipc ' + channel, fn));
  ipcMain.handle = (channel, fn) => handle(channel, timed('ipc ' + channel, fn));
  labelTimers();
}

module.exports = { install, timed, during, labelEmitter, logProcessesGone, logUnresponsive };
