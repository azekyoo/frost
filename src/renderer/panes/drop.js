// ---------- dropping files and images on a pane ----------

// Windows Terminal parity: a file dragged onto a terminal types its path. The
// case that matters most here is an agent in the pane — claude reads an image
// off disk, so a screenshot dragged in from Explorer, dragged out of a browser,
// or pasted as a bitmap all have to arrive as a path on the prompt line.

function quotePath(p) {
  // macOS: a POSIX shell still expands $ and backticks inside double quotes,
  // and a filename may contain any of them, so single quotes, with a single
  // quote itself closed, escaped and reopened.
  if (IS_MAC) return /[^\w@%+=:,./-]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p;
  // The line goes to a shell, which splits it on spaces. A Windows filename
  // cannot contain a double quote, so wrapping is always enough.
  return /[\s'`&|;(){}\[\],]/.test(p) ? `"${p}"` : p;
}

function typeInto(node, text) {
  if (!text) return;
  focusPane(node);
  // paste() rather than input(): bracketed paste keeps a shell from acting on
  // it, and the trailing space separates one drop from the next
  node.term.paste(text + ' ');
  node.term.focus();
}

// Everything the drop carries has to be read before the first await —
// dataTransfer is emptied the moment the event handler returns.
async function droppedText(dt) {
  if (!dt) return '';
  const files = [...(dt.files || [])].map((f) => api.filePath(f)).filter(Boolean);
  if (files.length) return files.map(quotePath).join(' ');

  // Dragged out of a browser: a URL, sometimes only inside a fragment of HTML.
  // Downloading is worth it for an image and nothing else — any other link is
  // more useful on the prompt line as the link itself.
  const uri = (dt.getData('text/uri-list') || '')
    .split(/\r?\n/)
    .find((l) => l && !l.startsWith('#'));
  const html = dt.getData('text/html') || '';
  const plain = dt.getData('text/plain') || '';
  const src = uri || (/<img[^>]+src="([^"]+)"/i.exec(html) || [])[1] || '';
  if (src) {
    const saved = await api.imageFromUrl(src);
    if (saved) return quotePath(saved);
  }
  return plain || (src.startsWith('data:') ? '' : src);
}

