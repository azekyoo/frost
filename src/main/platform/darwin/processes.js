const { execFile } = require('child_process');

// Claude Code's session registry records each process's start time beside its
// pid, so a pid reused by something else after a reboot isn't taken for a
// claude still open. On macOS it writes the time the way `ps -o lstart` prints
// it, in UTC: "Sat Nov 21 05:52:41 2026".
const LSTART = /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4}$/;
const canCheckProc = (s) => typeof s.procStart === 'string' && LSTART.test(s.procStart);

// Start times of the given pids, in that same form; a pid that is gone is left
// out. Null when the lookup itself failed. UTC and the C locale, so the text is
// exactly what Claude Code recorded.
function processStartTimes(pids) {
  // only pids that exist: ps refuses the whole list over one it can't take
  // (anything over macOS's 99999, as a stale file can hold)
  const alive = pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e.code === 'EPERM'; // someone else's: there, just not ours
    }
  });
  if (!alive.length) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-o', 'pid=,lstart=', '-p', alive.join(',')],
      { encoding: 'utf8', timeout: 15000, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } }, (err, stdout) => {
        // ps exits 1 when some pid is gone: still an answer for the others
        if (err && !stdout) return resolve(err.code === 1 ? new Map() : null);
        const starts = new Map();
        for (const line of String(stdout).split('\n')) {
          const m = /^\s*(\d+) (.+?)\s*$/.exec(line);
          if (m) starts.set(Number(m[1]), m[2]);
        }
        resolve(starts);
      });
  });
}

Object.assign(module.exports, {
  canCheckProc,
  processStartTimes
});
