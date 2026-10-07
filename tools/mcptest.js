// Checks Frost's MCP server against a real window: the config each shell hands
// to claude, the token, and what the three tools read out of real PowerShell
// panes — the same requests claude makes, over the same HTTP.
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(app.getPath('temp'), 'frost-mcptest');
const PORT = 9431;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.on('window-all-closed', () => {});

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let seq = 0;
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return {
    ready,
    send,
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      }
      return r.result?.value;
    }
  };
}

async function client() {
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
  const target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const c = connect(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Runtime.enable');
  return c;
}

async function waitReady(c, timeout = 40000) {
  const until = Date.now() + timeout;
  for (;;) {
    try {
      const ok = await c.eval(
        `Boolean(typeof state!=='undefined' && state.activeTab && state.activeTab.activePane && state.activeTab.activePane.cwd)`
      );
      if (ok) return;
    } catch {}
    if (Date.now() > until) throw new Error('window never became ready');
    await sleep(250);
  }
}

// Typed into the real shell, then waited on until the prompt hook has closed the
// command — that closing mark is what the whole feature is built on.
async function runCommand(w, line) {
  const before = await w.eval('(activePane().marks || []).length');
  await w.eval(`(() => { api.ptyInput(activePane().ptyId, ${JSON.stringify(line + '\r')}); return true })()`);
  const until = Date.now() + 20000;
  for (;;) {
    const now = await w.eval('(activePane().marks || []).length');
    if (now > before) return;
    if (Date.now() > until) throw new Error('the shell never reported finishing: ' + line);
    await sleep(250);
  }
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const configDir = path.join(TMP, 'config');
  const userData = path.join(TMP, 'ud');
  fs.mkdirSync(configDir, { recursive: true });
  const theme = {
    material: 'glass',
    restoreSession: false,
    autoDetectAgents: true, // the claude wrapper is what carries the MCP config
    copyOnSelect: false,
    update: { check: false, download: false },
    notify: { agentBlocked: false, agentDone: false, commandSeconds: 0 }
  };
  fs.writeFileSync(path.join(configDir, 'theme.json'), JSON.stringify(theme, null, 2));
  fs.writeFileSync(path.join(configDir, 'agents.json'), JSON.stringify({ spaces: [] }, null, 2));

  const env = {
    ...process.env,
    FROST_SHOT: JSON.stringify({ configDir, bounds: { x: 40, y: 40, width: 1100, height: 700 } })
  };
  for (const k of Object.keys(env)) if (/^CLAUDE/i.test(k)) delete env[k];
  const child = spawn(
    process.execPath,
    [ROOT, '--disable-features=CalculateNativeWinOcclusion', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`],
    { cwd: ROOT, stdio: 'ignore', env }
  );

  let pass = 0;
  let fail = 0;
  const check = (name, ok, detail = '') => {
    ok ? pass++ : fail++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  };

  try {
    await sleep(3000);
    const w = await client();
    await waitReady(w);
    console.log('window ready');

    // --- the file claude is started with --------------------------------------
    const first = await w.eval('activePane().ptyId');
    const cfgFile = path.join(userData, 'agent-status', `mcp-pty${first}.json`);
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).mcpServers?.frost;
    check('each shell gets an MCP config pointing at Frost', /^http:\/\/127\.0\.0\.1:\d+\/mcp\/pty\d+$/.test(cfg?.url || ''), cfg?.url);
    await runCommand(w, 'echo "mcp=$env:FROST_MCP"');
    await sleep(300);
    const shellEnv = await w.eval('commandOutput(activePane()).output.join("")');
    check('and the shell knows where it is', shellEnv.includes(`mcp-pty${first}.json`), shellEnv);

    let rpcId = 0;
    const rpc = (method, params, headers = cfg.headers) =>
      fetch(cfg.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
      }).then(async (r) => ({ status: r.status, body: r.status === 200 ? await r.json() : null }));
    const call = async (name, args = {}) => {
      const r = await rpc('tools/call', { name, arguments: args });
      return { text: r.body?.result?.content?.[0]?.text || '', isError: !!r.body?.result?.isError };
    };

    const bad = await rpc('ping', {}, { Authorization: 'Bearer nope' });
    check('a wrong token is turned away', bad.status === 401, String(bad.status));
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    check('it introduces itself as frost', init.body?.result?.serverInfo?.name === 'frost', JSON.stringify(init.body?.result?.serverInfo));
    const tools = (await rpc('tools/list', {})).body?.result?.tools?.map((t) => t.name) || [];
    check(
      'with its tools',
      tools.join() === 'list_panes,read_pane,get_selection,open_shell,run_in_pane,wait_for_output,interrupt_pane',
      tools.join()
    );
    const hooks = JSON.parse(fs.readFileSync(path.join(userData, 'agent-status', `cfg-pty${first}.json`), 'utf8'));
    const allowed = hooks.permissions?.allow || [];
    check(
      'reading is allowed up front, typing is left to claude to ask',
      allowed.includes('mcp__frost__read_pane') && allowed.includes('mcp__frost__wait_for_output') && !allowed.some((t) => /run_in_pane|interrupt_pane|open_shell/.test(t)),
      allowed.join()
    );

    // --- some history to read --------------------------------------------------
    await runCommand(w, 'echo one-1; echo one-2');
    await runCommand(w, 'cmd /c "echo two-boom & exit 5"');
    await w.eval(`(() => { runCommand('pane.splitRight'); return true })()`);
    const until = Date.now() + 20000;
    while (!(await w.eval('Boolean(activePane().cwd) && activePane().ptyId !== ' + JSON.stringify(first)))) {
      if (Date.now() > until) throw new Error('split pane never got a prompt');
      await sleep(250);
    }
    await runCommand(w, 'echo in-the-second-pane');
    await sleep(400);

    // --- list_panes ------------------------------------------------------------
    const listed = await call('list_panes');
    let panes = [];
    try { panes = JSON.parse(listed.text); } catch {}
    check('list_panes sees both panes', panes.length === 2, listed.text.slice(0, 200));
    const mine = panes.find((p) => p.pane === first);
    const other = panes.find((p) => p.pane !== first);
    check('the caller is marked as self', mine?.self === true && !other?.self, JSON.stringify(mine));
    check('with the last exit code', mine?.lastExit === 5, JSON.stringify(mine?.lastExit));
    check('and the focused one is the new pane', other?.focused === true && !mine?.focused, JSON.stringify(other));
    check('and its folder', typeof mine?.cwd === 'string' && mine.cwd.length > 2, mine?.cwd);

    // --- read_pane -------------------------------------------------------------
    const last = await call('read_pane', { pane: first, command: 1 });
    check('command 1 is the last that finished', last.text.includes('$ cmd /c "echo two-boom & exit 5"') && last.text.includes('two-boom') && last.text.includes('[exit 5]'), JSON.stringify(last.text));
    const before = await call('read_pane', { pane: first, command: 2 });
    check('command 2 is the one before', before.text.includes('one-1\none-2') && before.text.includes('[exit 0]'), JSON.stringify(before.text));
    const far = await call('read_pane', { pane: first, command: 40 });
    check('too far back is an error, not a guess', far.isError, far.text);
    const tail = await call('read_pane', { pane: first, lines: 30 });
    check('lines reads the scrollback tail', tail.text.includes('one-2') && tail.text.includes('two-boom'), String(tail.text.length));
    const nope = await call('read_pane', { pane: '999' });
    check('an unknown pane says so', nope.isError && nope.text.includes('list_panes'), nope.text);

    // --- get_selection -----------------------------------------------------------
    const none = await call('get_selection');
    check('no selection reads as none', none.text.startsWith('Nothing is selected'), none.text);
    await w.eval(`(() => {
      const node = panesByPty.get(${JSON.stringify(first)});
      const marks = liveMarks(node);
      const m = marks[marks.length - 2];
      node.term.selectLines(m.marker.line + 1, m.marker.line + 1);
      return true })()`);
    const sel = await call('get_selection');
    check('a selection in a pane that is not focused is still found', sel.text.includes(`pane ${first}`) && sel.text.includes('two-boom'), JSON.stringify(sel.text));

    // --- open_shell ----------------------------------------------------------------
    // pane 1 stands in for an agent's pane in a normal tab: its shell is a split
    // of it, and the keyboard stays where the user left it
    const focusedBefore = await w.eval('activePane().ptyId');
    const opened = await call('open_shell', {});
    let shell = {};
    try { shell = JSON.parse(opened.text); } catch {}
    check('open_shell splits the caller and returns the new pane', shell.where === 'split' && shell.pane && shell.pane !== first, opened.text);
    check('without taking the keyboard', (await w.eval('activePane().ptyId')) === focusedBefore, await w.eval('activePane().ptyId'));
    const dockAsked = await call('open_shell', { where: 'dock' });
    check('a normal tab has no dock, and says so', dockAsked.isError && /split/.test(dockAsked.text), dockAsked.text);

    // --- run_in_pane -------------------------------------------------------------
    const ran = await call('run_in_pane', { pane: shell.pane, command: 'echo ran-by-agent; cmd /c exit 7' });
    check('run_in_pane returns what the command printed', ran.text.includes('ran-by-agent'), JSON.stringify(ran.text));
    check('and how it ended', ran.text.includes('[exit 7]'), JSON.stringify(ran.text));
    // something half-typed by the user is cleared, not glued onto the command
    await w.eval(`(() => { api.ptyInput(${JSON.stringify(shell.pane)}, 'half-typed-junk'); return true })()`);
    await sleep(500);
    const clean = await call('run_in_pane', { pane: shell.pane, command: 'echo clean-line' });
    check('a half-typed line is cleared first', clean.text.includes('$ echo clean-line') && clean.text.includes('[exit 0]'), JSON.stringify(clean.text));
    const own = await call('run_in_pane', { pane: first, command: 'echo nope' });
    check('its own pane is refused', own.isError && /own pane/.test(own.text), own.text);
    const multi = await call('run_in_pane', { pane: shell.pane, command: 'echo a\necho b' });
    check('several lines are refused', multi.isError && /One line/.test(multi.text), multi.text);

    // --- something that keeps running ----------------------------------------------
    const server = await call('run_in_pane', {
      pane: shell.pane,
      command: "Start-Sleep 2; echo 'server ready on 4000'; Start-Sleep 60",
      timeout: 1
    });
    check('a command still running at the timeout is left running', /still running after 1s/.test(server.text), JSON.stringify(server.text));
    const ready = await call('wait_for_output', { pane: shell.pane, pattern: 'ready on \\d+', timeout: 15 });
    check('wait_for_output catches the line it waits for', ready.text.includes('[matched') && ready.text.includes('server ready on 4000'), JSON.stringify(ready.text));
    const busyRun = await call('run_in_pane', { pane: shell.pane, command: 'echo too-soon' });
    check('a busy pane is refused', busyRun.isError && /busy/.test(busyRun.text), busyRun.text);
    const stop = await call('interrupt_pane', { pane: shell.pane });
    check('interrupt_pane sends Ctrl+C', !stop.isError, stop.text);
    await sleep(1500);
    const after = await call('run_in_pane', { pane: shell.pane, command: 'echo after-stop' });
    check('and the pane is free again', after.text.includes('after-stop') && after.text.includes('[exit 0]'), JSON.stringify(after.text));
    const idle = await call('wait_for_output', { pane: shell.pane, timeout: 2 });
    check('waiting on an idle pane returns at once', idle.text.startsWith('[nothing is running'), JSON.stringify(idle.text.slice(0, 60)));

    // --- the setting -------------------------------------------------------------
    fs.writeFileSync(path.join(configDir, 'theme.json'), JSON.stringify({ ...theme, agentTools: false }, null, 2));
    await sleep(1500);
    const off = await call('list_panes');
    check('turned off, the tools refuse', off.isError && /settings/.test(off.text), off.text);
    await w.eval(`(() => { runCommand('pane.splitDown'); return true })()`);
    await sleep(4000);
    const third = await w.eval('activePane().ptyId');
    const offCfg = JSON.parse(fs.readFileSync(path.join(userData, 'agent-status', `mcp-pty${third}.json`), 'utf8'));
    check('and new shells hand claude no server', JSON.stringify(offCfg.mcpServers) === '{}', JSON.stringify(offCfg));

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('ERROR:', e.message);
    fail++;
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    app.exit(fail ? 1 : 0);
  }
})();
