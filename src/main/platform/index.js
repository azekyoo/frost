// Everything Frost needs from the operating system that differs between them:
// which shells exist and how to hook their prompt, the desktop wallpaper behind
// a glass window, installed fonts, process start times, where editors live.
// Features ask this module, never a platform folder directly, so another OS is
// a sibling of win32/ exporting the same names.
//
// macOS gets darwin/; every other platform loads win32/ exactly as before.
module.exports = process.platform === 'darwin' ? require('./darwin') : require('./win32');
