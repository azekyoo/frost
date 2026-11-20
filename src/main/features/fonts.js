const { ipcMain } = require('electron');

const { listFonts } = require('../platform');

ipcMain.handle('fonts:list', () => listFonts());
