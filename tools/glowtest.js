// Checks that typing effects still find their echo when the program answering
// the keys is slow to draw them — claude, deep into a long session, can take
// most of a second per key, while a spinner keeps writing elsewhere on screen.
// The keys go to a stand-in for such a program, run in a real pane: it echoes
// each key only after a delay, and turns a spinner on the top row meanwhile.
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(app.getPath('temp'), 'frost-glowtest');
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

// The slow program: echoes after LAG ms (never, if LAG is negative), and
// redraws a spinner in the top-left corner every 40 ms without moving the
// cursor. Ctrl+C quits.
const SLOW = String.raw`
const LAG = +process.argv[2];
process.stdin.setRawMode(true);
process.stdout.write('\x1b[2J\x1b[H\r\n\r\n> ');
let n = 0;
setInterval(() => process.stdout.write('\x1b7\x1b[1;1H' + '|/-\\'[n++ % 4] + '\x1b8'), 40);
process.stdin.on('data', (d) => {
  if (d[0] === 3) process.exit();
  if (LAG < 0) return;
  const out = d[0] === 0x7f ? '\b \b'.repeat(d.length) : d.toString();
  setTimeout(() => process.stdout.write(out), LAG);
});
`;

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const configDir = path.join(TMP, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const slow = path.join(TMP, 'slow.js');
  fs.writeFileSync(slow, SLOW);
  fs.writeFileSync(
    path.join(configDir, 'theme.json'),
    JSON.stringify(
      {
        material: 'glass',
        typingGlow: true,
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
    FROST_SHOT: JSON.stringify({ configDir, bounds: { x: 40, y: 40, width: 1000, height: 700 } })
  };
  for (const k of Object.keys(env)) if (/^CLAUDE/i.test(k)) delete env[k];
  const child = spawn(
    process.execPath,
    // keep drawing while covered: see the note in panetest.js
    [ROOT, '--disable-features=CalculateNativeWinOcclusion', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(TMP, 'ud')}`],
    { cwd: ROOT, stdio: 'ignore', env }
  );

  let pass = 0;
  let fail = 0;
  const check = (name, ok, detail = '') => {
    ok ? pass++ : fail++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  };

  // Every glow drawn, counted as it is added: typed ones by their letter
  const watch = `(() => {
    window.__glows = { typed: [], erased: 0 };
    const screen = activePane().term.element.querySelector('.xterm-screen');
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) {
      if (!n.classList?.contains('type-glow')) continue;
      if (n.classList.contains('erased')) window.__glows.erased++;
      else window.__glows.typed.push(n.querySelector('.ice')?.textContent || '');
    } }).observe(screen, { childList: true });
    return true; })()`;
  const reset = `(() => { window.__glows = { typed: [], erased: 0 }; return true })()`;
  const glows = 'window.__glows';
  const input = (w, s) => w.eval(`(() => { activePane().term.input(${JSON.stringify(s)}, true); return true })()`);
  const type = async (w, keys, gap = 40) => {
    for (const k of keys) {
      await input(w, k);
      await sleep(gap);
    }
  };
  const start = async (w, lag) => {
    await input(w, '\x03');
    await sleep(300);
    await input(w, `node "${slow}" ${lag}\r`);
    await sleep(1500);
    await w.eval(reset);
  };

  try {
    await sleep(3000);
    const w = await client();
    await waitReady(w);
    console.log('window ready');
    await w.eval(watch);

    // --- a program that answers at once -------------------------------------
    await start(w, 0);
    await type(w, [...'hello']);
    await sleep(600);
    let g = await w.eval(glows);
    check('keys echoed at once all light up', g.typed.join('') === 'hello', JSON.stringify(g));

    // --- a slow one, its spinner going all the while ------------------------
    await start(w, 700);
    await type(w, [...'world']);
    await sleep(1500);
    g = await w.eval(glows);
    check('keys echoed 700 ms late still light up', g.typed.join('') === 'world', JSON.stringify(g));

    await w.eval(reset);
    await type(w, ['\x7f', '\x7f'], 60);
    await sleep(1500);
    g = await w.eval(glows);
    check('and so do characters rubbed out late', g.erased === 2, JSON.stringify(g));

    await w.eval(reset);
    await input(w, 'abc12');
    await sleep(1800);
    g = await w.eval(glows);
    check('and a paste echoed late', g.typed.join('') === 'abc12', JSON.stringify(g));

    // --- one that never answers (a password prompt) -------------------------
    await start(w, -1);
    await type(w, [...'secret']);
    await sleep(2600);
    g = await w.eval(glows);
    check('keys that never come back light nothing', g.typed.length === 0 && g.erased === 0, JSON.stringify(g));

    await input(w, '\x03');
    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('ERROR:', e.message);
    fail++;
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    app.exit(fail ? 1 : 0);
  }
})();
