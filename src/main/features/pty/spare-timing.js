

// ---------- spare shells ----------
// A shell takes seconds to start with a heavy profile, and every new tab, split
// and agent session used to wait them out on an empty pane. A spare or two of
// the default profile is kept started in the background instead; a new pane
// takes one, moves it to the folder it wants, clears it and shows the prompt
// at once, and a replacement is started behind it. What the spare printed
// while it waited — the profile's banner, the move — is never shown: the pane
// starts at the prompt the move ends on.
//
// Only PowerShell: the move is typed into it, and it is the dialect whose
// history Frost can keep that line out of. A setting a shell is started with
// changing (the profile, the start folder, agent detection) retires the spares
// started under the old one, and one sitting long enough to miss a newly
// installed tool on PATH is replaced while nothing is being typed.

const SPARE_MAX = 3;
const SPARE_DEFAULT = 2;
const SPARE_FIRST_MS = 4000; // after launch: the restored tabs start first
const SPARE_REFILL_MS = 1500; // after a claim: not on top of the pane just opened
const SPARE_STALE_MS = 10 * 60 * 1000;
const SPARE_QUIET_MS = 30000; // "nothing being typed", for replacing a stale one
const SPARE_HIDE_CAP_MS = 4000; // the move's prompt never came: show what there is

Object.assign(module.exports, {
  SPARE_MAX,
  SPARE_DEFAULT,
  SPARE_FIRST_MS,
  SPARE_REFILL_MS,
  SPARE_STALE_MS,
  SPARE_QUIET_MS,
  SPARE_HIDE_CAP_MS
});
