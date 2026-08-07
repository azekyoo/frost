// Two windows with different tabs, quit, relaunch: both must come back with
// their own tabs and geometry. Then close one and quit: only the survivor
// should be saved.
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const LAB = path.join(app.getPath('temp'), 'frost-restorelab');
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
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ready, send, async eval(e) {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }};
}

const configDir = path.join(LAB, 'config');
const stateFile = path.join(configDir, 'window.json');

function launch(port) {
  const env = { ...process.env, FROST_SHOT: JSON.stringify({ configDir }) };
  for (const k of Object.keys(env)) if (/^CLAUDE/i.test(k)) delete env[k];
  return spawn(process.execPath, [ROOT, `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(LAB, 'ud')}`],
    { cwd: ROOT, stdio: 'ignore', env });
}

async function clients(port) {
  const list = (await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json())).filter(t => t.type === 'page');
  const out = [];
  for (const t of list) {
    const c = connect(t.webSocketDebuggerUrl);
    await c.ready; await c.send('Runtime.enable');
    out.push(c);
  }
  return out;
}

async function ready(c) {
  for (let i = 0; i < 140; i++) {
    try { if (await c.eval(`Boolean(typeof state!=='undefined' && state.activeTab && state.activeTab.activePane && state.activeTab.activePane.cwd)`)) return; } catch {}
    await sleep(200);
  }
  throw new Error('window never became ready');
}

(async () => {
  fs.rmSync(LAB, { recursive: true, force: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'theme.json'), JSON.stringify({
    material: 'glass', restoreSession: true, autoDetectAgents: false,
    notify: { agentBlocked: false, agentDone: false, commandSeconds: 0 }
  }, null, 2));
  fs.writeFileSync(path.join(configDir, 'agents.json'), JSON.stringify({ spaces: [] }, null, 2));

  let pass = 0, fail = 0;
  const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
  let child = launch(9580);

  try {
    await sleep(4000);
    let [w1] = await clients(9580);
    await ready(w1);
    // window 1: three tabs. window 2: one.
    await w1.eval(`(async () => { await newTab(); await newTab(); api.winNew(); return true; })()`);
    await sleep(4000);
    const cs = await clients(9580);
    check('two windows open', cs.length === 2, `${cs.length}`);
    for (const c of cs) await ready(c);
    const counts = [];
    for (const c of cs) counts.push(await c.eval(`state.tabs.length`));
    check('different tab counts before quit', counts.includes(3) && counts.includes(1), JSON.stringify(counts));

    await sleep(1500); // let the debounced save land
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await sleep(1500);

    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    check('state records both windows', Array.isArray(saved.windows) && saved.windows.length === 2,
      `${saved.windows?.length} entr(y|ies)`);
    check('each has its own tabs', JSON.stringify((saved.windows || []).map(w => w.tabs.length).sort()) === '[1,3]',
      JSON.stringify((saved.windows || []).map(w => w.tabs.length)));

    // relaunch
    child = launch(9581);
    await sleep(5000);
    const back = await clients(9581);
    check('both windows restored', back.length === 2, `${back.length}`);
    for (const c of back) await ready(c);
    const counts2 = [];
    for (const c of back) counts2.push(await c.eval(`state.tabs.length`));
    check('tabs restored per window', counts2.sort().join(',') === '1,3', JSON.stringify(counts2));

    // close one window, then quit: only the survivor should be saved
    const three = back[counts2.indexOf(3) >= 0 ? 0 : 0];
    await back[0].eval(`api.winClose(), true`);
    await sleep(2000);
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await sleep(1200);
    const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    check('closing one window drops it', after.windows.length === 1, `${after.windows.length} left`);

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('ERROR:', e.message); fail++;
  } finally {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    app.exit(fail ? 1 : 0);
  }
})();
