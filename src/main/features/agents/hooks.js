// The Claude Code hooks Frost hands each agent: small `node -e` commands that
// write its session id, "blocked", the paths it touched… into the agent-status
// folder, and the per-agent --settings file that installs them. The user's own
// Claude Code config is never touched.
const fs = require('fs');
const path = require('path');

const { STATUS_DIR } = require('../../env');

// The hook's stdin is a JSON object carrying session_id. No double quotes, $
// or backticks inside the script: the shell running it sees it inside "...".
function sessionIdHook(agentId) {
  const file = path.join(STATUS_DIR, 'sid-' + agentId).replace(/\\/g, '/');
  return (
    `node -e "let d='';process.stdin.on('data',(c)=>d+=c).on('end',()=>{` +
    `try{require('fs').writeFileSync('${file}',JSON.parse(d).session_id)}catch(e){}})"`
  );
}

// Notification fires for questions and permission prompts, which really do
// need you, but also a minute into any idle wait ("Claude is waiting for your
// input"). That one is not blocked — the turn is over — so it leaves the status
// alone rather than flipping a done agent to blocked.
// What Claude should know about the terminal it is printing into. Ctrl+click
// turns a path into a Peek, but only one that reaches the screen intact:
// markdown eats a backslash before punctuation outside backticks, and a colon
// glued to the end makes a name no file has. Kept short, every session pays
// for it.
const FROST_CONTEXT =
  'This terminal is Frost. The user can Ctrl+click a file path in your output to open it in ' +
  "Frost's viewer. For that to work, write every file path you show as a full absolute path " +
  'inside backticks, followed by a space or the end of the line, never by a colon or other ' +
  'punctuation glued to it. Outside backticks, markdown drops a backslash before punctuation ' +
  '(\\.claude shows as .claude), and a glued character makes a name no file has.\n';

// SessionStart prints are read by Claude as context. Read from a file rather
// than inlined, so the text needs no escaping for the shell running the hook.
function contextHook() {
  const file = path.join(STATUS_DIR, 'frost-context.txt');
  if (!fs.existsSync(file)) fs.writeFileSync(file, FROST_CONTEXT);
  const fwd = file.replace(/\\/g, '/');
  return `node -e "process.stdout.write(require('fs').readFileSync('${fwd}','utf8'))"`;
}

function blockedHook(statusFile) {
  return (
    `node -e "let d='';process.stdin.on('data',(c)=>d+=c).on('end',()=>{let j={};try{j=JSON.parse(d)}catch(e){}` +
    `if(j.notification_type==='idle_prompt'||/waiting for your input/i.test(j.message||''))return;` +
    `require('fs').writeFileSync('${statusFile}','blocked')})"`
  );
}

