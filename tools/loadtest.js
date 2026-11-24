// Checks the loading sweep: a new pane whose shell is still starting shows a
// light along its top edge, and it goes once the shell's first prompt is up.
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(app.getPath('temp'), 'frost-loadtest');
const PORT = 9443;
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
        notify: { agentBlocked: false, agentDone: false, commandSeconds: 0 },
        // PowerShell takes long enough to start for the light to show; zsh is up
        // before it would. On macOS the shell waits a second first, then runs
        // zsh with Frost's hooks as usual (they reach it through ZDOTDIR).
        ...(process.platform === 'darwin'
          ? { profiles: [{ id: 'slow-zsh', name: 'slow zsh', shell: '/bin/sh', args: ['-c', 'sleep 1; exec /bin/zsh -l'], agentWrapper: 'zsh' }] }
          : {})
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

    // the first pane is already up: nothing loading there
    await sleep(800); // the sweep fades out once its prompt is up
    check('a pane whose shell is up shows nothing loading', !(await w.eval("!!activePane().el.querySelector('.pane-loading')")));

    // watched from the moment a new tab opens
    await w.eval(`(() => {
      window.__load = { seen: false, gone: null };
      newTab();
      const start = Date.now();
      const iv = setInterval(() => {
        const n = activePane();
        const on = n?.el.querySelector('.pane-loading.on');
        if (on) {
          window.__load.seen = true;
          window.__load.trace = !!on.querySelector('.load-trace');
          window.__load.dots = !!on.querySelector('.load-dots');
        }
        if (window.__load.seen && n && !n.el.querySelector('.pane-loading') && window.__load.gone === null) {
          window.__load.gone = Date.now() - start;
          window.__load.prompt = liveMarks(n).length > 0;
          clearInterval(iv);
        }
        if (Date.now() - start > 25000) clearInterval(iv);
      }, 30);
      return true;
    })()`);
    const until = Date.now() + 25000;
    let res;
    while (Date.now() < until) {
      res = await w.eval('window.__load');
      if (res.gone !== null) break;
      await sleep(200);
    }
    check('a new tab shows it loading while its shell starts', res.seen, JSON.stringify(res));
    check('as the border light alone', res.trace && !res.dots, JSON.stringify(res));
    check('and it goes once the shell is up', res.gone !== null, JSON.stringify(res));
    check('which is when the first prompt has been drawn', res.prompt === true, JSON.stringify(res));
    check('well before the 20s cap', res.gone !== null && res.gone < 15000, JSON.stringify(res));
  } catch (e) {
    console.error('ERROR:', e.message);
    fail++;
  } finally {
    // taskkill on Windows; elsewhere a forced kill, which takes Electron's helpers with it
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
    app.exit(fail ? 1 : 0);
  }
})();
