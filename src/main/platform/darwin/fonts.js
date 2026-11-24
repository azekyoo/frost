const { execFile } = require('child_process');

// Not used on macOS; exported so the names match Windows.
const regQuery = async () => '';

// The installed font families, for the font picker in settings. system_profiler
// takes a few seconds, so it runs as a child process the main process waits on.
function listFonts() {
  return new Promise((resolve) => {
    execFile('/usr/sbin/system_profiler', ['SPFontsDataType', '-json', '-detailLevel', 'mini'],
      { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 60000 }, (_err, stdout) => {
        const names = new Set();
        try {
          for (const font of JSON.parse(stdout).SPFontsDataType || []) {
            for (const face of font.typefaces || []) if (face.family) names.add(face.family);
          }
        } catch {}
        // fonts whose family starts with a dot are the system's private ones
        resolve([...names].filter((n) => !n.startsWith('.')).sort((a, b) => a.localeCompare(b)));
      });
  });
}

Object.assign(module.exports, {
  regQuery,
  listFonts
});
