// The shells Frost knows how to start, and the menu that lists them.

// ---------- shell profiles ----------

let profiles = []; // [{ id, name, agentWrapper }] — from theme.json, detected on first run

// Agent mode needs a shell we can inject the `claude` wrapper into; cmd/WSL
// can't host it, so agent tabs fall back to the first shell that can.
function agentProfileId() {
  const def = profiles.find((p) => p.id === state.theme?.defaultProfile);
  if (def && def.agentWrapper !== 'none') return def.id;
  return profiles.find((p) => p.agentWrapper !== 'none')?.id;
}

function closeProfileMenu() {
  el.profileMenu.classList.remove('open');
}

function openProfileMenu(anchor) {
  if (el.profileMenu.classList.contains('open')) {
    closeProfileMenu();
    return;
  }
  el.profileMenu.replaceChildren(
    ...profiles.map((p, i) => {
      const item = document.createElement('button');
      item.className = 'menu-item';
      const name = document.createElement('span');
      name.textContent = p.name;
      item.appendChild(name);
      if (i < 9) {
        const kbd = document.createElement('em');
        kbd.textContent = `Ctrl+Shift+${i + 1}`;
        item.appendChild(kbd);
      }
      item.addEventListener('click', () => {
        closeProfileMenu();
        newTab({ profileId: p.id });
      });
      return item;
    })
  );
  if (!profiles.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No profiles — check theme.json';
    el.profileMenu.appendChild(p);
  }
  const r = anchor.getBoundingClientRect();
  el.profileMenu.style.left = Math.round(r.left) + 'px';
  el.profileMenu.style.top = Math.round(r.bottom + 4) + 'px';
  el.profileMenu.classList.add('open');
}

window.addEventListener('mousedown', (ev) => {
  if (!el.profileMenu.contains(ev.target) && ev.target.id !== 'btn-newtab-menu') closeProfileMenu();
});
