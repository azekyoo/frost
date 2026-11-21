const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { app, dialog, Menu } = require('electron');

const { NOTIFY_ICON_FILE } = require('../../env');

// Run from source, the Dock shows Electron's icon: give it Frost's.
function identifySourceBuild() {
  try {
    app.dock?.setIcon(NOTIFY_ICON_FILE);
  } catch {}
}

function homeDir() {
  return os.homedir();
}

function isPortableBuild() {
  return false;
}

// ---------- the `frost` command ----------
// Windows' installer puts frost.cmd on PATH. An app dragged into Applications
// can't change PATH, so, as VS Code does for `code`, a menu item links the
// script that ships inside Frost.app (build/mac/frost) into /usr/local/bin,
// which every macOS shell has on PATH. That folder belongs to root, so macOS
// asks for the password once. A link rather than a copy: it keeps pointing at
// the app, so it follows every update.
const COMMAND_LINK = '/usr/local/bin/frost';

function installShellCommand() {
  const say = (message, detail, type = 'info') => dialog.showMessageBox({ type, message, detail, buttons: ['OK'] });
  if (!app.isPackaged) {
    return say("Only the installed Frost can add the 'frost' command", 'From source, Frost runs through npm start instead.', 'warning');
  }
  const script = path.join(process.resourcesPath, 'frost');
  const done = () =>
    say(
      "The 'frost' command is installed",
      'In a new terminal:\n  frost .   opens Frost in that folder\n  frost <dir> --run "<command>"   and runs a command there'
    );
  try {
    if (fs.readlinkSync(COMMAND_LINK) === script) return done();
  } catch {}
  // Writable without a password on some setups (a Homebrew-owned /usr/local)
  try {
    fs.rmSync(COMMAND_LINK, { force: true });
    fs.symlinkSync(script, COMMAND_LINK);
    return done();
  } catch {}
  // Otherwise through macOS's own password prompt. The path is passed as an
  // AppleScript string and quoted for the shell by AppleScript itself.
  const asString = (s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const script_ =
    `do shell script "mkdir -p /usr/local/bin && ln -sf " & quoted form of ${asString(script)} & " ${COMMAND_LINK}" ` +
    `with prompt "Frost wants to add the frost command to /usr/local/bin." with administrator privileges`;
  execFile('/usr/bin/osascript', ['-e', script_], (err) => {
    if (!err) return done();
    // -128: the password prompt was cancelled, which is an answer, not an error
    if (/-128/.test(String(err.message))) return;
    say("The 'frost' command couldn't be installed", String(err.message).trim(), 'error');
  });
}

// Windows runs with no menu at all, so every Ctrl key reaches the shell. A Mac
// app without a menu loses Cmd+Q, Cmd+H and Cmd+C/V (copy and paste are menu
// roles here). Its shortcuts are all on Cmd, which shells never see, so a small
// menu takes nothing from the terminal. No reload and no Cmd+W: Frost keeps
// those decisions in its own key table.
function applicationMenu() {
  return Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: "Install 'frost' Command…", click: installShellCommand },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'front' }]
    }
  ]);
}

Object.assign(module.exports, {
  identifySourceBuild,
  homeDir,
  isPortableBuild,
  applicationMenu,
  installShellCommand
});
