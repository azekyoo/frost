// Clicking a dormant "resume" row twice must not start two sessions in the same
// directory. Runs without claude installed being relevant: the command simply
// fails inside the pane, while the pane bookkeeping — the thing under test — is
// identical either way.
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DEMO = 'C:\\dev\\aurora-notes';
const LAB = path.join(app.getPath('temp'), 'frost-resumelab');
const PORT = 9600;
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

(async () => {
  fs.rmSync(LAB, { recursive: true, force: true });
  const configDir = path.join(LAB, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'theme.json'), JSON.stringify({
    material: 'glass', restoreSession: false, autoDetectAgents: false, startDir: DEMO,
    notify: { agentBlocked: false, agentDone: false, commandSeconds: 0 }
  }, null, 2));
  fs.writeFileSync(path.join(configDir, 'agents.json'), JSON.stringify({ spaces: [] }, null, 2));
  // a dormant session for the rail to offer
  fs.writeFileSync(path.join(configDir, 'sessions.json'), JSON.stringify([
    { name: 'aurora-notes', cwd: DEMO, branch: 'main', lastSeen: Date.now() }
  ], null, 2));

  const env = { ...process.env, FROST_SHOT: JSON.stringify({ configDir, bounds: { x: 50, y: 50, width: 1150, height: 680 } }) };
  for (const k of Object.keys(env)) if (/^CLAUDE/i.test(k)) delete env[k];
  const child = spawn(process.execPath, [ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(LAB, 'ud')}`],
    { cwd: ROOT, stdio: 'ignore', env });

  let pass = 0, fail = 0;
  const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

  try {
    await sleep(4000);
    const list = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())).filter(t => t.type === 'page');
    const c = connect(list[0].webSocketDebuggerUrl);
    await c.ready; await c.send('Runtime.enable');
    for (let i = 0; i < 140; i++) {
      if (await c.eval(`Boolean(typeof state!=='undefined' && state.activeTab && state.activeTab.activePane && state.activeTab.activePane.cwd)`)) break;
      await sleep(200);
    }

    await c.eval(`(async () => { await newAgentTab(); return true; })()`);
    await sleep(2500);
    const rows = await c.eval(`agentTabs()[0].els.agentsList.querySelectorAll('.agent-row.dormant').length`);
    check('the dormant session is offered', rows === 1, `${rows} row(s)`);

    const before = await c.eval(`agentTabs()[0].centerLeaves.size`);

    // two clicks in quick succession, as a real double-click would land
    await c.eval(`(() => {
      const row = agentTabs()[0].els.agentsList.querySelector('.agent-row.dormant');
      row.click(); row.click();
      return true;
    })()`);
    await sleep(3500);
    const after = await c.eval(`agentTabs()[0].centerLeaves.size`);
    check('two clicks open one session', after - before === 1, `${after - before} pane(s) added`);

    const busy = await c.eval(`Boolean(agentTabs()[0].els.agentsList.querySelector('.agent-row.busy'))`);
    check('the row shows it is resuming', busy);

    // clicking again while it is in flight must still not add another
    await c.eval(`(() => {
      const row = agentTabs()[0].els.agentsList.querySelector('.agent-row.dormant');
      if (row) row.click();
      return true;
    })()`);
    await sleep(2000);
    const after2 = await c.eval(`agentTabs()[0].centerLeaves.size`);
    check('a later click is still ignored', after2 === after, `${after2} total`);

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('ERROR:', e.message); fail++;
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    app.exit(fail ? 1 : 0);
  }
})();
