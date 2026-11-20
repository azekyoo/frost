function attachDrop(node) {
  const paneEl = node.el;
  const over = (ev) => {
    // Without preventDefault the drop falls through to the document and Chromium
    // navigates the window to the file — every shell in the window goes with it.
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    paneEl.classList.add('drop-over');
  };
  paneEl.addEventListener('dragenter', over);
  paneEl.addEventListener('dragover', over);
  paneEl.addEventListener('dragleave', (ev) => {
    // dragleave also fires for every child the pointer crosses on its way in
    if (!paneEl.contains(ev.relatedTarget)) paneEl.classList.remove('drop-over');
  });
  paneEl.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    paneEl.classList.remove('drop-over');
    const text = await droppedText(ev.dataTransfer);
    if (text) typeInto(node, text);
    else toast('Nothing in that drop a terminal can use', { error: true });
  });
}

async function createPane(opts = {}) {
  const id = 'pane-' + ++paneCounter;
  const paneEl = document.createElement('div');
  paneEl.className = 'pane';
  // unpadded inner host: FitAddon measures the terminal's parent, and the
  // pane's padding must not count as usable space or bottom rows get clipped
  const hostEl = document.createElement('div');
  hostEl.className = 'term-host';
  paneEl.appendChild(hostEl);

  const theme = state.theme || {};
  const term = new Terminal({
    allowProposedApi: true, // unicode width API is gated behind this in xterm 6
    allowTransparency: true,
    scrollback: scrollbackFor(theme),
    fontFamily: theme.font?.family || 'Consolas, monospace',
    fontSize: theme.font?.size || 16,
    lineHeight: theme.font?.lineHeight || 1.15,
    // A transparent window is composited, and Chromium draws text into a
    // composited layer with grayscale antialiasing — never ClearType. Over a
    // photograph those soft edges read as mass, so the default sits below normal
    // rather than above it. Weight leaves the metrics alone either way, so
    // nothing reflows when it changes.
    fontWeight: theme.font?.weight ?? 350,
    fontWeightBold: theme.font?.weightBold ?? 'bold',
    cursorStyle: theme.cursor?.style || 'bar',
    cursorBlink: theme.cursor?.blink !== false,
    // Windows Terminal parity: builtin box/block glyphs, auto-contrast text
    customGlyphs: true,
    rescaleOverlappingGlyphs: true,
    minimumContrastRatio: theme.minContrast ?? 1,
    // xterm scrolls a whole row at a time by default, which reads as a jolt
    // rather than movement. A short animation is what every other Windows app
    // does, and Shift held down still jumps a screenful at a time.
    smoothScrollDuration: theme.scroll?.smoothMs ?? 90,
    scrollSensitivity: theme.scroll?.lines ?? 3,
    fastScrollSensitivity: theme.scroll?.fastLines ?? 10,
    // tell xterm the backend is Windows ConPTY so it applies its quirk handling
    windowsPty: { backend: 'conpty' },
    theme: xtermTheme(theme)
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  // Modern character widths (emoji = 2 cols). theme.unicodeVersion picks the
  // active table ('11' or '6') and hot-reloads for live A/B testing.
  // Never let a broken addon kill terminal creation.
  try {
    term.loadAddon(new Unicode11Addon.Unicode11Addon());
    term.unicode.activeVersion = state.theme?.unicodeVersion || '11';
  } catch (e) {
    window.__unicodeError = String(e && e.stack ? e.stack : e);
    console.error('unicode11 addon failed', e);
  }
  term.open(hostEl);

  const node = {
    type: 'leaf',
    id,
    ptyId: null,
    term,
    fit,
    webgl: null,
    el: paneEl,
    cwd: null,
    branch: null,
    oscTitle: null
  };
  watchGpu(node);
  applyLigatures(node, theme.font?.ligatures !== false);
  attachPaneSearch(node);
  attachCwdTracking(node);
  attachCommandMarks(node);
  attachCommandBlocks(node);
  attachLinks(node);
  attachDrop(node);
  attachTypingGlow(node);
  attachOscCopy(node);

  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    // shortcut executed by the window-level listener; just keep it away from the pty
    if (matchShortcut(ev)) return false;
    // clipboard — Windows Terminal behavior
    const ctrlOnly = ev.ctrlKey && !ev.shiftKey && !ev.altKey;
    if (ctrlOnly && ev.code === 'KeyC' && term.hasSelection()) {
      // copy instead of interrupt when text is selected
      navigator.clipboard.writeText(term.getSelection());
      glowCopy(node);
      term.clearSelection();
      return false;
    }
    if ((ctrlOnly || (ev.ctrlKey && ev.shiftKey)) && ev.code === 'KeyV') {
      // single controlled paste: preventDefault kills the browser's native
      // paste event, returning false keeps ^V away from the shell (PSReadLine
      // would paste on raw ^V too) — then paste exactly once ourselves
      ev.preventDefault();
      pasteInto(node);
      return false;
    }
    if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyC' && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection());
      glowCopy(node);
      return false;
    }
    return true;
  });

  // copy-on-select (debounced: selection changes continuously while dragging)
  let selTimer = null;
  term.onSelectionChange(() => {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      // no scan here: selecting isn't copying, to the eye, even when it fills
      // the clipboard — the scan is for a copy made on purpose
      if (state.theme?.copyOnSelect !== false && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection());
      }
    }, 150);
  });

  paneEl.addEventListener('mousedown', () => focusPane(node));
  paneEl.addEventListener('contextmenu', async (ev) => {
    ev.preventDefault();
    if (term.hasSelection()) {
      // scanned before the write: the selection it shows is gone after it
      glowCopy(node);
      await navigator.clipboard.writeText(term.getSelection());
      term.clearSelection();
    } else {
      pasteInto(node);
    }
  });

  const refit = debounce(() => {
    // offsetParent is null while display:none — fitting then would measure zero
    // and resize the pty twice for nothing, once on hide and once on show
    if (paneEl.isConnected && paneEl.offsetParent !== null) fit.fit();
  }, 30);
  new ResizeObserver(refit).observe(paneEl);

  term.onResize(({ cols, rows }) => {
    if (node.ptyId) api.ptyResize(node.ptyId, cols, rows);
  });

  // A tab moved from another window brings its shells with it: main hands over
  // ownership rather than starting anything, and the scrollback the old window
  // serialised is written back in. A shell that died in the gap adopts as null,
  // and the pane opens a fresh one in the same directory instead of sitting inert.
  const adopt = opts.adopt || null;
  const spawnOpts = { profileId: opts.profileId, cwd: opts.cwd, run: opts.run };
  const claimed = adopt ? await api.ptyAdopt(adopt.ptyId, term.cols, term.rows) : null;
  if (adopt && !claimed) toast('That shell had already exited — opened a new one', { error: true });
  const { id: ptyId, profileId, profileName } =
    claimed || (await api.ptyCreate(term.cols, term.rows, spawnOpts));
  if (claimed) {
    node.cwd = adopt.cwd || null;
    node.branch = adopt.branch || null;
    node.oscTitle = adopt.oscTitle || null;
    // Before the replayed output, which main is already sending: it belongs
    // after everything the old window had on screen.
    if (adopt.text) term.write(adopt.text);
  }
  node.ptyId = ptyId;
  node.profileId = profileId;
  node.profileName = profileName;
  // a shell moved here from another window is already up; anything new waits.
  // Attached before the pane is reachable by output, so none is missed.
  if (!claimed) {
    const dialect = profiles.find((p) => p.id === profileId)?.agentWrapper || 'none';
    attachLoading(node, { run: opts.run, marked: dialect !== 'none' });
  }
  panesByPty.set(ptyId, node);
  // Now that this pane is the one output for that shell reaches, anything it
  // said earlier can be let through: a shell started before the window asked for
  // it, or one that changed windows. Nothing is held for a shell started here,
  // so this is a no-op in the ordinary case.
  api.ptyFlush(ptyId);
  term.onData((d) => {
    // Enter starts the clock that the next prompt stops
    if (d.includes('\r')) node.enterAt = Date.now();
    api.ptyInput(ptyId, d);
  });

  term.onTitleChange((title) => {
    const t = (title || '').trim();
    // Titles that are just a path get dropped: that's ConPTY echoing the shell
    // command line, or a prompt theme naming the cwd — which we render better.
    node.oscTitle = t && !/^([A-Za-z]:[\\/]|\/|~[\\/])/.test(t) ? t : null;
    refreshPaneTitle(node);
  });

  return node;
}

