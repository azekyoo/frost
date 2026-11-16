// Checks the command rail and the tab previews in a real window: commands typed
// into a real PowerShell give the rail its ticks, a second tab gives the first
// one something to preview.
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(app.getPath('temp'), 'frost-railtest');
const PORT = 9441;
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

    await runCommand(w, 'echo rail-alpha');
    await runCommand(w, 'cmd /c exit 3');
    await runCommand(w, '1..80 | ForEach-Object { "filler $_" }');
    await sleep(700);

    // --- the rail -----------------------------------------------------------
    const rail = await w.eval(`(() => {
      const n = activePane();
      const r = n.rail;
      const done = liveMarks(n).filter((m) => m.exit !== null);
      return { on: r.rail.classList.contains('on'), ticks: r.ticks.children.length, done: done.length,
        failed: r.ticks.querySelectorAll('.failed').length, view: !r.view.hidden,
        width: r.rail.getBoundingClientRect().width };
    })()`);
    check('the rail shows once commands have finished', rail.on, JSON.stringify(rail));
    check('one tick per finished command', rail.ticks === rail.done && rail.done >= 3, JSON.stringify(rail));
    check('the failed command is marked as such', rail.failed === 1, JSON.stringify(rail));
    check('the window for what is on screen shows', rail.view, JSON.stringify(rail));

    const card = await w.eval(`(() => {
      const r = activePane().rail;
      const it = r.items.find((i) => i.mark.exit === 3);
      const top = r.rail.getBoundingClientRect().top;
      railHover(r, top + it.y);
      return { on: r.card.classList.contains('on'), text: r.card.textContent };
    })()`);
    check('hovering a tick names its command', card.on && card.text.includes('cmd /c exit 3'), JSON.stringify(card));
    check('and how it exited', card.text.includes('exit 3'), JSON.stringify(card));

    const jump = await w.eval(`(() => {
      const n = activePane();
      const r = n.rail;
      const it = r.items[1];
      const box = r.rail.getBoundingClientRect();
      r.rail.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: box.left + 3, clientY: box.top + it.y }));
      return { line: it.mark.marker.line, top: n.term.buffer.active.viewportY };
    })()`);
    await sleep(400);
    const after = await w.eval('activePane().term.buffer.active.viewportY');
    check('clicking a tick scrolls to that command', after === Math.min(jump.line, after) && Math.abs(after - jump.line) <= 1, JSON.stringify({ ...jump, after }));

    // --- tab previews -------------------------------------------------------
    await w.eval('(() => { activePane().term.scrollToBottom(); return true })()');
    await w.eval('(async () => { await newTab(); return true })()');
    await sleep(1500);
    const pv = await w.eval(`(() => {
      const first = state.tabs[0];
      const tabEl = [...el.tabstrip.querySelectorAll('.tab')].find((t) => t.tabData === first);
      showPreview(first, tabEl);
      const node = document.getElementById('tab-preview');
      return { show: node.classList.contains('show'), text: node.textContent, w: node.offsetWidth, h: node.offsetHeight,
        title: tabEl.hasAttribute('title') };
    })()`);
    check('a tab you are not in shows a preview', pv.show && pv.w > 100 && pv.h > 60, JSON.stringify({ ...pv, text: pv.text.length }));
    check('with what its pane shows', pv.text.includes('filler 80'), pv.text.slice(-120));
    check('and no OS tooltip on top of it', !pv.title);
    await w.eval('(() => { hidePreview(); return true })()');
    const gone = await w.eval(`document.getElementById('tab-preview').classList.contains('show')`);
    check('it goes away', !gone);
  } catch (e) {
    console.error('ERROR:', e.message);
    fail++;
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    app.exit(fail ? 1 : 0);
  }
})();
