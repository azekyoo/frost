// The restart prompt must appear whenever the chosen backdrop cannot apply to
// the window as it exists — including after the prompt has already been declined
// once, which is the case that was wrong.
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const LAB = path.join(app.getPath('temp'), 'frost-restartlab');
const PORT = 9560;
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
  const themeFile = path.join(configDir, 'theme.json');
  const write = (material) => fs.writeFileSync(themeFile, JSON.stringify({
    material, colorMode: 'dark', restoreSession: false, autoDetectAgents: false,
    notify: { agentBlocked: false, agentDone: false, commandSeconds: 0 }
  }, null, 2));
  write('glass');
  fs.writeFileSync(path.join(configDir, 'agents.json'), JSON.stringify({ spaces: [] }, null, 2));

  const env = { ...process.env, FROST_SHOT: JSON.stringify({ configDir, bounds: { x: 60, y: 60, width: 900, height: 560 } }) };
  for (const k of Object.keys(env)) if (/^CLAUDE/i.test(k)) delete env[k];
  const child = spawn(process.execPath, [ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(LAB, 'ud')}`],
    { cwd: ROOT, stdio: 'ignore', env });

  let pass = 0, fail = 0;
  const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

  try {
    await sleep(4500);
    const list = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())).filter(t => t.type === 'page');
    const c = connect(list[0].webSocketDebuggerUrl);
    await c.ready; await c.send('Runtime.enable');
    for (let i = 0; i < 120; i++) {
      if (await c.eval(`Boolean(typeof state!=='undefined' && state.activeTab)`)) break;
      await sleep(200);
    }
    const modalOpen = () => c.eval(`document.getElementById('modal').classList.contains('open')`);
    const decline = () => c.eval(`document.querySelector('#modal .modal-later').click(), true`);

    check('starts in a glass window', await c.eval(`document.body.classList.contains('glass')`));
    check('no prompt at rest', (await modalOpen()) === false);

    write('acrylic');
    await sleep(1600);
    check('glass -> acrylic prompts', await modalOpen());
    await decline();
    await sleep(400);
    check('declining closes it', (await modalOpen()) === false);
    check('window stays glass after declining', await c.eval(`document.body.classList.contains('glass')`));

    // the case that was broken: still a glass window, so this cannot apply either
    write('mica');
    await sleep(1600);
    check('acrylic -> mica prompts again while still glass', await modalOpen());
    await decline();
    await sleep(400);

    // going back to what the window already is needs no restart
    write('glass');
    await sleep(1600);
    check('back to glass does not prompt', (await modalOpen()) === false);

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('ERROR:', e.message); fail++;
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    app.exit(fail ? 1 : 0);
  }
})();
