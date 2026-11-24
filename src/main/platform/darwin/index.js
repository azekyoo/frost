// macOS: the same names as ../win32/index.js, so features never know which one
// they got.

// Before anything looks a program up: a packaged app started from Finder has
// to borrow the user's PATH first (see login-path.js).
require('./login-path').adoptLoginShellPath();

module.exports = {
  ...require('./shells'),
  ...require('./shell-integration'),
  ...require('./wallpaper'),
  ...require('./fonts'),
  ...require('./processes'),
  ...require('./editor'),
  ...require('./window-chrome'),
  ...require('./app')
};
