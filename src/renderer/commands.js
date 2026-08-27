// Everything a key can do: how keys are named and matched, the commands they
// run, the bindings themselves, and the modal used for a question that must not
// be missed.

// ---------- keys ----------
// Bindings are matched on physical key position (ev.code), so they land in the
// same place on every keyboard layout. config/keybindings.json overrides them.

const KEY_ALIASES = {
  Equal: '=',
  NumpadAdd: '=',
  Minus: '-',
  NumpadSubtract: '-',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Backquote: '`',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Space: 'space',
  Enter: 'enter',
  NumpadEnter: 'enter',
  Tab: 'tab',
  Escape: 'escape',
  Backspace: 'backspace',
  Delete: 'delete',
  Insert: 'insert',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down'
};

const NAME_ALIASES = {
  control: 'ctrl',
  esc: 'escape',
  del: 'delete',
  return: 'enter',
  plus: '=',
  add: '=',
  minus: '-',
  subtract: '-',
  arrowleft: 'left',
  arrowright: 'right',
  arrowup: 'up',
  arrowdown: 'down'
};

function keyName(code) {
  if (KEY_ALIASES[code]) return KEY_ALIASES[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code.toLowerCase();
  return null;
}

function eventKeys(ev) {
  const name = keyName(ev.code);
  if (!name) return null;
  const parts = [];
  if (ev.ctrlKey) parts.push('ctrl');
  if (ev.altKey) parts.push('alt');
  if (ev.shiftKey) parts.push('shift');
  if (ev.metaKey) parts.push('meta');
  parts.push(name);
  return parts.join('+');
}

function normalizeKeys(str) {
  const raw = String(str || '')
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => NAME_ALIASES[p] || p);
  const key = raw.pop();
  const parts = ['ctrl', 'alt', 'shift', 'meta'].filter((m) => raw.includes(m));
  parts.push(key);
  return parts.join('+');
}

// ---------- commands ----------

const commands = [];
const commandsById = new Map();

function cmd(id, label, run) {
  const c = { id, label, run };
  commands.push(c);
  commandsById.set(id, c);
}

function cycleTab(dir) {
  if (state.tabs.length < 2) return;
  const i = state.tabs.indexOf(state.activeTab);
  activateTab(state.tabs[(i + dir + state.tabs.length) % state.tabs.length]);
}

function activePane() {
  const tab = state.activeTab;
  if (!tab) return null;
  if (tab.kind === 'agents') return [...tab.centerLeaves].find((l) => l.el.style.display !== 'none') || null;
  return tab.activePane;
}

// Geometric pane navigation: works for any split tree, unlike walking the tree,
// because what "left" means on screen is a question about rectangles.
function focusDirection(dir) {
  // Moving to a pane covered by the zoomed one: the zoom is the thing being
  // left, so it ends here rather than focusing something invisible.
  unzoom(state.activeTab);
  const tab = state.activeTab;
  if (!tab || !tab.root || tab.kind === 'agents') return;
  const cur = tab.activePane;
  if (!cur) return;
  const a = cur.el.getBoundingClientRect();
  const horizontal = dir === 'left' || dir === 'right';
  let best = null;
  let bestGap = Infinity;
  for (const leaf of allLeaves(tab.root)) {
    if (leaf === cur) continue;
    const b = leaf.el.getBoundingClientRect();
    // must overlap on the other axis, else it isn't "beside" the current pane
    const overlaps = horizontal
      ? b.bottom > a.top + 1 && b.top < a.bottom - 1
      : b.right > a.left + 1 && b.left < a.right - 1;
    if (!overlaps) continue;
    const gap =
      dir === 'left' ? a.left - b.right
      : dir === 'right' ? b.left - a.right
      : dir === 'up' ? a.top - b.bottom
      : b.top - a.bottom;
    if (gap < -1 || gap >= bestGap) continue;
    best = leaf;
    bestGap = gap;
  }
  if (best) focusPane(best);
}

let bootFontSize = null;

function setFontSize(px) {
  const t = state.theme;
  if (!t) return;
  t.font = t.font || {};
  t.font.size = Math.min(28, Math.max(8, px));
  applyTheme(t, undefined);
  saveTheme();
}

cmd('window.new', 'New window', () => api.winNew());
cmd('tab.new', 'New tab', () => newTab());
cmd('tab.newProfile', 'New tab: Nth shell profile', ({ index, profile }) => {
  const p = profile ? profiles.find((x) => x.id === profile) : profiles[(index || 1) - 1];
  if (p) newTab({ profileId: p.id });
});
cmd('tab.duplicate', 'Duplicate tab (same shell and directory)', () => {
  const pane = activePane();
  if (pane) newTab({ profileId: pane.profileId, cwd: pane.cwd });
});
cmd('tab.agent', 'New agent tab', () => newAgentTab());
cmd('tab.close', 'Close tab', () => state.activeTab && closeTab(state.activeTab));
cmd('tab.rename', 'Rename tab', () => state.activeTab && startTabRename(state.activeTab));
cmd('tab.detach', 'Move tab to a new window', () => state.activeTab && detachTab(state.activeTab));
cmd('tab.next', 'Next tab', () => cycleTab(1));
cmd('tab.prev', 'Previous tab', () => cycleTab(-1));
cmd('tab.go', 'Go to tab N', ({ index }) => {
  const t = state.tabs[(index || 1) - 1];
  if (t) activateTab(t);
});
cmd('tab.last', 'Go to last tab', () => {
  if (state.tabs.length) activateTab(state.tabs[state.tabs.length - 1]);
});
cmd('shell.menu', 'Choose a shell profile…', () => openProfileMenu(document.getElementById('btn-newtab-menu')));

