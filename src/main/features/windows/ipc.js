const { dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const { CONFIG_DIR } = require('../../env');
const { createWindow } = require('./window');
const { windowOf } = require('./registry');
const { primaryWindow } = require('./registry');

ipcMain.handle('dialog:pickDir', async (event) => {
  const win = primaryWindow();
  const r = await dialog.showOpenDialog(windowOf(event) || win, { properties: ['openDirectory'] });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

ipcMain.on('diag:report', (_e, data) => {
  try {
    fs.writeFileSync(path.join(CONFIG_DIR, 'diag.json'), JSON.stringify(data, null, 2));
  } catch {}
});

ipcMain.on('win:minimize', (event) => windowOf(event)?.minimize());
ipcMain.on('win:maximize', (event) => {
  const w = windowOf(event);
  if (!w) return;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});
ipcMain.on('win:close', (event) => windowOf(event)?.close());
// The one accelerator worth keeping from the menu that was removed: it is not a
// key any shell wants, and having no way in to the developer tools would be a
// step back from what the default menu gave.
ipcMain.on('win:devtools', (event) => {
  const wc = windowOf(event)?.webContents;
  if (!wc) return;
  if (wc.isDevToolsOpened()) wc.closeDevTools();
  else wc.openDevTools({ mode: 'detach' }); // detached: docking it resizes the panes
});
ipcMain.on('win:new', () => createWindow());

Object.assign(module.exports, {

});
