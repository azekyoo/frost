// ---------- file ----------

function peekLanguage(name) {
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.split('.').pop() : lower; // Makefile, Dockerfile
  return hljs.getLanguage(ext) ? ext : null;
}

// Uncommitted changes drawn as the diff panel draws them: added (and changed)
// lines tinted green, a red notch where lines were taken out.
function peekDrawMarks(marks, count, lh) {
  const layer = peek.root.querySelector('.peek-marks');
  const out = [];
  for (const [from, to] of marks?.added || []) {
    const end = Math.min(to, count);
    if (from > end) continue;
    const band = document.createElement('div');
    band.className = 'peek-add';
    band.style.top = PEEK_PAD + (from - 1) * lh + 'px';
    band.style.height = (end - from + 1) * lh + 'px';
    out.push(band);
  }
  for (const { after, count: gone } of marks?.deleted || []) {
    const notch = document.createElement('div');
    notch.className = 'peek-del';
    notch.style.top = PEEK_PAD + Math.min(after, count) * lh + 'px';
    notch.title = gone === 1 ? '1 line deleted' : `${gone} lines deleted`;
    out.push(notch);
  }
  layer.replaceChildren(...out);
}

// ---------- minimap ----------
// The whole file squeezed into the strip's height, so its shape and where the
// changes sit can be read at a glance. Lines are drawn as bars by indent and
// length, not as text: at a pixel or two a line, text is noise.
const PEEK_MINI_COLS = 120; // columns the strip's width stands for
const PEEK_MINI_MAX_LINE = 3; // px per line when the file is short

function peekDrawMini() {
  const m = peek.mini;
  const box = peek.root?.querySelector('.peek-mini');
  if (!m || !box || box.hidden) return;
  const canvas = box.querySelector('canvas');
  const w = box.clientWidth;
  const h = box.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  m.lineH = Math.min(PEEK_MINI_MAX_LINE, h / m.count);
  const barH = Math.max(m.lineH * 0.7, 0.5);
  const colW = (w - 12) / PEEK_MINI_COLS;
  const css = getComputedStyle(peek.root);
  const fg = css.getPropertyValue('--fg').trim() || '#ffffff';

  for (const [from, to] of m.marks?.added || []) {
    const end = Math.min(to, m.count);
    if (from > end) continue;
    const y = (from - 1) * m.lineH;
    const hh = Math.max((end - from + 1) * m.lineH, 2);
    ctx.fillStyle = 'rgba(32, 224, 112, 0.22)';
    ctx.fillRect(0, y, w, hh);
    ctx.fillStyle = 'rgba(32, 224, 112, 0.9)';
    ctx.fillRect(0, y, 3, hh);
  }

  ctx.globalAlpha = 0.32;
  ctx.fillStyle = fg;
  for (let i = 0; i < m.count; i++) {
    const text = m.lines[i] || '';
    const len = Math.min(PEEK_MINI_COLS, text.replace(/\t/g, '    ').trimEnd().length);
    if (!len) continue;
    const indent = Math.min(len, text.replace(/\t/g, '    ').search(/\S/));
    ctx.fillRect(6 + indent * colW, i * m.lineH, (len - indent) * colW, barH);
  }
  ctx.globalAlpha = 1;

  ctx.fillStyle = 'rgba(255, 59, 78, 0.95)';
  for (const { after } of m.marks?.deleted || []) {
    ctx.fillRect(0, Math.min(after, m.count) * m.lineH - 1, w, 2);
  }
  if (m.line) {
    ctx.fillStyle = css.getPropertyValue('--accent').trim() || '#7aa2f7';
    ctx.fillRect(0, (m.line - 1) * m.lineH, w, Math.max(m.lineH, 2));
  }
  // find matches, as ticks on the right edge: where in the file they are
  ctx.fillStyle = '#ffb84d';
  for (const l of peek.find?.lines || []) ctx.fillRect(w - 9, (l - 1) * m.lineH, 9, Math.max(m.lineH, 2));
  peekMiniView();
}

// the box around what the code view currently shows
function peekMiniView() {
  const m = peek.mini;
  if (!m?.lineH) return;
  const body = peek.root.querySelector('.peek-body');
  const view = peek.root.querySelector('.peek-mini-view');
  const first = Math.max(0, (body.scrollTop - PEEK_PAD) / m.lh);
  const shown = body.clientHeight / m.lh;
  view.style.top = first * m.lineH + 'px';
  view.style.height = Math.max(shown * m.lineH, 6) + 'px';
}

