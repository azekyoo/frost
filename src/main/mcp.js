// Frost's own MCP server: what every agent running in a Frost pane can ask of
// the terminal around it. A claude session sees its folder and its own pty and
// nothing else; Frost sees every tab, pane and scrollback, and this is where it
// lends that sight out. Read-only for now — nothing here can type.
//
// The transport is MCP's streamable HTTP in its plainest form: one POST per
// JSON-RPC message, answered with JSON, no event stream. That is all a server
// with no notifications of its own needs, and it keeps Frost free of a bridge
// process — claude connects straight to the main process.
//
// Bound to loopback, and every request has to carry the token handed out in the
// --mcp-config file, so another program on the machine can't read your screen.

const http = require('http');
const crypto = require('crypto');

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 1024 * 1024;

const INSTRUCTIONS =
  'You are running inside Frost, a terminal with several tabs and split panes. ' +
  'These tools read the other terminals the user has open: when they mention ' +
  '"my other tab", "the server", "the build", "the error I am looking at", or ' +
  'output you have not seen, call list_panes, then read_pane. get_selection ' +
  'returns what the user has highlighted. Pane ids are what list_panes returns.';

const TOOLS = [
  {
    name: 'list_panes',
    description:
      'Every terminal pane open in Frost: its id, tab, title, folder, git branch, ' +
      'shell, whether a command is running, the exit code of the last finished ' +
      'command, and which one the user is looking at. "self" is your own pane.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'read_pane',
    description:
      "Read a pane's terminal output. By default, the last lines of its scrollback. " +
      'With "command", one command instead: 1 is the last one that finished ' +
      '(or the one still running), 2 the one before, and so on — with what was ' +
      'typed and its exit code.',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string', description: 'Pane id from list_panes' },
        lines: { type: 'integer', minimum: 1, maximum: 2000, description: 'How many trailing lines (default 150)' },
        command: { type: 'integer', minimum: 1, maximum: 50, description: 'Read one command back from the end instead' }
      },
      required: ['pane'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'get_selection',
    description: 'The text the user has selected in a Frost terminal, and which pane it is in.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true }
  }
];

const TOOL_NAMES = TOOLS.map((t) => t.name);

// deps:
//   enabled()                  — the setting, read live
//   callTool(name, args, from) — resolves to text, or throws for an error result
//   version
function startMcpServer(deps) {
  const token = crypto.randomBytes(32).toString('hex');
  let port = 0;

  async function handle(msg, agentId) {
    const { id, method, params } = msg || {};
    const isRequest = id !== undefined && id !== null;
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: isRequest ? id : null, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') {
      // a response or garbage: nothing to answer
      return isRequest ? fail(-32600, 'Invalid request') : null;
    }
    if (!isRequest) return null; // notifications/initialized and friends

    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'frost', version: deps.version },
          instructions: INSTRUCTIONS
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const name = params?.name;
        if (!TOOL_NAMES.includes(name)) return fail(-32602, `Unknown tool: ${name}`);
        if (!deps.enabled()) {
          return reply({ content: [{ type: 'text', text: 'Turned off in Frost settings (Let agents read your terminals).' }], isError: true });
        }
        try {
          const text = await deps.callTool(name, params.arguments || {}, agentId);
          return reply({ content: [{ type: 'text', text }] });
        } catch (e) {
          return reply({ content: [{ type: 'text', text: String(e?.message || e) }], isError: true });
        }
      }
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  }

  const server = http.createServer((req, res) => {
    const m = /^\/mcp\/([\w-]+)$/.exec(req.url || '');
    const auth = req.headers.authorization || '';
    const given = Buffer.from(auth.replace(/^Bearer /, ''));
    const want = Buffer.from(token);
    if (!m || given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      res.writeHead(m ? 401 : 404).end();
      return;
    }
    // no server-initiated stream to offer, and no session to end
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    const agentId = m[1];
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', async () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }
      const batch = Array.isArray(body);
      const out = (await Promise.all((batch ? body : [body]).map((msg) => handle(msg, agentId)))).filter(Boolean);
      if (!out.length) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(batch ? out : out[0]));
    });
  });

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });

  // What goes in the file claude is started with. One per agent, so the URL
  // says who is asking and "self" can be told apart from everyone else.
  function configFor(agentId) {
    return {
      mcpServers: {
        frost: {
          type: 'http',
          url: `http://127.0.0.1:${port}/mcp/${agentId}`,
          headers: { Authorization: `Bearer ${token}` }
        }
      }
    };
  }

  return { ready, configFor, toolNames: TOOL_NAMES, close: () => server.close() };
}

module.exports = { startMcpServer };
