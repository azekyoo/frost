// ---------- shell dock ----------
// A shell under the diff, owned by a session: somewhere to run the tests or poke
// at the repo while the agent works, without leaving the view that shows what it
// changed. The owner is the session's center pane, which outlives a claude that
// restarts inside it. Switching session swaps the dock for that session's own
// shell, or puts it away; a shell out of sight keeps running, and comes back
// exactly as it was, at the height it was left at.

const DOCK_MIN = 110;
const DIFF_MIN_H = 140;

function dockLeafFor(tab, owner) {
  return [...(tab.dockLeaves || [])].find((l) => l.dockOwner === owner) || null;
}

function dockHostOf(leaf) {
  return agentTabs().find((t) => t.dockLeaves?.has(leaf)) || null;
}

// Stored as the user dragged it, per shell; a new shell starts at the last one
// dragged. Squeezed for display only when the window is too short to give the
// diff its minimum, so a taller window gives it back.
function applyDockHeight(tab) {
  if (!tab.els?.dock || tab.els.dock.hidden) return;
  const stored = tab.dockShown?.dockHeight ?? state.theme?.agentLayout?.dock ?? 260;
  const total = tab.els.side.clientHeight;
  const room = total ? total - DIFF_MIN_H - GUTTER : stored;
  const h = Math.max(DOCK_MIN, Math.min(stored, room));
  if (tab.appliedDock === h) return;
  tab.appliedDock = h;
  tab.els.dock.style.height = h + 'px';
}

async function openDockShell(tab, owner, cwd) {
  let leaf = dockLeafFor(tab, owner);
  if (!leaf) {
    leaf = await createPane({ cwd });
    // the session may have ended while the shell was starting
    if (!tab.centerLeaves.has(owner)) {
      destroyLeaf(leaf);
      return;
    }
    addDockLeaf(tab, leaf, owner, cwd);
  }
  leaf.dockAway = false;
  // switched away while it started: it waits for its session instead
  if (owner.el.style.display !== 'none') showDockLeaf(tab, leaf, { animate: true });
}

function addDockLeaf(tab, leaf, owner, cwd) {
  leaf.dockOwner = owner;
  leaf.dockCwd = cwd;
  // a failed command lights the dock's Send button; a passing one puts it out
  leaf.onCommandDone = (mark) => {
    leaf.dockFailed = mark.exit !== 0;
    if (tab.dockShown === leaf) renderDockSend(tab);
  };
  // and a selection turns it into "Send selection", which is what it will send
  leaf.term.onSelectionChange(() => {
    if (tab.dockShown === leaf) renderDockSend(tab);
  });
  leaf.el.classList.add('dock-pane');
  leaf.el.style.display = 'none';
  tab.dockLeaves.add(leaf);
  tab.els.dockBody.appendChild(leaf.el);
}

// The dock slides up out of the bottom of the column when its button opens it,
// and back down when it is closed, the diff above giving way as it goes. The
// shell inside is held at its final size throughout, so the terminal is fitted
// once rather than on every frame.
const DOCK_MOTION_MS = 200;

function stopDockSlide(tab) {
  tab.els.dock.getAnimations().forEach((a) => a.id === 'motion-dock' && a.cancel());
  tab.els.dock.classList.remove('sliding');
  tab.els.dock.style.removeProperty('--dock-full');
}

function slideDock(tab, open, done = () => {}) {
  const { dock, dockGutter } = tab.els;
  stopDockSlide(tab);
  const h = dock.offsetHeight;
  if (reduceMotion.matches || !h) return done();
  // header and shell are laid out at the dock's full height, pinned to its
  // bottom edge: the dock only uncovers them, so nothing inside ever moves
  dock.style.setProperty('--dock-full', h + 'px');
  dock.classList.add('sliding');
  // the gutter above it is folded away too, or the diff would jump by its height
  const shut = { height: '0px', marginTop: -dockGutter.offsetHeight + 'px', opacity: 0.3 };
  const full = { height: h + 'px', marginTop: '0px', opacity: 1 };
  const a = dock.animate(open ? [shut, full] : [full, shut], {
    duration: DOCK_MOTION_MS,
    easing: MOTION_EASE,
    fill: open ? 'none' : 'forwards'
  });
  a.id = 'motion-dock';
  a.finished.then(
    () => {
      if (open) stopDockSlide(tab);
      done();
      if (!open) stopDockSlide(tab);
    },
    // cut short by something else showing or hiding the dock: a close still closes
    () => !open && done()
  );
}

