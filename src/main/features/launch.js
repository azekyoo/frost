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
const getStartupLaunch = () => startupLaunch;
function takeStartupLaunch() {
  const launch = startupLaunch;
  startupLaunch = null;
  return launch;
}

Object.assign(module.exports, {
  getStartupLaunch,
  takeStartupLaunch,
  launchFromArgv
});