function peekRenderCode(name, text, line) {
  const root = peek.root;
  const size = state.theme?.font?.size || 14;
  const lh = Math.round(size * 1.5);
  root.style.setProperty('--peek-size', size + 'px');
  root.style.setProperty('--peek-lh', lh + 'px');
  root.style.setProperty('--peek-pad', PEEK_PAD + 'px');

  const code = root.querySelector('.peek-code code');
  const lang = text.length <= PEEK_HIGHLIGHT_MAX && peekLanguage(name);
  if (lang) code.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  else code.textContent = text;
  // a final newline ends the last line rather than starting another
  const count = Math.max(1, text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
  root.querySelector('.peek-gutter').textContent = Array.from({ length: count }, (_, i) => i + 1).join('\n');
  peekDrawMarks(peek.marks, count, lh);

  line = Math.min(count, Math.max(0, line || 0));
  const band = root.querySelector('.peek-band');
  band.hidden = !line;
  band.style.top = PEEK_PAD + (line - 1) * lh + 'px';
  const body = root.querySelector('.peek-body');
  // the line a third of the way down, so what leads up to it is in view too
  body.scrollTop = line ? Math.max(0, PEEK_PAD + (line - 1) * lh - body.clientHeight / 3) : 0;
  body.scrollLeft = 0;
  peek.mini = { lines: text.split('\n'), count, lh, line, marks: peek.marks, lineH: 0 };
  peekDrawMini();
}

// Markdown arrives from any repo and is drawn inside a window that can type
// into terminals, so what marked produces is sanitised before it lands: no
// scripts, handlers, forms or styles that could reach past the page.
function peekRenderMarkdown(text) {
  const md = peek.root.querySelector('.peek-md');
  const html = marked.parse(text, { gfm: true });
  md.innerHTML = DOMPurify.sanitize(html, {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe'],
    FORBID_ATTR: ['style']
  });
  // relative images are relative to the file, not to Frost's own page
  const base = 'file:///' + peekDirname(peek.file).replace(/\\/g, '/') + '/';
  for (const img of md.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (src && !/^[a-z][\w+.-]*:/i.test(src)) img.src = new URL(src, base).href;
  }
  // fenced code in the same colours as a source file
  for (const code of md.querySelectorAll('pre code')) {
    const lang = /\blanguage-([\w+-]+)/.exec(code.className)?.[1];
    if (lang && hljs.getLanguage(lang)) {
      code.innerHTML = hljs.highlight(code.textContent, { language: lang, ignoreIllegals: true }).value;
    }
  }
  // GitHub-style anchors, so a table of contents can jump
  for (const h of md.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    h.id = h.textContent.trim().toLowerCase().replace(/[^\w\- ]+/g, '').replace(/ /g, '-');
  }
  peek.root.querySelector('.peek-body').scrollTop = 0;
}

// A click in rendered markdown never navigates the window: web links go to the
// browser, links to other files open them here, anchors scroll.
function peekMdLink(ev) {
  const a = ev.target.closest('a[href]');
  if (!a) return;
  ev.preventDefault();
  const href = a.getAttribute('href');
  if (/^(https?|mailto):/i.test(href)) return api.openExternal(href);
  if (href.startsWith('#')) {
    peek.root.querySelector('.peek-md').querySelector('#' + CSS.escape(href.slice(1)))?.scrollIntoView();
    return;
  }
  if (/^[a-z][\w+.-]*:/i.test(href)) return; // other schemes: nothing safe to do
  let target = href.split('#')[0];
  try {
    target = decodeURIComponent(target);
  } catch {}
  if (target) peekPath({ cwd: peekDirname(peek.file), target });
}

// keepScroll: a live refresh, which must leave the reader where they were
function peekRenderFile(keepScroll) {
  const root = peek.root;
  const body = root.querySelector('.peek-body');
  const at = keepScroll ? { top: body.scrollTop, left: body.scrollLeft } : null;
  const has = !!peek.file;
  const isMd = has && PEEK_MD.test(peek.file);
  const preview = isMd && peek.mode === 'preview';
  root.querySelector('.peek-empty').hidden = has;
  root.querySelector('.peek-lines').hidden = !has || preview;
  root.querySelector('.peek-md').hidden = !preview;
  root.querySelector('.peek-mini').hidden = !has || preview;
  if (!has || preview) peek.mini = null;
  root.querySelector('.peek-modes').hidden = !isMd;
  root.querySelectorAll('.peek-mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === peek.mode));
  const canDir = !has && !!peek.tree?.root;
  const ed = root.querySelector('.peek-editor');
  ed.disabled = !has && !canDir;
  ed.querySelector('span').textContent = has ? 'Open in editor' : 'Open folder in editor';
  ed.title = has ? 'Open in editor (Ctrl+Shift+click)' : 'Open this folder in the editor';
  const rv = root.querySelector('.peek-reveal');
  rv.disabled = !has && !canDir;
  rv.querySelector('span').textContent = has ? 'Show in Explorer' : 'Open in Explorer';
  rv.title = has ? 'Show in File Explorer' : 'Open this folder in File Explorer';

  const name = has ? peek.file.split(/[\\/]/).pop() : '';
  // the tree already shows which file this is; without one, the name is all
  // there is to say where you are
  if (!peek.tree) {
    root.querySelector('.peek-root').textContent = name;
    root.querySelector('.peek-root').title = peek.file || '';
  }
  // where in the repo this file sits, folders dim and the file itself bright:
  // the tree can be scrolled away from it, and names repeat across folders
  const crumbs = root.querySelector('.peek-crumbs');
  const parts =
    has && peek.tree
      ? (peekInside(peek.file, peek.tree.root)
          ? peek.file.slice(peek.tree.root.replace(/[\\/]+$/, '').length + 1)
          : peek.file
        ).split(/[\\/]/)
      : [];
  crumbs.replaceChildren(
    ...parts.flatMap((part, i) => {
      const span = document.createElement('span');
      span.className = i === parts.length - 1 ? 'crumb file' : 'crumb';
      span.textContent = part;
      return i ? [Object.assign(document.createElement('i'), { textContent: '/' }), span] : [span];
    })
  );
  crumbs.title = peek.file || '';

  if (!has) {
    root.querySelector('.peek-code code').textContent = '';
    peek.find.bar.classList.remove('open'); // nothing left to search
    peekClearFind();
    return;
  }
  if (preview) peekRenderMarkdown(peek.text);
  else peekRenderCode(name, peek.text, peek.opts?.line);
  // another file (or the other view of this one) fades in; a reload of the same
  // one, which keeps its scroll, must not flicker
  if (!keepScroll && !reduceMotion.matches) {
    body.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: 'ease-out' }).id = 'motion-peek-file';
  }
  if (at) {
    body.scrollTop = at.top;
    body.scrollLeft = at.left;
    peekMiniView();
  }
  // an open find bar searches whatever is now on screen
  peekFindRun(false);
}

