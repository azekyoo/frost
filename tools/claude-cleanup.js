// Tests that run a real claude need the real login, so they use the real
// ~/.claude, and every prompt they send leaves a session behind in the demo
// repo's history. Those then bury the real sessions in Frost's rail. So: note
// which sessions the demo repo has before the test, and afterwards send only
// the ones the test added to the Recycle Bin. Anything that was there before,
// or that is older than the test, is never touched.
const fs = require('fs');
const os = require('os');
const path = require('path');

function projectDirOf(cwd) {
  // the children are started with every CLAUDE* variable removed, so theirs
  // is always the default config folder
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
}

function transcripts(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
}

function noteSessions(cwd) {
  const dir = projectDirOf(cwd);
  return { dir, before: new Set(transcripts(dir)), since: Date.now() };
}

async function dropNewSessions(note) {
  const { shell } = require('electron');
  const dropped = [];
  for (const f of transcripts(note.dir)) {
    if (note.before.has(f)) continue;
    const file = path.join(note.dir, f);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    // made before the test started: not ours, whatever the name
    if (st.birthtimeMs < note.since - 2000) continue;
    try {
      await shell.trashItem(file);
      dropped.push(f.slice(0, -6));
    } catch {}
    // the folder beside it: subagents, the /rename name
    const side = file.slice(0, -6);
    if (fs.existsSync(side)) await shell.trashItem(side).catch(() => {});
  }
  if (dropped.length) console.log(`cleaned up ${dropped.length} test session(s): ${dropped.join(', ')}`);
  return dropped;
}

module.exports = { noteSessions, dropNewSessions };
