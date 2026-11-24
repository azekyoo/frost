

const ptys = new Map();
// A shell belongs to the window that asked for it, so its output must go there
// and nowhere else.
const ptyOwners = new Map(); // ptyId -> WebContents
// What the shell was started as, kept because a tab moved to another window has
// to arrive there knowing which profile it came from — the window that created
// it is not necessarily still around to say.
const ptyMeta = new Map(); // ptyId -> { profileId, profileName }

// A tab moving between windows leaves its shells ownerless for as long as it
// takes the new window to load: the old renderer has already disposed its
// terminals, the new one does not exist yet. Output arriving in that gap has
// nowhere to go, and dropping it would eat the tail of whatever was running —
// so it is held here and replayed to the window that adopts the shell.
const detachedPtys = new Map(); // ptyId -> { chunks: [], bytes, exit? }
// Enough for a build's worth of output in the half-second a window takes to
// open. Past it the oldest goes, which is what a terminal does anyway.
const DETACH_BUFFER_MAX = 512 * 1024;

function sendToOwner(id, channel, payload) {
  const owner = ptyOwners.get(id);
  if (owner && !owner.isDestroyed()) {
    owner.send(channel, payload);
    return;
  }
  const held = detachedPtys.get(id);
  if (!held) return; // no owner and not in flight: the pane is simply gone
  if (channel === 'pty:exit') {
    held.exit = payload?.exitCode ?? 0;
    return;
  }
  if (channel !== 'pty:data') return;
  held.chunks.push(payload.data);
  held.bytes += payload.data.length;
  while (held.bytes > DETACH_BUFFER_MAX && held.chunks.length > 1) {
    held.bytes -= held.chunks.shift().length;
  }
}

// ---------- moving a tab to another window ----------
// A tab is its shells, and a shell cannot be moved: it is a process this window
// owns, holding a working directory and whatever is running in it. So the shell
// stays exactly where it is and only its ownership moves — the old window gives
// it up, the new one claims it, and main re-points the output. What the new
// window cannot inherit is the scrollback, which lives in the old renderer's
// terminal; that is serialised by the renderer and written back into the new
// one, so the text on screen survives the move too.

// Claimed once by the renderer of the window opened to receive it.
const pendingAdoptions = new Map(); // frostId -> tab payload

Object.assign(module.exports, {
  ptys,
  ptyOwners,
  ptyMeta,
  detachedPtys,
  DETACH_BUFFER_MAX,
  sendToOwner,
  pendingAdoptions
});
