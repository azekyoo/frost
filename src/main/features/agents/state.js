

// ---------- agent mode ----------
// An agent is a Claude Code session running in one of Frost's panes. Status
// comes from Claude Code hooks (injected via a per-agent --settings file, the
// user's own config is never touched) plus an output-activity heuristic.

const agents = new Map(); // agentId -> { ptyId, cwd, sessionId, title, lastData, lastInput, hook, hookT, status }
const agentByPty = new Map(); // ptyId -> same record

Object.assign(module.exports, {
  agents,
  agentByPty
});
