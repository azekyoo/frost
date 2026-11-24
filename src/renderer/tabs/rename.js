// ---------- renaming a tab ----------
// A tab says directory · branch, which is the right answer until several tabs
// are in the same repo — then the thing that tells them apart is what you are
// doing in each, and only you know that. A name typed here sticks until it is
// cleared, survives a restart, and travels with the tab to another window.

// A rename in progress is a DOM node living inside the strip, and the strip is
// rebuilt every time a pane reports a new title — which, with a claude session
// in a tab, is constantly. Removing a focused input fires blur, and blur is
// what commits the name, so a rebuild used to end the rename in the middle of a
// word and save whatever had been typed by then. A blur from an input that is
// no longer in the document is the rebuild talking, not the user: the box is
// carried into the new strip with its text and caret where they were, and only
// a blur from a box still on screen means the name is finished.
let renaming = null; // { tab, input, finish }
let rebuildingStrip = false;

function reapplyRename() {
  if (!renaming) return;
  // The tab was closed or handed to another window while its name was being
  // typed. There is nothing left to name, and the box must not outlive it.
  if (!state.tabs.includes(renaming.tab)) {
    const r = renaming;
    renaming = null;
    r.finish(false, { rerender: false });
    return;
  }
  const titleEl = tabElementOf(renaming.tab)?.querySelector('.title');
  if (!titleEl) return;
  const { input } = renaming;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  titleEl.replaceWith(input);
  input.focus();
  try {
    input.setSelectionRange(start, end);
  } catch {}
}

function startTabRename(tab) {
  // One name at a time, and settled first: committing the other one rebuilds
  // the strip, and the nodes looked up before that would be the old ones.
  if (renaming) renaming.finish(true);
  const node = tabElementOf(tab);
  const titleEl = node?.querySelector('.title');
  if (!titleEl || node.querySelector('.tab-rename')) return;
  const input = document.createElement('input');
  input.className = 'tab-rename';
  input.type = 'text';
  input.spellcheck = false;
  input.value = tabLabel(tab);
  input.title = 'Enter to name it, Esc to cancel, empty to go back to the live title';
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit, { rerender = true } = {}) => {
    if (done) return;
    done = true;
    if (renaming?.input === input) renaming = null;
    if (commit) {
      const value = input.value.trim().slice(0, 60);
      // Empty is not a name, it is "stop naming it": the live directory · branch
      // title comes back rather than the tab going blank.
      tab.customTitle = value && value !== tab.title ? value : null;
      saveSession();
    }
    if (rerender) renderTabs();
    activePane()?.term.focus();
  };
  renaming = { tab, input, finish };
  input.addEventListener('mousedown', (ev) => ev.stopPropagation());
  input.addEventListener('dblclick', (ev) => ev.stopPropagation());
  // Taking the input out of the document blurs it, and blur is what commits the
  // name — so a repaint would settle a name the user is still typing. Only a
  // blur that is not the repaint's doing means they have gone somewhere else.
  input.addEventListener('blur', () => {
    if (!rebuildingStrip) finish(true);
  });
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation(); // the window-level shortcut handler is not wanted here
    if (ev.key === 'Enter') {
      ev.preventDefault();
      finish(true);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      finish(false);
    }
  });
}

