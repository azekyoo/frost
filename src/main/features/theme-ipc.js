const { app, ipcMain, shell } = require('electron');
const fs = require('fs');

const { CSS_FILE, KEYS_FILE, THEME_FILE } = require('../env');
const { DEFAULT_THEME, readCss, readKeys, readTheme } = require('./config');
const { SPARE_REFILL_MS } = require('./pty/spare-timing');
const { fillSpares } = require('./pty/spares');
const { windowOf } = require('./windows/registry');
const { takeStartupLaunch } = require('./launch');

ipcMain.handle('theme:get', (event) => {
  const launch = takeStartupLaunch();
  return {
    theme: readTheme() || DEFAULT_THEME,
    css: readCss(),
    frameless: Boolean(windowOf(event)?.isFramelessMode),
    home: app.getPath('home'),
    launch
  };
});

ipcMain.handle('theme:save', (_e, theme) => {
  fs.writeFileSync(THEME_FILE, JSON.stringify(theme, null, 2));
  fillSpares(SPARE_REFILL_MS); // started under the old settings: retired
  return true;
});

ipcMain.handle('keys:get', () => readKeys() || []);

ipcMain.on('theme:openFile', (_e, which) => {
  shell.openPath(which === 'css' ? CSS_FILE : which === 'keys' ? KEYS_FILE : THEME_FILE);
});

Object.assign(module.exports, {

});