// The open file changed on disk (an agent writing to it): text, marks and the
// tree's badges brought up to date in place.
async function peekReload() {
  const file = peek.file;
  const res = await api.readPath({ cwd: peekDirname(file), target: file });
  // gone, or swapped for something unreadable: what is on screen stays
  if (peek.file !== file || typeof res?.text !== 'string') return;
  peek.text = res.text.replace(/\r\n?/g, '\n');
  peek.marks = res.marks || null;
  peekRenderFile(true);
  peekRefreshTree();
}

api.onPeekChanged((file) => {
  if (peek.root?.classList.contains('open') && peek.file && peekNorm(file) === peekNorm(peek.file)) peekReload();
});

function showPeek(opts, res) {
  const root = peek.root || (peek.root = peekBuild());
  if (!root.classList.contains('open')) peek.returnTo = document.activeElement;
  peek.opts = opts;
  peek.file = res?.path || null;
  // a CR left in would be drawn as a trailing space on every line
  peek.text = (res?.text || '').replace(/\r\n?/g, '\n');
  peek.marks = res?.marks || null;
  if (peek.file && peek.tree && peekInside(peek.file, peek.tree.root))
    peekLastFiles().set(peekNorm(peek.tree.root), peek.file);
  // markdown opens rendered, unless a line was asked for: that is the source
  peek.mode = opts?.line ? 'source' : 'preview';

  const ansi = state.theme?.terminal || {};
  for (const k of PEEK_ANSI) root.style.setProperty('--ansi-' + k, ansi[k] || '');

  root.classList.add('open');
  api.peekWatch(peek.file);
  peekRenderTree();
  peekRenderFile();
  peekSyncHome();
  root.querySelector('.peek-body').focus({ preventScroll: true });
}

function closePeek() {
  if (!peek.root?.classList.contains('open')) return;
  api.peekWatch(null);
  peek.find.bar.classList.remove('open');
  peekClearFind();
  // a large file is memory — let go of once it has faded out, not while it still shows
  closeSurface(peek.root, () => {
    peek.root.querySelector('.peek-code code').textContent = '';
    peek.root.querySelector('.peek-md').textContent = '';
    peek.text = '';
    peek.mini = null;
  });
  const back = peek.returnTo;
  peek.returnTo = null;
  if (back?.isConnected) back.focus();
}
