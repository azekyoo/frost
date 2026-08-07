// Checks the multi-window refactor: a second window opens, each window owns its
// own shells, output from one never reaches the other, and only one window may
// hold the agent tab.
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(app.getPath('temp'), 'frost-wintest');
const PORT = 9422;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.on('window-all-closed', () => {});

async function targets() {
  return fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
}

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
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result?.value;
    }
  };
}

async function pageClients() {
  const list = (await targets()).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const out = [];
  for (const t of list) {
    const c = connect(t.webSocketDebuggerUrl);
    await c.ready;
    await c.send('Runtime.enable');
    out.push(c);
  }
  return out;
}

async function waitReady(c, timeout = 40000) {
  const until = Date.now() + timeout;
  for (;;) {
    try {
      if (await c.eval(`Boolean(typeof state!=='undefined' && state.activeTab && state.activeTab.activePane && state.activeTab.activePane.cwd)`)) return;
    } catch {}
    if (Date.now() > until) throw new Error('window never became ready');
    await sleep(250);
  }
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const configDir = path.join(TMP, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'theme.json'), JSON.stringify({
    material: 'glass', restoreSession: false, autoDetectAgents: false,
    notify: { agentBlocked: false, agentDone: false, commandSeconds: 0 }
  }, null, 2));
  fs.writeFileSync(path.join(configDir, 'agents.json'), JSON.stringify({ spaces: [] }, null, 2));

  const env = { ...process.env, FROST_SHOT: JSON.stringify({ configDir, bounds: { x: 40, y: 40, width: 1000, height: 640 } }) };
  for (const k of Object.keys(env)) if (/^CLAUDE/i.test(k)) delete env[k];
  const child = spawn(process.execPath, [ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(TMP, 'ud')}`],
    { cwd: ROOT, stdio: 'ignore', env });

  let pass = 0, fail = 0;
  const check = (name, ok, detail = '') => {
    (ok ? pass++ : fail++);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  };

  try {
    await sleep(3000);
    let [a] = await pageClients();
    await waitReady(a);
    console.log('window 1 ready');

    await a.eval('api.winNew(), true');
    await sleep(3500);

    const clients = await pageClients();
    check('a second window opened', clients.length === 2, `${clients.length} page target(s)`);
    if (clients.length < 2) throw new Error('no second window');

    // reconnect: identify windows by a token typed into each
    const [w1, w2] = clients;
    await waitReady(w1); await waitReady(w2);

    const id1 = await w1.eval(`state.activeTab.activePane.ptyId`);
    const id2 = await w2.eval(`state.activeTab.activePane.ptyId`);
    check('each window has its own shell', id1 !== id2, `pty ${id1} vs pty ${id2}`);

    // type a unique marker in window 1 only
    await w1.eval(`api.ptyInput(state.activeTab.activePane.ptyId, 'echo MARKER_ONE\\r'), true`);
    await sleep(2500);
    const read = (c) => c.eval(`(() => {
      const t = state.activeTab.activePane.term, b = t.buffer.active; let s='';
      for (let i=0;i<b.length;i++){ const l=b.getLine(i); if(l) s+=l.translateToString(true)+'\\n'; }
      return s; })()`);
    const text1 = await read(w1);
    const text2 = await read(w2);
    check('output appears in the window that ran it', text1.includes('MARKER_ONE'));
    check('output does not leak to the other window', !text2.includes('MARKER_ONE'));

    // agent tab may only live in one window
    const claim1 = await w1.eval(`(async () => { const t = await newAgentTab(); return Boolean(t); })()`);
    await sleep(1200);
    const claim2 = await w2.eval(`(async () => { const t = await newAgentTab(); return Boolean(t); })()`);
    check('first window gets the agent tab', claim1 === true);
    check('second window is refused it', claim2 === false);

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('ERROR:', e.message);
    fail++;
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    app.exit(fail ? 1 : 0);
  }
})();
