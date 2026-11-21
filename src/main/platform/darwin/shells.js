const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ---------- shell profiles ----------
// Same profile shape as on Windows: { id, name, shell, args[], agentWrapper }.
//
// An app started from Finder or the Dock doesn't get the PATH a terminal has
// (Homebrew's folders are added by the shell's own startup files), so `which`
// alone would miss anything installed there. These are the usual places.
const EXTRA_BIN = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

function whichExe(name) {
  const r = spawnSync('/usr/bin/which', [name], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout && r.stdout.trim()) return r.stdout.trim().split('\n')[0];
  for (const dir of EXTRA_BIN) {
    const f = path.join(dir, name);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      return f;
    } catch {}
  }
  return null;
}

// No WSL on a Mac.
function wslDistros() {
  return [];
}

// The user's login shell, as the account records it. $SHELL is normally the
// same, but is missing when Frost is started oddly (launchd, some IDEs).
function loginShell() {
  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) return process.env.SHELL;
  try {
    const s = os.userInfo().shell;
    if (s && fs.existsSync(s)) return s;
  } catch {}
  return '/bin/zsh';
}

function detectProfiles() {
  const out = [];
  const seen = new Set();
  const add = (p) => {
    if (!p.shell || seen.has(p.id)) return;
    seen.add(p.id);
    out.push(p);
  };

  // zsh gets its hooks through ZDOTDIR (see shell-integration.js)
  const zsh = { id: 'zsh', name: 'zsh', args: ['-l'], agentWrapper: 'zsh' };
  // macOS ships bash 3.2 in /bin; a Homebrew bash is newer and preferred. The
  // bash dialect replaces the args with its own --rcfile.
  const brewBash = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash'].find((f) => fs.existsSync(f));
  const bash = { id: 'bash', name: 'bash', shell: brewBash || '/bin/bash', args: ['-l'], agentWrapper: 'bash' };
  const fish = { id: 'fish', name: 'fish', shell: whichExe('fish'), args: ['-l'], agentWrapper: 'none' };

  // The login shell comes first: it is what a new tab opens with by default.
  const login = loginShell();
  const base = path.basename(login);
  if (base === 'zsh') add({ ...zsh, shell: login });
  else if (base === 'bash') add({ ...bash, shell: login });
  else if (base === 'fish') add({ ...fish, shell: login });
  else add({ id: base, name: base, shell: login, args: ['-l'], agentWrapper: 'none' });

  if (fs.existsSync('/bin/zsh')) add({ ...zsh, shell: '/bin/zsh' });
  add(bash);
  add(fish);
  const pwsh = whichExe('pwsh');
  if (pwsh) add({ id: 'pwsh', name: 'PowerShell', shell: pwsh, args: [], agentWrapper: 'powershell' });

  return out;
}

Object.assign(module.exports, {
  whichExe,
  wslDistros,
  detectProfiles
});