cmd('pane.splitRight', 'Split pane right', () => splitPane('row'));
cmd('pane.splitDown', 'Split pane down', () => splitPane('col'));
cmd('pane.close', 'Close pane', () => {
  const tab = state.activeTab;
  if (!tab) return;
  if (tab.activePane) removePane(tab.activePane);
  else closeTab(tab); // agent tabs have no pane tree to close into
});
cmd('pane.zoom', 'Zoom pane (hide the others in this tab)', () => toggleZoom());
cmd('pane.resizeLeft', 'Move the pane edge left', () => resizePane('left'));
cmd('pane.resizeRight', 'Move the pane edge right', () => resizePane('right'));
cmd('pane.resizeUp', 'Move the pane edge up', () => resizePane('up'));
cmd('pane.resizeDown', 'Move the pane edge down', () => resizePane('down'));
cmd('pane.focusLeft', 'Focus pane left', () => focusDirection('left'));
cmd('pane.focusRight', 'Focus pane right', () => focusDirection('right'));
cmd('pane.focusUp', 'Focus pane up', () => focusDirection('up'));
cmd('pane.focusDown', 'Focus pane down', () => focusDirection('down'));

cmd('font.zoomIn', 'Terminal font bigger', () => setFontSize((state.theme?.font?.size || 14) + 1));
cmd('font.zoomOut', 'Terminal font smaller', () => setFontSize((state.theme?.font?.size || 14) - 1));
cmd('font.zoomReset', 'Reset terminal font size', () => setFontSize(bootFontSize || 14));

// Whole-UI zoom, remembered by the main process against the monitor the window
// is on: the size that suits a laptop panel is not the size that suits a 4K
// screen at arm's length, and the two should not have to be reconciled.
const zoomStep = async (dir) => {
  const factor = await api.zoomStep(dir);
  toast(`Zoom ${Math.round(factor * 100)}% on this screen`);
};
cmd('view.zoomIn', 'Zoom in', () => zoomStep(1));
cmd('view.zoomOut', 'Zoom out', () => zoomStep(-1));
cmd('view.zoomReset', 'Reset zoom', () => zoomStep(0));

cmd('view.search', 'Find in buffer', () => {
  const pane = activePane();
  if (pane) openPaneSearch(pane);
});
cmd('view.clear', 'Clear buffer', () => {
  const pane = activePane();
  if (pane) pane.term.clear();
});
cmd('command.previous', 'Jump to previous command', () => jumpToMark(activePane(), -1));
cmd('command.next', 'Jump to next command', () => jumpToMark(activePane(), 1));
cmd('command.copyOutput', "Copy the last command's output", () => {
  const node = activePane();
  if (!node) return;
  const text = selectCommandOutput(node);
  if (text === null) return;
  navigator.clipboard.writeText(text);
  const lines = text ? text.split('\n').length : 0;
  toast(`Copied ${lines} line${lines === 1 ? '' : 's'}`);
});
cmd('command.selectOutput', "Select the last command's output", () => {
  const node = activePane();
  if (node) selectCommandOutput(node);
});
cmd('view.selectAll', 'Select everything in this pane', () => {
  const node = activePane();
  if (!node) return;
  node.term.selectAll();
  node.term.focus();
});
cmd('view.scrollToTop', 'Scroll to top', () => activePane()?.term.scrollToTop());
cmd('view.scrollToBottom', 'Scroll to bottom', () => activePane()?.term.scrollToBottom());

cmd('app.checkUpdate', 'Check for updates', async () => {
  if (!el.settings.classList.contains('open')) toggleSettings();
  renderUpdate({ ...(updateState || {}), stage: 'checking' });
  updateState = await api.updateCheck();
  renderUpdate(updateState);
});
cmd('app.settings', 'Settings', () => toggleSettings());
cmd('app.palette', 'Command palette', () => openPalette());
cmd('app.openKeys', 'Edit keybindings.json', () => api.themeOpenFile('keys'));
cmd('app.openTheme', 'Edit theme.json', () => api.themeOpenFile('json'));
cmd('app.openCss', 'Edit theme.css', () => api.themeOpenFile('css'));

// ---------- bindings ----------

