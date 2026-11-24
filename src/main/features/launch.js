const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// `frost .` and the "Open Frost here" shell entry both arrive as a directory
// argument. `--run "<cmd>"` types a command into that tab once its shell is up
// (a session manager reopening `claude --resume <id>`), and `--profile <id>`
// picks the shell. Command line only: nothing else — no link, no protocol
// handler — may ever produce a run, or a click could execute commands.
// Packaged, argv is [exe, ...args]; from source it's [electron, '.', ...].
function launchFromArgv(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  const launch = { dir: null, run: null, profileId: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    const flag = /^--(run|profile)(?:=(.*))?$/s.exec(a);
    if (flag) {
      // the value is the next argument unless given as --run=...; either way
      // it is never mistaken for the directory
      const v = flag[2] !== undefined ? flag[2] : args[++i];
      if (typeof v === 'string' && v.trim()) launch[flag[1] === 'run' ? 'run' : 'profileId'] = v;
      continue;
    }
    if (a.startsWith('-') || launch.dir) continue;
    try {
      const p = path.resolve(a);
      if (fs.statSync(p).isDirectory()) launch.dir = p;
    } catch {}
  }
  return launch.dir || launch.run ? launch : null;
}

// This process's own launch, handed to the first window that asks and to no
// other: a window opened later must not run the command again.
let startupLaunch = launchFromArgv(process.argv);
let startupTaken = false; // the first window has asked; later launches go to a window
const getStartupLaunch = () => startupLaunch;
function takeStartupLaunch() {
  const launch = startupLaunch;
  startupLaunch = null;
  startupTaken = true;
  return launch;
}

// macOS: a folder dropped on the Dock icon, Finder's Open With → Frost and
// `open -a Frost <dir>` reach the app as open-file events, not as a second
// process with an argv, and they reach it whether it is running or not. Each
// is a `frost <dir>`: before the first window exists it is this launch (one
// fresh window there, nothing restored); after, it goes to the window in front
// as a new tab, as a second launch would. A file opens the folder it is in.
// Only ever a folder: nothing arriving this way can carry a command to run.
if (process.platform === 'darwin') {
  app.on('open-file', (event, file) => {
    event.preventDefault();
    let dir;
    try {
      dir = fs.statSync(file).isDirectory() ? file : path.dirname(file);
    } catch {
      return;
    }
    const launch = { dir, run: null, profileId: null };
    if (!startupTaken) {
      startupLaunch = launch;
      return;
    }
    const { focusedWindow } = require('./windows/registry');
    const target = focusedWindow();
    if (!target) return;
    if (target.isMinimized()) target.restore();
    target.focus();
    target.webContents.send('session:openDir', launch);
  });
}

Object.assign(module.exports, {
  getStartupLaunch,
  takeStartupLaunch,
  launchFromArgv
});
