const fs = require('fs');

const { whichExe } = require('./shells');

// Editor command as an argv template, as on Windows. `app` is where the command
// line tool sits inside the app bundle, for when it was never put on PATH
// (VS Code only does that if you ask it to).
const EDITOR_CANDIDATES = [
  { exe: 'code', app: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', args: ['--goto', '{file}:{line}:{column}'] },
  { exe: 'code-insiders', app: '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code', args: ['--goto', '{file}:{line}:{column}'] },
  { exe: 'cursor', app: '/Applications/Cursor.app/Contents/Resources/app/bin/cursor', args: ['--goto', '{file}:{line}:{column}'] },
  { exe: 'windsurf', app: '/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf', args: ['--goto', '{file}:{line}:{column}'] },
  { exe: 'subl', app: '/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl', args: ['{file}:{line}:{column}'] },
  { exe: 'idea', app: '/Applications/IntelliJ IDEA.app/Contents/MacOS/idea', args: ['--line', '{line}', '{file}'] }
];

// On macOS what's on PATH is spawnable as it is (a script with a #! line runs
// directly), so there's no shim to walk past.
function resolveExecutable(name, appPath) {
  if (name.includes('/')) return fs.existsSync(name) ? name : null;
  return whichExe(name) || (appPath && fs.existsSync(appPath) ? appPath : null);
}

Object.assign(module.exports, {
  EDITOR_CANDIDATES,
  resolveExecutable
});
