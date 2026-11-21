const { app } = require('electron');
const { spawnSync } = require('child_process');
const os = require('os');

// An app opened from Finder or the Dock gets launchd's bare PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), not the one a terminal has: Homebrew,
// ~/.local/bin (where claude installs) and nvm are all added by the user's
// shell startup files. Everything Frost runs or looks up — claude, node for its
// hooks, an editor — would go missing. So once, at startup, ask the user's own
// login shell what PATH it ends up with and take that.
//
// Only for a packaged build: `npm start` is run from a terminal and already has
// the right PATH. Bounded, so a slow or broken shell config can't hold startup.
const MARK = '__FROST_PATH__';

function adoptLoginShellPath() {
  if (!app.isPackaged) return;
  const shell = process.env.SHELL || os.userInfo().shell || '/bin/zsh';
  try {
    const r = spawnSync(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const m = new RegExp(`${MARK}(.*?)${MARK}`).exec(r.stdout || '');
    if (m && m[1]) process.env.PATH = m[1];
  } catch {}
}

Object.assign(module.exports, { adoptLoginShellPath });
