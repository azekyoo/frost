// Checks spare shells: once Frost has a couple started in the background, a
// new tab or a pane in another folder shows its prompt at once, with nothing
// of the spare's own start or of the move to its folder in sight, and the
// move kept out of PSReadLine's history.
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(app.getPath('temp'), 'frost-sparetest');
const PORT = 9445;
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

  try {
    await sleep(3000);
    const w = await client();
    await waitReady(w);
    console.log('window ready');

    // a new pane, timed from the ask to its first prompt
    const open = (expr) => w.eval(`(async () => {
      const t0 = performance.now();
      const leaf = await ${expr};
      for (let i = 0; i < 400 && !liveMarks(leaf).length; i++) await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setTimeout(r, 300));
      const buf = leaf.term.buffer.active;
      const text = [];
      for (let i = 0; i < buf.length; i++) text.push(buf.getLine(i).translateToString(true));
      return { ms: Math.round(performance.now() - t0), prompt: liveMarks(leaf).length > 0, cwd: leaf.cwd,
        text: text.join(String.fromCharCode(10)).trim(), loading: !!leaf.el.querySelector('.pane-loading.on') };
    })()`);

    // the spares start four seconds after launch, one after the other
    await sleep(22000);

    const first = await open('(async () => { await newTab(); return activePane(); })()');
    check('a new tab shows its prompt at once', first.prompt && first.ms < 1200, JSON.stringify({ ms: first.ms }));
    check('with nothing of the move in sight', !/Set-Location|#frost-spare/.test(first.text), JSON.stringify(first.text.slice(0, 200)));
    check('and it knows its folder', !!first.cwd, String(first.cwd));
    check('no loading shown for it', !first.loading);

    const dir = path.join(TMP, "some o'dd folder"); // a quote: the move must survive it
    fs.mkdirSync(dir, { recursive: true });
    const second = await open(`(async () => { await newTab({ cwd: ${JSON.stringify(dir)} }); return activePane(); })()`);
    check('a second one, in another folder, too', second.prompt && second.ms < 1200, JSON.stringify({ ms: second.ms }));
    check('is in that folder', String(second.cwd).toLowerCase() === dir.toLowerCase(), String(second.cwd));
    check('and shows nothing of the move either', !/Set-Location|#frost-spare/.test(second.text), JSON.stringify(second.text.slice(0, 200)));

    // the third has no spare left yet: an ordinary start
    const third = await open('(async () => { await newTab(); return activePane(); })()');
    check('with the spares used up, a tab still opens normally', third.prompt, JSON.stringify({ ms: third.ms }));

    // the move's line never reached the history file
    await runCommand(w, `(Select-String -Path (Get-PSReadLineOption).HistorySavePath -SimpleMatch ('#frost' + '-spare') | Measure-Object).Count`);
    await sleep(500);
    const count = await w.eval(`(() => { const o = commandOutput(activePane()); return o && o.output.join('|'); })()`);
    check('the move is kept out of the history', String(count).trim() === '0', JSON.stringify(count));
  } catch (e) {
    console.error('ERROR:', e.message);
    fail++;
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    app.exit(fail ? 1 : 0);
  }
})();
