const { execFile } = require('child_process');

// reg runs as a child process: waited on rather than blocked on, since every
// terminal's input and output passes through this process meanwhile
function regQuery(key) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (_err, stdout) =>
      resolve(stdout || '')
    );
  });
}

// The installed font families, for the font picker in settings.
async function listFonts() {
  const names = new Set();
  const hives = await Promise.all(
    ['HKLM', 'HKCU'].map((hive) => regQuery(hive + '\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'))
  );
  for (const stdout of hives) {
    for (const line of stdout.split(/\r?\n/)) {
      const m = /^\s{4}(.+?)\s+REG_SZ\s+/.exec(line);
      if (!m) continue;
      let name = m[1].replace(/\s*\([^)]*\)\s*$/, '').trim();
      name = name
        .replace(
          /\s+(Bold|Italic|Oblique|Light|SemiBold|Semibold|Medium|Black|Thin|ExtraLight|ExtraBold|Regular|Condensed|SemiLight)(\s+(Italic|Oblique))?$/i,
          ''
        )
        .trim();
      if (name) names.add(name);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

Object.assign(module.exports, {
  regQuery,
  listFonts
});
