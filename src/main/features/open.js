const { ipcMain, shell } = require('electron');

const { EDITOR_CANDIDATES, resolveExecutable } = require('../platform');
const { readTheme } = require('./config');

// ---------- opening things out of the terminal ----------
// Terminal output is untrusted: it's whatever a program, a repo, or a remote
// host printed. So nothing here is ever handed to a shell, and only schemes
// that can't launch a local handler are opened.

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

ipcMain.handle('shell:openExternal', async (_e, target) => {
  let url;
  try {
    url = new URL(String(target));
  } catch {
    return false;
  }
  // file:, and anything registered to an application (ms-msdt:, steam:, ...),
  // would turn a line of terminal output into a way to start a program
  if (!SAFE_SCHEMES.has(url.protocol)) return false;
  await shell.openExternal(url.href);
  return true;
});

let editorCache = null;

function resolveEditor() {
  const configured = readTheme()?.editor;
  if (typeof configured === 'string' && configured.trim()) {
    // split on whitespace, honouring "quoted paths with spaces"
    const parts = configured.match(/"[^"]+"|\S+/g) || [];
    if (parts.length) {
      const [name, ...args] = parts.map((p) => p.replace(/^"|"$/g, ''));
      // a template with no placeholder still needs the file appended
      if (!args.some((a) => a.includes('{file}'))) args.push('{file}');
      const exe = resolveExecutable(name);
      if (exe) return { exe, args };
      return false;
    }
  }
  if (editorCache !== null) return editorCache;
  editorCache = false;
  for (const candidate of EDITOR_CANDIDATES) {
    const exe = resolveExecutable(candidate.exe, candidate.app);
    if (exe) {
      editorCache = { exe, args: candidate.args };
      break;
    }
  }
  return editorCache;
}

Object.assign(module.exports, {
  SAFE_SCHEMES,
  resolveEditor
});