// animate: only when the button opens it. Coming back with its session, the
// shell simply is there, as it was left.
function showDockLeaf(tab, leaf, { focus = true, animate = false } = {}) {
  stopDockSlide(tab);
  for (const l of tab.dockLeaves) l.el.style.display = l === leaf ? '' : 'none';
  tab.dockShown = leaf;
  tab.els.dock.hidden = false;
  tab.els.dockGutter.hidden = false;
  gpuShowWithin(leaf.el);
  tab.els.dockName.textContent = String(leaf.dockCwd || '').split(/[\\/]/).pop() || 'Shell';
  tab.els.dockName.title = leaf.dockCwd || '';
  renderDockSend(tab);
  tab.appliedDock = null;
  applyDockHeight(tab);
  if (animate) slideDock(tab, true);
  requestAnimationFrame(() => {
    leaf.fit.fit();
    if (focus) leaf.term.focus();
  });
}

// Put away by its button: slides down and stays down, also when its session is
// switched away from and back, until the button brings it up again. The shell
// keeps running behind it, scrollback and all.
function putDockAway(tab, leaf) {
  leaf.dockAway = true;
  slideDock(tab, false, () => {
    // opened again before the slide finished: that wins
    if (!leaf.dockAway || tab.dockShown !== leaf) return;
    hideDock(tab);
    if (leaf.dockOwner?.el.style.display !== 'none') leaf.dockOwner?.term.focus();
  });
}

// Put away, not closed: every shell stays alive for its session to come back to
function hideDock(tab) {
  if (!tab.dockShown && tab.els.dock.hidden) return;
  stopDockSlide(tab);
  for (const l of tab.dockLeaves) l.el.style.display = 'none';
  tab.dockShown = null;
  tab.dockTyping = false;
  tab.els.dock.hidden = true;
  tab.els.dockGutter.hidden = true;
}

// The session on show decides what the dock holds
function syncDock(tab, centerLeaf) {
  if (!tab.dockLeaves) return;
  const found = dockLeafFor(tab, centerLeaf);
  const leaf = found?.dockAway ? null : found;
  if (leaf === tab.dockShown) return;
  if (leaf) showDockLeaf(tab, leaf, { focus: false });
  else hideDock(tab);
}

// kill: false for a shell that has already exited on its own. animate: closed
// from its button, so it slides away first (and still dies if anything else
// happens to the dock meanwhile).
function closeDockLeaf(tab, leaf, { kill = true, animate = false } = {}) {
  if (!tab.dockLeaves.has(leaf)) return;
  if (animate && tab.dockShown === leaf) {
    if (leaf.dockClosing) return;
    leaf.dockClosing = true;
    slideDock(tab, false, () => closeDockLeaf(tab, leaf, { kill }));
    return;
  }
  tab.dockLeaves.delete(leaf);
  if (kill) destroyLeaf(leaf);
  else {
    try {
      leaf.term.dispose();
    } catch {}
    leaf.el.remove();
  }
  if (tab.dockShown !== leaf) return;
  hideDock(tab);
  // the diff takes the whole column back, the session's pane the keyboard
  if (leaf.dockOwner?.el.style.display !== 'none') leaf.dockOwner?.term.focus();
}

function wireDockGutter(tab) {
  const gutter = tab.els.dockGutter;
  gutter.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    gutter.setPointerCapture(ev.pointerId);
    gutter.classList.add('dragging');
    const startY = ev.clientY;
    const startH = tab.els.dock.offsetHeight;
    const move = (mv) => {
      // the dock grows upwards, so dragging up makes it taller
      const room = tab.els.side.clientHeight - DIFF_MIN_H - GUTTER;
      const next = Math.max(DOCK_MIN, Math.min(room, startH + (startY - mv.clientY)));
      if (tab.dockShown) tab.dockShown.dockHeight = Math.round(next);
      state.theme.agentLayout = { ...state.theme.agentLayout, dock: Math.round(next) };
      tab.appliedDock = null;
      applyDockHeight(tab);
    };
    const up = () => {
      gutter.classList.remove('dragging');
      gutter.releasePointerCapture?.(ev.pointerId);
      gutter.removeEventListener('pointermove', move);
      gutter.removeEventListener('pointerup', up);
      saveTheme();
    };
    gutter.addEventListener('pointermove', move);
    gutter.addEventListener('pointerup', up);
  });
}

