const fs = require('fs');
const path = require('path');

const { whichExe } = require('./shells');

// Editor command as an argv template; {file} {line} {column} are substituted as
// whole arguments, never spliced into a string that a shell would parse.
//
// `app` is the real executable to look for. What's on PATH is usually a shim —
// VS Code installs an extensionless `bin/code` next to `Code.exe` — and Node
// can't spawn a shim without going through a shell, which is exactly what we're
// avoiding. So each editor also says which .exe to find alongside it.
const EDITOR_CANDIDATES = [
  { exe: 'code', app: 'Code.exe', args: ['--goto', '{file}:{line}:{column}'] },
  { exe: 'code-insiders', app: 'Code - Insiders.exe', args: ['--goto', '{file}:{line}:{column}'] },
  { exe: 'cursor', app: 'Cursor.exe', args: ['--goto', '{file}:{line}:{column}'] },
  { exe: 'windsurf', app: 'Windsurf.exe', args: ['--goto', '{file}:{line}:{column}'] },
  { exe: 'subl', app: 'subl.exe', args: ['{file}:{line}:{column}'] },
  { exe: 'idea', app: 'idea64.exe', args: ['--line', '{line}', '{file}'] },
  { exe: 'nvim-qt', app: 'nvim-qt.exe', args: ['--', '+{line}', '{file}'] }
];

// Walks from whatever is on PATH to something spawnable.
function resolveExecutable(name, appExe) {
  if (/[\\/]/.test(name)) return fs.existsSync(name) ? name : null;
  const hit = whichExe(name);
  if (hit && /\.exe$/i.test(hit)) return hit;
  if (!hit) return null;
  const dir = path.dirname(hit);
  for (const rel of [path.join('..', appExe || name + '.exe'), appExe || name + '.exe']) {
    const candidate = path.resolve(dir, rel);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

Object.assign(module.exports, {
  EDITOR_CANDIDATES,
  resolveExecutable
});