function tabOfPane(node) {
  return state.tabs.find((t) => t.root && allLeaves(t.root).includes(node)) || null;
}

function renderNode(node) {
  if (node.type === 'leaf') return node.el;
  const wrap = document.createElement('div');
  wrap.className = 'split ' + node.dir;
  node.el = wrap;
  node.children.forEach((child, i) => {
    const childEl = renderNode(child);
    childEl.style.flex = `${node.sizes[i]} 1 0%`;
    wrap.appendChild(childEl);
    if (i < node.children.length - 1) {
      wrap.appendChild(makeDivider(node, i));
    }
  });
  return wrap;
}

function makeDivider(splitNode, index) {
  const d = document.createElement('div');
  d.className = 'divider';
  d.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    d.setPointerCapture(ev.pointerId);
    d.classList.add('dragging');
    const horizontal = splitNode.dir === 'row';
    const rect = splitNode.el.getBoundingClientRect();
    const total = horizontal ? rect.width : rect.height;
    const startPos = horizontal ? ev.clientX : ev.clientY;
    const a = splitNode.sizes[index];
    const b = splitNode.sizes[index + 1];
    const sum = splitNode.sizes.reduce((x, y) => x + y, 0);

    const move = (mv) => {
      const delta = ((horizontal ? mv.clientX : mv.clientY) - startPos) / total * sum;
      let na = Math.max(0.08, a + delta);
      let nb = Math.max(0.08, b - delta);
      const pairSum = a + b;
      if (na + nb !== pairSum) {
        if (na <= 0.08) nb = pairSum - na;
        else na = pairSum - nb;
      }
      splitNode.sizes[index] = na;
      splitNode.sizes[index + 1] = nb;
      const kids = [...splitNode.el.children].filter((c) => !c.classList.contains('divider'));
      kids[index].style.flex = `${na} 1 0%`;
      kids[index + 1].style.flex = `${nb} 1 0%`;
    };
    const up = () => {
      d.classList.remove('dragging');
      d.releasePointerCapture?.(ev.pointerId);
      d.removeEventListener('pointermove', move);
      d.removeEventListener('pointerup', up);
      saveSession();
    };
    d.addEventListener('pointermove', move);
    d.addEventListener('pointerup', up);
  });
  return d;
}

