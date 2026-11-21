const os = require('os');
const { app, Menu } = require('electron');

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
  applicationMenu
});
