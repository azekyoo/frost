const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---------- shell profiles ----------
// A profile is { id, name, shell, args[], cwd?, env?, agentWrapper }.
// agentWrapper picks the shell dialect used to inject the `claude` wrapper:
// 'powershell' | 'bash' | 'none' (no agent auto-detect in that shell).

function whichExe(name) {
  const r = spawnSync('where.exe', [name], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout && r.stdout.trim()) {
    const hits = r.stdout.trim().split(/\r?\n/);
    // prefer a real executable over a shim: `where code` lists an extensionless
    // launcher script that Node can't spawn without a shell
    const exes = hits.filter((h) => /\.exe$/i.test(h));
    // A Store app is listed twice: inside its versioned package directory and
    // again as the execution alias. The alias tracks whichever version is
    // current, which is what we would rather record — but it is a reparse
    // point that ConPTY cannot start, so take the real file and let the spawn
    // recover when an update moves it.
    return exes.find((h) => fs.existsSync(h)) || exes[0] || hits[0];
  }
  return null;
}

function wslDistros() {
  // wsl.exe -l -q writes UTF-16LE, so decode the raw buffer ourselves
  const r = spawnSync('wsl.exe', ['-l', '-q'], { encoding: 'buffer' });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .toString('utf16le')
    .split(/\r?\n/)
    .map((s) => s.replace(/\0/g, '').trim())
    .filter(Boolean);
}

function detectProfiles() {
  const out = [];
  const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

  const pwsh = whichExe('pwsh');
  if (pwsh) out.push({ id: 'pwsh', name: 'PowerShell', shell: pwsh, args: [], agentWrapper: 'powershell' });

  const wps = path.join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (fs.existsSync(wps)) {
    out.push({ id: 'powershell', name: 'Windows PowerShell', shell: wps, args: [], agentWrapper: 'powershell' });
  }

  const cmd = path.join(sys, 'cmd.exe');
  if (fs.existsSync(cmd)) {
    out.push({ id: 'cmd', name: 'Command Prompt', shell: cmd, args: [], agentWrapper: 'none' });
  }

  for (const base of [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')
  ]) {
    if (!base) continue;
    const b = path.join(base, 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(b)) {
      out.push({ id: 'git-bash', name: 'Git Bash', shell: b, args: ['-i', '-l'], agentWrapper: 'bash' });
      break;
    }
  }

  const wsl = whichExe('wsl.exe');
  if (wsl) {
    // docker-desktop* are Docker's plumbing distros, not shells anyone wants
    for (const d of wslDistros().filter((d) => !/^docker-desktop/i.test(d))) {
      out.push({
        id: 'wsl-' + d.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        name: d + ' (WSL)',
        shell: wsl,
        args: ['-d', d, '--cd', '~'],
        agentWrapper: 'none'
      });
    }
  }

  if (!out.length) {
    out.push({ id: 'powershell', name: 'Windows PowerShell', shell: 'powershell.exe', args: [], agentWrapper: 'powershell' });
  }
  return out;
}

Object.assign(module.exports, {
  whichExe,
  wslDistros,
  detectProfiles
});
