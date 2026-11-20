// Everything Frost needs from the operating system that differs between them:
// which shells exist and how to hook their prompt, the desktop wallpaper behind
// a glass window, installed fonts, process start times, where editors live.
// Features ask this module, never a platform folder directly, so another OS is
// a sibling of win32/ exporting the same names.
//
// Only Windows exists so far.
module.exports = require('./win32');
