const { execFile } = require('child_process');

const canCheckProc = (s) => process.platform === 'win32' && typeof s.procStart === 'string' && /^\d+$/.test(s.procStart);

// Creation times of the given pids, as FILETIME strings; a pid that is gone,
// or whose start can't be read (another user's, a system service), is left
// out. Null when the lookup itself failed.
function processStartTimes(pids) {
  const script =
    `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object {` +
    ` try { '{0} {1}' -f $_.Id, $_.StartTime.ToFileTimeUtc() } catch {} }; 'done'`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 }, (err, stdout) => {
        const lines = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (err || lines[lines.length - 1] !== 'done') return resolve(null);
        const starts = new Map();
        for (const l of lines) {
          const m = /^(\d+) (\d+)$/.exec(l);
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
