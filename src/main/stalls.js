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

const { Worker } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const SLOW_MS = 300;
const FROZEN_MS = 2000;
const TICK_MS = 250;
const MAX_LOG = 1024 * 1024;
const LABEL_BYTES = 256;

let logFile = null;
let beat = null; // [last tick, start of the running labelled call or 0]
let label = null; // utf8, zero-padded

function write(line) {
  if (!logFile) return;
  try {
    if (fs.statSync(logFile).size > MAX_LOG) fs.renameSync(logFile, logFile + '.old');
  } catch {}
  fs.appendFile(logFile, `${new Date().toISOString()} ${line}\n`, () => {});
}

function setLabel(name) {
  if (!label) return;
  label.fill(0);
  label.set(Buffer.from(String(name)).subarray(0, LABEL_BYTES));
}

// Runs fn under `name`, logging it if it held the thread too long. Nested calls
// put the outer label back on the way out.
function timed(name, fn) {
  return function (...args) {
    const outer = label ? Buffer.from(label) : null;
    const outerStart = beat ? beat[1] : 0;
    setLabel(name);
    const t = performance.now();
    if (beat) beat[1] = Date.now();
    try {
      return fn.apply(this, args);
    } finally {
      const ms = performance.now() - t;
      if (ms > SLOW_MS) write(`slow ${Math.round(ms)}ms ${name}`);
      if (outer) label.set(outer);
      if (beat) beat[1] = outerStart;
    }
  };
}

const WATCHDOG = `
const { workerData } = require('worker_threads');
const fs = require('fs');
const beat = new Float64Array(workerData.beat);
const label = new Uint8Array(workerData.label);
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
  const end = label.indexOf(0);
  const name = Buffer.from(label.subarray(0, end < 0 ? label.length : end)).toString() || '(unlabelled: window event, watcher or timer)';
  const since = beat[1] ? Math.round(now - beat[1]) + 'ms in it' : 'not in a labelled call';
  try {
    fs.appendFileSync(workerData.logFile, new Date().toISOString() + ' frozen ' + Math.round(now - beat[0]) + 'ms, running: ' + name + ' (' + since + ')\\n');
  } catch {}
}, 500);
`;

function install(ipcMain, userData) {
  logFile = path.join(userData, 'stalls.log');
  try {
    const beatBuf = new SharedArrayBuffer(16);
    const labelBuf = new SharedArrayBuffer(LABEL_BYTES);
    beat = new Float64Array(beatBuf);
    label = new Uint8Array(labelBuf);
    beat[0] = Date.now();
    setInterval(() => (beat[0] = Date.now()), TICK_MS).unref();
    new Worker(WATCHDOG, { eval: true, workerData: { beat: beatBuf, label: labelBuf, logFile } }).unref();
  } catch (e) {
    beat = label = null; // still log slow calls
    write(`watchdog not started: ${e.message}`);
  }

  const on = ipcMain.on.bind(ipcMain);
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.on = (channel, fn) => on(channel, timed('ipc ' + channel, fn));
  ipcMain.handle = (channel, fn) => handle(channel, timed('ipc ' + channel, fn));
}

module.exports = { install, timed };
