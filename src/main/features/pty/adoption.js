const { ipcMain } = require('electron');

const { createWindow } = require('../windows/window');
const { detachedPtys, pendingAdoptions, ptyMeta, ptyOwners, ptys } = require('./registry');

// Called by the window giving the shell up, immediately before it disposes the
// terminal. Only its current owner may: otherwise any window could cut another
// window's pane loose.
ipcMain.on('pty:orphan', (event, { id }) => {
  if (ptyOwners.get(id) !== event.sender) return;
  ptyOwners.delete(id);
  detachedPtys.set(id, { chunks: [], bytes: 0 });
});

// The claim. A pty that still has an owner is never handed over — an ownerless
// one is either in flight or gone, and gone returns null so the caller can open
// a fresh shell instead of showing an inert pane.
ipcMain.handle('pty:adopt', (event, { id, cols, rows }) => {
  const p = ptys.get(id);
  const held = detachedPtys.get(id);
  if (!p || !held || ptyOwners.has(id)) return null;
  ptyOwners.set(id, event.sender);
  if (cols > 0 && rows > 0) {
    try {
      p.resize(cols, rows);
    } catch {}
  }
  // The replay waits for pty:flush, for the same reason it does when a warm
  // shell is claimed: this call has not returned yet, so the pane it belongs to
  // has not been wired up to receive anything.
  const meta = ptyMeta.get(id) || {};
  return { id, profileId: meta.profileId || null, profileName: meta.profileName || null };
});

// Asked for by the renderer once the pane is listening. Everything the shell
// said before anyone was there to hear it arrives now, in the order it was said,
// ahead of whatever it says next.
ipcMain.on('pty:flush', (event, { id }) => {
  const held = detachedPtys.get(id);
  if (!held || ptyOwners.get(id) !== event.sender) return;
  detachedPtys.delete(id);
  for (const data of held.chunks) event.sender.send('pty:data', { id, data });
  if (held.exit !== undefined) event.sender.send('pty:exit', { id, exitCode: held.exit });
});

ipcMain.on('tab:detach', (_e, payload) => {
  if (!payload) return;
  const w = createWindow();
  pendingAdoptions.set(w.frostId, payload);
});

Object.assign(module.exports, {

});
