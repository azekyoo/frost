// Checks that Frost can hand you one command's output without you selecting it.
//
// Everything here goes through a real PowerShell: the marks come from the prompt
// hook, so the only honest test is to type commands, let the shell answer, and
// then ask for the output of the one that just ran. The assertions are on the
// selected text — what a copy would put on the clipboard — rather than on line
// numbers, since the point is the text, not the arithmetic.
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(app.getPath('temp'), 'frost-marktest');
const PORT = 9427;
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

// xterm joins rows with CRLF on Windows, which is what the clipboard wants
// there; the assertions are about the text, not about which newline it uses
const select = `(() => { const t = selectCommandOutput(activePane()); return t === null ? null : t.split('\\r\\n').join('\\n'); })()`;

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const configDir = path.join(TMP, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'theme.json'),
    JSON.stringify(
      {
        material: 'glass',
        restoreSession: false,
        autoDetectAgents: false,
        copyOnSelect: false, // the clipboard is not what is being tested
        update: { check: false, download: false },
        notify: { agentBlocked: false, agentDone: false, commandSeconds: 0 }
      },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(configDir, 'agents.json'), JSON.stringify({ spaces: [] }, null, 2));

  const env = {
    ...process.env,
    FROST_SHOT: JSON.stringify({ configDir, bounds: { x: 40, y: 40, width: 900, height: 700 } })
  };
  for (const k of Object.keys(env)) if (/^CLAUDE/i.test(k)) delete env[k];
  const child = spawn(
    process.execPath,
    [ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(TMP, 'ud')}`],
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

    // --- a plain command --------------------------------------------------
    await runCommand(w, 'echo alpha; echo beta; echo gamma');
    await sleep(400);
    const three = await w.eval(select);
    check('the output is exactly what the command printed', three === 'alpha\nbeta\ngamma', JSON.stringify(three));

    // --- and nothing around it -------------------------------------------
    check('the command line itself is not included', !String(three).includes('echo alpha'), JSON.stringify(three));
    check('and neither is the prompt', !/PS .*>/.test(String(three)), JSON.stringify(three));

    // --- a line longer than the window ------------------------------------
    // Wrapped rows are one line, and a copy that breaks them where the window
    // happens to end is a copy that cannot be pasted back
    await runCommand(w, "'x' * 300");
    await sleep(400);
    const long = await w.eval(select);
    check('a wrapped line comes back as one line', long === 'x'.repeat(300), `${String(long).length} chars, ${String(long).split('\n').length} line(s)`);

    // --- a command that printed nothing ------------------------------------
    await runCommand(w, '$null = 1');
    await sleep(400);
    const empty = await w.eval(select);
    check('a command that printed nothing selects nothing', empty === null, JSON.stringify(empty));

    // --- scrolled up, it is the command on screen --------------------------
    await runCommand(w, 'echo needle-one');
    await runCommand(w, '1..60 | ForEach-Object { "filler $_" }');
    await sleep(600);
    const scrolled = await w.eval(`(() => {
      const node = activePane();
      const marks = liveMarks(node);
      // the prompt of the echo, two commands back, put at the top of the screen
      node.term.scrollToLine(Math.max(0, marks[marks.length - 3].marker.line));
      return true; })()`);
    await sleep(400);
    const onScreen = await w.eval(select);
    check(
      'scrolled up, it takes the command being looked at',
      onScreen === 'needle-one',
      JSON.stringify(onScreen)
    );
    await w.eval('(() => { activePane().term.scrollToBottom(); return true })()');

    // --- select all --------------------------------------------------------
    await w.eval(`(() => { runCommand('view.selectAll'); return true })()`);
    await sleep(300);
    const all = await w.eval('activePane().term.getSelection()');
    check('select all takes the whole buffer', all.includes('alpha') && all.includes('needle-one') && /PS .*>/.test(all), `${all.length} chars`);

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('ERROR:', e.message);
    fail++;
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    app.exit(fail ? 1 : 0);
  }
})();
