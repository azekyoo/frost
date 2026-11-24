// ---------- the tab's own menu ----------

function closeTabMenu() {
  closeSurface(el.tabMenu);
}

function openTabMenu(tab, x, y) {
  const items = [
    { label: 'Rename…', run: () => startTabRename(tab) },
    {
      label: 'Duplicate',
      run: () => {
        const pane = tab.activePane || firstLeaf(tab.root);
        newTab({ profileId: pane?.profileId, cwd: pane?.cwd });
      }
    },
    { label: 'Move to a new window', run: () => detachTab(tab) },
    { label: 'Close', run: () => closeTab(tab) }
  ];
  if (tab.kind === 'agents') items.splice(1, 1); // one per app: no duplicate
  openMenu(items, x, y);
}

// The one floating menu: a tab's, or an agent's in the rail. `sep` draws a
// divider before an item; `disabled` shows it greyed out with its `title`
// saying why.
function openMenu(items, x, y) {
  el.tabMenu.replaceChildren(
    ...items.flatMap(({ label, run, sep, disabled, title }) => {
      const item = document.createElement('button');
      item.className = 'menu-item';
      item.disabled = Boolean(disabled);
      if (title) item.title = title;
      const name = document.createElement('span');
      name.textContent = label;
      item.appendChild(name);
      item.addEventListener('click', () => {
        closeTabMenu();
        run();
      });
      if (!sep) return [item];
      const line = document.createElement('div');
      line.className = 'menu-sep';
      return [line, item];
    })
  );
  el.tabMenu.classList.add('open');
  // Placed after it is measurable, and pulled back inside the window if the
  // click was near the right edge
  const r = el.tabMenu.getBoundingClientRect();
  el.tabMenu.style.left = Math.round(Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  el.tabMenu.style.top = Math.round(y + 4) + 'px';
}

window.addEventListener('mousedown', (ev) => {
  if (!el.tabMenu.contains(ev.target)) closeTabMenu();
});

