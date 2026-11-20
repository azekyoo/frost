const { app } = require('electron');

// A run from source is launched by electron.exe, so Windows identifies the
// taskbar button as Electron's and paints Electron's logo whatever icon the
// window carries. An id of its own breaks that association and sends Windows
// back to the window icon, which is Frost's. Dev only — a packaged build is
// identified by its own executable and must stay that way: grouping it under an
// id of our choosing made Windows resolve the taskbar icon through that id and
// show Electron's logo (see the note in main.js).
function identifySourceBuild() {
  app.setAppUserModelId('dev.azekyoo.frost.source');
}

// Where a shell starts when nothing else says.
function homeDir() {
  return process.env.USERPROFILE;
}

// electron-builder's portable exe unpacks itself to a temp folder on every run
// and says so in this variable; it cannot update itself in place.
function isPortableBuild() {
  return Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
}

Object.assign(module.exports, {
  identifySourceBuild,
  homeDir,
  isPortableBuild
});