// The folders a shell command reaches into: where it cd's or points git -C,
// and any absolute path it names. A guess — a command can build a path at run
// time — but agents spell theirs out. MSYS paths (/c/dev) become C:\dev. Also
// runs inside the hook script, pasted there as source, so it requires its own
// modules.
function bashPaths(cmd, cwd) {
  const path = require('path');
  const out = [];
  const add = (p) => {
    p = p.replace(/^["']|["']$/g, '');
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
    if (m) p = m[1].toUpperCase() + ':' + (m[2] || '/');
    if (/^~([\\/]|$)/.test(p)) p = require('os').homedir() + p.slice(1);
    out.push(path.resolve(cwd, p));
  };
  const arg = `("[^"]+"|'[^']+'|[^\\s;&|)]+)`;
  for (const m of cmd.matchAll(new RegExp(`(?:^|[\\s;&|(])(?:cd|pushd)\\s+${arg}`, 'g'))) add(m[1]);
  for (const m of cmd.matchAll(new RegExp(`\\bgit\\s+-C\\s+${arg}`, 'g'))) add(m[1]);
  for (const m of cmd.matchAll(/"([A-Za-z]:[\\/][^"]*)"/g)) add(m[1]);
  for (const m of cmd.matchAll(/(?:^|[\s'=(])((?:[A-Za-z]:[\\/]|\/[a-zA-Z]\/)[^\s"'`;|&<>()]*)/g)) add(m[1]);
  return out;
}

// Runs before every file edit and shell command, so the common case — nothing
// outside the agent's own folder — returns without a word. Anything else is
// appended to tp-<agent>, and the hook waits (capped) for main to write the
// matching acks, which it does once each path's repo has a base snapshot. A
// file, not the inline node -e the other hooks use: the wait loop has no
// business inside shell quoting.
const TOUCH_HOOK_SRC = `
const fs = require('fs');
const path = require('path');
${bashPaths.toString()}
const [dir, agentId] = process.argv.slice(2);
let d = '';
process.stdin.on('data', (c) => (d += c)).on('end', () => {
  let j = {};
  try { j = JSON.parse(d); } catch {}
  const input = j.tool_input || {};
  if (!j.cwd) return;
  const bash = j.tool_name === 'Bash';
  const targets = bash
    ? bashPaths(String(input.command || ''), j.cwd)
    : [input.file_path || input.notebook_path].filter(Boolean).map((t) => path.resolve(j.cwd, t));
  const outside = [...new Set(targets)].filter((p) => {
    const rel = path.relative(j.cwd, p);
    return rel.startsWith('..') || path.isAbsolute(rel);
  });
  if (!outside.length) return;
  const acks = [];
  let lines = '';
  for (const p of outside) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    acks.push(path.join(dir, 'ta-' + agentId + '-' + id));
    lines += id + '|' + p + (bash ? '|bash' : '') + '\\n';
  }
  try { fs.appendFileSync(path.join(dir, 'tp-' + agentId), lines); } catch { return; }
  const nap = new Int32Array(new SharedArrayBuffer(4));
  const until = Date.now() + 10000;
  let left = acks;
  while (left.length && Date.now() < until) {
    left = left.filter((a) => {
      if (!fs.existsSync(a)) return true;
      try { fs.unlinkSync(a); } catch {}
      return false;
    });
    if (left.length) Atomics.wait(nap, 0, 0, 25);
  }
});
`;

function touchHook(agentId) {
  const script = path.join(STATUS_DIR, 'frost-touch-hook.js');
  if (!fs.existsSync(script)) fs.writeFileSync(script, TOUCH_HOOK_SRC);
  const fwd = (s) => s.replace(/\\/g, '/');
  return `node "${fwd(script)}" "${fwd(STATUS_DIR)}" ${agentId}`;
}

function readSessionId(agentId) {
  try {
    return fs.readFileSync(path.join(STATUS_DIR, 'sid-' + agentId), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function hookSettingsFile(agentId) {
  const statusFile = path.join(STATUS_DIR, 'st-' + agentId).replace(/\\/g, '/');
  const write = (s) => `node -e "require('fs').writeFileSync('${statusFile}','${s}')"`;
  const cfg = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: write('working') }] }],
      Notification: [{ hooks: [{ type: 'command', command: blockedHook(statusFile) }] }],
      Stop: [{ hooks: [{ type: 'command', command: write('done') }] }],
      // Which Claude Code session this pane is running, so the sessions list can
      // show it as live instead of offering to resume it a second time. Fires
      // again on /clear and on resume, which is when the id changes.
      // Also tells Claude how to print paths so they stay clickable here.
      SessionStart: [
        {
          hooks: [
            { type: 'command', command: sessionIdHook(agentId) },
            { type: 'command', command: contextHook() }
          ]
        }
      ],
      // A file edit or shell command reaching outside the agent's folder, so
      // another repo's changes can join its diff. Before rather than after:
      // the hook waits for that repo to be snapshotted, and the first change is
      // part of the diff.
      PreToolUse: [
        {
          matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash',
          hooks: [{ type: 'command', command: touchHook(agentId) }]
        }
      ]
    }
  };
  const file = path.join(STATUS_DIR, 'cfg-' + agentId + '.json');
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}

Object.assign(module.exports, {
  sessionIdHook,
  FROST_CONTEXT,
  contextHook,
  blockedHook,
  bashPaths,
  TOUCH_HOOK_SRC,
  touchHook,
  readSessionId,
  hookSettingsFile
});
