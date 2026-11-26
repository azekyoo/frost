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

const { Worker } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const SLOW_MS = 300;
const FROZEN_MS = 2000;
const TICK_MS = 250;
const MAX_LOG = 1024 * 1024;
const LABEL_BYTES = 256;
const GC_MS = 500;

let logFile = null;
let beat = null; // [last tick, start of the running labelled call or 0, end of the last one]
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
  if (beat) beat[1] = Date.now();
  try {
    return fn.apply(self, args);
  } finally {
    const ms = performance.now() - t;
    if (ms > SLOW_MS) write(`slow ${Math.round(ms)}ms ${current}${detail ? ' — ' + detail() : ''}`);
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

function timed(name, fn, detail) {
  return function (...args) {
    return run(name, fn, this, args, detail);
  };
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
      if (typeof fn !== 'function') return orig.call(this, fn, ...rest);
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

const WATCHDOG = `
const { workerData } = require('worker_threads');
const fs = require('fs');
const beat = new Float64Array(workerData.beat);
const label = new Uint8Array(workerData.label);
const lastLabel = new Uint8Array(workerData.lastLabel);
const text = (bytes) => { const end = bytes.indexOf(0); return Buffer.from(bytes.subarray(0, end < 0 ? bytes.length : end)).toString(); };
let reported = 0;
setInterval(() => {
  const now = Date.now();
  if (now - beat[0] < ${FROZEN_MS}) {
    if (reported) {
      fs.appendFileSync(workerData.logFile, new Date().toISOString() + ' unfrozen after ' + (now - reported) + 'ms\\n');
      reported = 0;
    }
    return;
  }
  if (reported) return;
  reported = beat[0];
  const name = text(label) || '(unlabelled: a promise callback, or native code between calls)';
  const last = text(lastLabel);
  const since = beat[1]
    ? Math.round(now - beat[1]) + 'ms in it'
    : 'not in a labelled call' + (last && beat[2] ? '; last labelled: ' + last + ', ended ' + Math.round(now - beat[2]) + 'ms ago' : '');
  try {
    fs.appendFileSync(workerData.logFile, new Date().toISOString() + ' frozen ' + Math.round(now - beat[0]) + 'ms, running: ' + name + ' (' + since + ')\\n');
  } catch {}
}, 500);
`;

function install(ipcMain, userData) {
  logFile = path.join(userData, 'stalls.log');
  try {
    const beatBuf = new SharedArrayBuffer(24);
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

module.exports = { install, timed, during, labelEmitter };
