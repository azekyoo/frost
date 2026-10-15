// Checks that clearing the screen (cls, Ctrl+L) takes the command marks on
// the cleared rows with it, so new output isn't split into commands that aren't.
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(app.getPath('temp'), 'frost-cleartest');
const PORT = 9433;
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

// What each pane actually occupies, in the order the layout holds them
const paneBoxes = `(() => allLeaves(state.activeTab.root).map((l) => {
  const r = l.el.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
}))()`;

const run = (command) => `(() => { runCommand(${JSON.stringify(command)}); return true; })()`;

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
    FROST_SHOT: JSON.stringify({ configDir, bounds: { x: 40, y: 40, width: 1100, height: 700 } })
  };
  for (const k of Object.keys(env)) if (/^CLAUDE/i.test(k)) delete env[k];
  // Windows reports a window covered by others as hidden, and Chromium stops
  // drawing it — so a fit waiting on the next frame never comes, and the zoom
  // check failed whenever something else was on top of the test window.
  const child = spawn(
    process.execPath,
    [
      ROOT,
      '--disable-features=CalculateNativeWinOcclusion',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${path.join(TMP, 'ud')}`
    ],
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


    const runCommand = async (line) => {
      const lastId = "(activePane().marks.at(-1)?.marker.id ?? -1)";
      const before = await w.eval(lastId);
      await w.eval(`(() => { api.ptyInput(activePane().ptyId, ${JSON.stringify(line + '\r')}); return true })()`);
      const until = Date.now() + 20000;
      while ((await w.eval(lastId)) === before) {
        if (Date.now() > until) throw new Error('never finished: ' + line);
        await sleep(250);
      }
      await sleep(300);
    };
    for (const c of ['echo one', 'echo two', 'echo three', 'echo four']) await runCommand(c);
    await runCommand('cls');
    await runCommand('1..12 | % { "line $_" }');
    // every row of the output belongs to the command that printed it
    const blocks = await w.eval(`(() => {
      const node = activePane(), buf = node.term.buffer.active;
      const out = [];
      for (let r = 0; r < buf.length; r++) {
        const text = buf.getLine(r).translateToString(true);
        if (!/^line \\d+$/.test(text)) continue;
        const b = blockAt(node, r);
        out.push(b ? markOutput(node, commandRegion(node, b.mark))?.command : null);
      }
      return out;
    })()`);
    check('cleared rows leave no command behind', blocks.length === 12, blocks.length + ' output rows');
    check(
      'every output row is in the command that printed it',
      blocks.every((c) => c === '1..12 | % { "line $_" }'),
      JSON.stringify([...new Set(blocks)])
    );
    // Ctrl+L clears with the prompt still waiting: nothing is running, and the
    // marks above go all the same
    await runCommand('echo after');
    await w.eval(`(() => { api.ptyInput(activePane().ptyId, '\\x0c'); return true })()`);
    await sleep(1200);
    const lines = await w.eval(`liveMarks(activePane()).map((m) => m.marker.line)`);
    const base = await w.eval('activePane().term.buffer.active.baseY');
    check('Ctrl+L drops the marks on the screen it clears', lines.filter((l) => l > base).length <= 1, JSON.stringify({ lines, base }));
    await runCommand('echo next');
    const nb = await w.eval(`(() => { const node = activePane(), buf = node.term.buffer.active; for (let r = buf.length - 1; r >= 0; r--) { if (buf.getLine(r).translateToString(true) === 'next') { const b = blockAt(node, r); return b ? markOutput(node, commandRegion(node, b.mark)) : null; } } return 'no row'; })()`);
    check('the command after Ctrl+L is its own block', nb?.command === 'echo next', JSON.stringify(nb));
    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('ERROR:', e.message);
    fail++;
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    app.exit(fail ? 1 : 0);
  }
})();
