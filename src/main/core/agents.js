// How an agent's state is read: the status shown in the rail, whether a typed
// command starts claude, Claude Code's JSONL transcripts. Pure, unit-tested.

function effectiveStatus(rec) {
  if (rec.exited) return 'exited';
  // Claude Code's hooks report the turn's real state, so they win over the
  // output heuristic. Typing only invalidates "blocked" — answering the prompt
  // is what unblocks it — while "done" holds until the next prompt is sent.
  if (rec.hook === 'blocked' && rec.hookT > rec.lastInput) return 'blocked';
  // answered: working again, with the same staleness rule, since typing into
  // it without a turn following would otherwise leave it "working" for good
  if (rec.hook === 'working' || rec.hook === 'blocked') {
    // don't stay "working" forever if a session died without firing Stop
    return Date.now() - rec.lastData > 60000 ? 'idle' : 'working';
  }
  if (rec.hook === 'done') return 'done';
  // No hook yet: a shell that hasn't run claude, or a turn that hasn't started.
  // Output has to have been flowing for a moment, not just arrived once, so a
  // single repaint can't pass for work.
  const recent = Date.now() - rec.lastData < 2500;
  const sustained = rec.lastData - (rec.busySince || rec.lastData) > 400;
  return recent && sustained ? 'working' : 'idle';
}

// Only claude draws a prompt of its own after the command: anything else
// (`git status`, `npm test`) is done with once it's typed, and holding the keys
// for a claude prompt that never comes would swallow them for HOLD_CAP_MS.
function runsClaude(run) {
  return /^\s*claude(\.exe|\.cmd)?(\s|$)/i.test(run);
}

function jsonLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      out.push(JSON.parse(line));
    } catch {} // the cut at either end of a slice
  }
  return out;
}

Object.assign(module.exports, {
  effectiveStatus,
  runsClaude,
  jsonLines
});
