const { app, clipboard, ipcMain, net } = require('electron');
const fs = require('fs');
const path = require('path');

const { resolveTarget } = require('./paths');

// ---------- images dropped or pasted into a pane ----------

// A terminal carries text, so an image has to become a path before it can be
// handed to anything — and a path is what an agent in the pane wants anyway.
// A file dragged out of Explorer already has one; an image dragged out of a
// browser or pasted as a bitmap does not, so it is written here first and the
// path to that copy is what gets typed.
const IMAGE_DIR = path.join(app.getPath('temp'), 'frost-images');
const IMAGE_TTL = 24 * 60 * 60 * 1000;
const IMAGE_MAX = 32 * 1024 * 1024;
const IMAGE_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg'
};

function saveImage(buf, ext) {
  if (!buf || !buf.length || buf.length > IMAGE_MAX) return null;
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  // Nothing else ever deletes these and they are whole screenshots, so the
  // folder is swept on the way in rather than left to grow for the life of the
  // machine. A day is long enough that a path already typed into a prompt and
  // not yet sent still opens.
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(IMAGE_DIR)) {
      const stale = path.join(IMAGE_DIR, name);
      try {
        if (now - fs.statSync(stale).mtimeMs > IMAGE_TTL) fs.unlinkSync(stale);
      } catch {}
    }
  } catch {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const abs = path.join(IMAGE_DIR, `image-${stamp}${ext}`);
  fs.writeFileSync(abs, buf);
  return abs;
}

// An image dragged out of a browser arrives as a URL rather than a file. The
// renderer cannot fetch it — its CSP is default-src 'self', deliberately — so
// the download happens here, and only for what a drop could plausibly have
// produced: an image content type, at a size worth putting on a prompt line.
ipcMain.handle('image:fromUrl', async (_e, url) => {
  if (typeof url !== 'string' || url.length > 8192) return null;
  try {
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',');
      if (comma < 0) return null;
      const head = url.slice(0, comma);
      const mime = head.slice(5).split(';')[0].toLowerCase();
      if (!IMAGE_EXT[mime]) return null;
      const body = url.slice(comma + 1);
      const buf = /;base64/i.test(head)
        ? Buffer.from(body, 'base64')
        : Buffer.from(decodeURIComponent(body), 'utf8');
      return saveImage(buf, IMAGE_EXT[mime]);
    }
    if (!/^https?:\/\//i.test(url)) return null;
    const res = await net.fetch(url);
    if (!res.ok) return null;
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_EXT[mime]) return null;
    return saveImage(Buffer.from(await res.arrayBuffer()), IMAGE_EXT[mime]);
  } catch {
    return null;
  }
});

// Ctrl+V with a screenshot on the clipboard. Chromium's async clipboard API
// would need a permission prompt and misses formats Windows apps actually
// write; Electron's clipboard reads the same DIB the Snipping Tool puts there.
ipcMain.handle('image:fromClipboard', () => {
  try {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    return saveImage(img.toPNG(), '.png');
  } catch {
    return null;
  }
});

// The picture behind an image path hovered in a terminal. Sent as a data URL
// because the window's CSP allows no other image source — and drawn by an
// <img>, so an SVG shows as a picture and none of its script runs.
const PREVIEW_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.svg': 'image/svg+xml'
};
const PREVIEW_MAX = 20 * 1024 * 1024;

ipcMain.handle('image:preview', (_e, { cwd, target }) => {
  const abs = resolveTarget(cwd, target);
  const mime = abs && PREVIEW_MIME[path.extname(abs).toLowerCase()];
  if (!mime) return null;
  try {
    const bytes = fs.statSync(abs).size;
    if (bytes > PREVIEW_MAX) return { path: abs, bytes, tooBig: true };
    return { path: abs, bytes, src: `data:${mime};base64,` + fs.readFileSync(abs).toString('base64') };
  } catch {
    return null;
  }
});

Object.assign(module.exports, {
  IMAGE_DIR,
  IMAGE_TTL,
  IMAGE_MAX,
  IMAGE_EXT,
  saveImage,
  PREVIEW_MIME,
  PREVIEW_MAX
});
