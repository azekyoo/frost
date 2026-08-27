// The command palette, which doubles as the shortcut reference.

// ---------- command palette ----------
// Doubles as the shortcut reference: every command shows the key it answers to,
// which is why the defaults don't need to be duplicated into a config file.

const palette = { items: [], index: 0, returnTo: null };

function paletteItems() {
  // tab.go / tab.newProfile take an index, so they're listed per tab / profile
  const items = commands
    .filter((c) => c.id !== 'tab.go' && c.id !== 'tab.newProfile')
    .map((c) => ({ label: c.label, command: c.id, args: null }));
  profiles.forEach((p, i) =>
    items.push({ label: `New tab: ${p.name}`, command: 'tab.newProfile', args: { index: i + 1 } })
  );
  state.tabs.forEach((t, i) =>
    items.push({ label: `Go to tab ${i + 1}: ${t.title}`, command: 'tab.go', args: { index: i + 1 } })
  );
  return items;
}

// subsequence match: "ndt" finds "New tab", "spr" finds "Split pane right"
function fuzzy(hay, needle) {
  if (!needle) return true;
  const h = hay.toLowerCase();
  let i = 0;
  for (const ch of needle.toLowerCase()) {
    if (ch === ' ') continue;
    i = h.indexOf(ch, i);
    if (i < 0) return false;
    i++;
  }
  return true;
}

function renderPalette() {
  const query = el.paletteInput.value.trim();
  palette.items = paletteItems().filter((it) => fuzzy(it.label, query));
  palette.index = Math.min(palette.index, Math.max(0, palette.items.length - 1));
  el.paletteList.replaceChildren(
    ...palette.items.map((it, i) => {
      const row = document.createElement('button');
      row.className = 'palette-item' + (i === palette.index ? ' selected' : '');
      const label = document.createElement('span');
      label.textContent = it.label;
      row.appendChild(label);
      const keys = keysFor(it.command, it.args);
      if (keys) {
        const kbd = document.createElement('em');
        kbd.textContent = keys;
        row.appendChild(kbd);
      }
      row.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        choosePalette(i);
      });
      return row;
    })
  );
  if (!palette.items.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No matching command';
    el.paletteList.appendChild(p);
  }
  el.paletteList.querySelector('.palette-item.selected')?.scrollIntoView({ block: 'nearest' });
}

function openPalette() {
  palette.returnTo = activePane();
  palette.index = 0;
  el.paletteInput.value = '';
  el.palette.classList.add('open');
  renderPalette();
  el.paletteInput.focus();
}

function closePalette() {
  el.palette.classList.remove('open');
  palette.returnTo?.term.focus();
}

function choosePalette(i) {
  const it = palette.items[i];
  if (!it) return;
  closePalette();
  runCommand(it.command, it.args);
}

function movePalette(delta) {
  if (!palette.items.length) return;
  palette.index = (palette.index + delta + palette.items.length) % palette.items.length;
  renderPalette();
}

el.paletteInput.addEventListener('input', () => {
  palette.index = 0;
  renderPalette();
});

el.paletteInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowDown') movePalette(1);
  else if (ev.key === 'ArrowUp') movePalette(-1);
  else if (ev.key === 'Enter') choosePalette(palette.index);
  else if (ev.key === 'Escape') closePalette();
  else return;
  ev.preventDefault();
});

el.palette.addEventListener('mousedown', (ev) => {
  if (ev.target === el.palette) closePalette();
});

window.addEventListener('focus', () => document.body.classList.add('win-focused'));
window.addEventListener('blur', () => document.body.classList.remove('win-focused'));
if (document.hasFocus()) document.body.classList.add('win-focused');

function inTextField() {
  const t = document.activeElement;
  return t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
}

window.addEventListener('keydown', (ev) => {
  // typing in the search box or palette: only modified keys count as shortcuts
  if (inTextField() && !ev.ctrlKey && !ev.altKey && !ev.metaKey) return;
  const action = matchShortcut(ev);
  if (action) {
    ev.preventDefault();
    ev.stopPropagation();
    action();
  }
});

api.onKeysChanged(({ keys, error }) => {
  if (error) {
    toast(error, { error: true });
    return;
  }
  buildKeymap(keys);
  toast('Keybindings reloaded');
});