const DEFAULT_BINDINGS = [
  { keys: 'ctrl+shift+t', command: 'tab.new' },
  { keys: 'ctrl+shift+n', command: 'window.new' },
  { keys: 'ctrl+shift+a', command: 'tab.agent' },
  { keys: 'ctrl+shift+d', command: 'tab.duplicate' },
  { keys: 'ctrl+shift+w', command: 'pane.close' },
  { keys: 'ctrl+tab', command: 'tab.next' },
  { keys: 'ctrl+shift+tab', command: 'tab.prev' },
  { keys: 'ctrl+9', command: 'tab.last' },
  { keys: 'alt+shift+=', command: 'pane.splitRight' },
  { keys: 'alt+shift+-', command: 'pane.splitDown' },
  { keys: 'alt+shift+z', command: 'pane.zoom' },
  { keys: 'alt+shift+left', command: 'pane.resizeLeft' },
  { keys: 'alt+shift+right', command: 'pane.resizeRight' },
  { keys: 'alt+shift+up', command: 'pane.resizeUp' },
  { keys: 'alt+shift+down', command: 'pane.resizeDown' },
  { keys: 'alt+left', command: 'pane.focusLeft' },
  { keys: 'alt+right', command: 'pane.focusRight' },
  { keys: 'alt+up', command: 'pane.focusUp' },
  { keys: 'alt+down', command: 'pane.focusDown' },
  { keys: 'ctrl+=', command: 'view.zoomIn' },
  { keys: 'ctrl+shift+=', command: 'view.zoomIn' },
  { keys: 'ctrl+-', command: 'view.zoomOut' },
  { keys: 'ctrl+0', command: 'view.zoomReset' },
  { keys: 'ctrl+,', command: 'app.settings' },
  { keys: 'ctrl+f', command: 'view.search' },
  { keys: 'ctrl+shift+k', command: 'view.clear' },
  { keys: 'ctrl+shift+up', command: 'command.previous' },
  { keys: 'ctrl+shift+down', command: 'command.next' },
  { keys: 'ctrl+shift+o', command: 'command.copyOutput' },
  { keys: 'ctrl+shift+p', command: 'app.palette' },
  // Ctrl+1..8 pick a tab, Ctrl+Shift+1..9 open the Nth shell profile
  ...Array.from({ length: 8 }, (_, i) => ({
    keys: `ctrl+${i + 1}`,
    command: 'tab.go',
    args: { index: i + 1 }
  })),
  ...Array.from({ length: 9 }, (_, i) => ({
    keys: `ctrl+shift+${i + 1}`,
    command: 'tab.newProfile',
    args: { index: i + 1 }
  }))
];

let keymap = new Map(); // 'ctrl+shift+t' -> { command, args }

function buildKeymap(user = []) {
  const m = new Map();
  for (const b of DEFAULT_BINDINGS) m.set(normalizeKeys(b.keys), { command: b.command, args: b.args });
  for (const b of user) {
    if (!b || !b.keys) continue;
    const k = normalizeKeys(b.keys);
    // command: null unbinds the key entirely
    if (!b.command || b.command === 'none') m.delete(k);
    else m.set(k, { command: b.command, args: b.args });
  }
  keymap = m;
}

function keysFor(commandId, args) {
  const want = JSON.stringify(args ?? null);
  for (const [k, b] of keymap) {
    if (b.command !== commandId) continue;
    if (JSON.stringify(b.args ?? null) !== want) continue;
    return k;
  }
  return null;
}

function runCommand(id, args) {
  const c = commandsById.get(id);
  if (!c) {
    toast('Unknown command: ' + id, { error: true });
    return;
  }
  c.run(args || {});
}

function matchShortcut(ev) {
  const k = eventKeys(ev);
  if (!k) return null;
  const b = keymap.get(k);
  return b ? () => runCommand(b.command, b.args) : null;
}

buildKeymap();

// ---------- modal ----------
// For the rare question that must not be missed. A toast was wrong for this:
// it faded after a couple of seconds and the setting looked broken.

const modal = {
  root: document.getElementById('modal'),
  title: document.querySelector('#modal .modal-title'),
  detail: document.querySelector('#modal .modal-detail'),
  note: document.querySelector('#modal .modal-note'),
  confirm: document.querySelector('#modal .modal-confirm'),
  later: document.querySelector('#modal .modal-later')
};

function closeModal() {
  modal.root.classList.remove('open');
  activePane()?.term.focus();
}

function askModal({ title, detail, note, confirmLabel = 'Restart now', cancelLabel = 'Later' }, onConfirm) {
  modal.title.textContent = title;
  modal.detail.textContent = detail;
  modal.note.textContent = note || '';
  modal.note.style.display = note ? '' : 'none';
  modal.confirm.textContent = confirmLabel;
  // "Later" is right for a restart that can wait and wrong for a paste, which
  // either happens now or does not happen
  modal.later.textContent = cancelLabel;
  modal.root.classList.add('open');
  modal.confirm.focus();
  modal.onConfirm = onConfirm;
}

modal.confirm.addEventListener('click', () => {
  const run = modal.onConfirm;
  closeModal();
  run?.();
});
modal.later.addEventListener('click', closeModal);
modal.root.addEventListener('mousedown', (ev) => {
  if (ev.target === modal.root) closeModal();
});
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && modal.root.classList.contains('open')) {
    ev.preventDefault();
    closeModal();
  }
});

api.onNeedsRestart((info) => askModal(info, () => api.appRelaunch()));
