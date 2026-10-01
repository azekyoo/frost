// Ending claude with a double Ctrl+C has to take it off the Agents list. On
// Windows the Ctrl+C reaches the shell as well, which used to abandon the
// `claude` wrapper before it could report the exit, leaving a live-looking
// agent over a bare prompt. Runs real claude in the demo repo.
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DEMO = process.env.FROST_SHOT_REPO || 'C:\\dev\\aurora-notes';
const TMP = path.join(app.getPath('temp'), 'frost-exittest');
const PORT = 9412;
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
  fs.rmSync(TMP, { recursive: true, force: true });
  const configDir = path.join(TMP, 'config');
  const userData = path.join(TMP, 'ud');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'agents.json'), JSON.stringify({ spaces: [] }, null, 2));
  fs.writeFileSync(path.join(configDir, 'theme.json'), JSON.stringify({
    material: 'glass', autoDetectAgents: true, restoreSession: false, startDir: DEMO,
    notify: { agentBlocked: false, agentDone: false, commandSeconds: 0 }
  }, null, 2));

  const env = { ...process.env, FROST_SHOT: JSON.stringify({ configDir, bounds: { x: 60, y: 60, width: 1200, height: 720 } }) };
  for (const k of Object.keys(env)) if (/^CLAUDE/i.test(k)) delete env[k];
  // keep drawing while covered: see the note in panetest.js
  const child = spawn(process.execPath, [ROOT, '--disable-features=CalculateNativeWinOcclusion', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`],
    { cwd: ROOT, stdio: 'ignore', env });

  let pass = 0, fail = 0;
  const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

  try {
    await sleep(4000);
    const list = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())).filter((t) => t.type === 'page');
    const c = connect(list[0].webSocketDebuggerUrl);
    await c.ready; await c.send('Runtime.enable');
    for (let i = 0; i < 140; i++) {
      if (await c.eval(`Boolean(typeof state!=='undefined' && state.activeTab && state.activeTab.activePane && state.activeTab.activePane.cwd)`)) break;
      await sleep(200);
    }

    const registered = await c.eval(`(async () => {
      await newAgentTab();
      const leaf = [...state.activeTab.centerLeaves][0];
      const until = Date.now() + 20000;
      while (!leaf.cwd && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      api.ptyInput(leaf.ptyId, 'claude\\r');
      window.__leaf = leaf;
      const reg = Date.now() + 90000;
      while (globalAgents.size === 0 && Date.now() < reg) await new Promise((r) => setTimeout(r, 200));
      return globalAgents.size;
    })()`);
    check('claude registers as an agent', registered === 1, `${registered} agent(s)`);

    // let it finish booting, so the Ctrl+C lands on claude and not its startup
    await sleep(8000);
    await c.eval(`(async () => {
      api.ptyInput(window.__leaf.ptyId, '\\x03');
      await new Promise((r) => setTimeout(r, 400));
      api.ptyInput(window.__leaf.ptyId, '\\x03');
      return true;
    })()`);

    let left = -1;
    for (let i = 0; i < 50; i++) {
      await sleep(200);
      left = await c.eval(`globalAgents.size`);
      if (left === 0) break;
    }
    check('double Ctrl+C takes it off the Agents list', left === 0, `${left} agent(s) left`);

    const launch = fs.readdirSync(path.join(userData, 'agent-status')).filter((f) => f.startsWith('ln-'));
    const said = launch.map((f) => fs.readFileSync(path.join(userData, 'agent-status', f), 'utf8').replace(/^\uFEFF/, '').trim());
    check('the wrapper reported the exit itself', said.some((s) => s.startsWith('end|')), JSON.stringify(said));

    const alive = await c.eval(`Boolean(panesByPty.get(window.__leaf.ptyId))`);
    check('the shell underneath is still there', alive);

    // Again, but with the wrapper's report lost — the launch file read-only, so
    // its "end" write fails, as a dropped watcher event would lose it. Only
    // the prompt coming back can tell Frost now.
    const again = await c.eval(`(async () => {
      api.ptyInput(window.__leaf.ptyId, 'claude\\r');
      const reg = Date.now() + 90000;
      while (globalAgents.size === 0 && Date.now() < reg) await new Promise((r) => setTimeout(r, 200));
      return globalAgents.size;
    })()`);
    check('claude registers again in the same pane', again === 1, `${again} agent(s)`);
    const lnFile = path.join(userData, 'agent-status', launch[0]);
    fs.chmodSync(lnFile, 0o444);
    await sleep(8000);
    await c.eval(`(async () => {
      api.ptyInput(window.__leaf.ptyId, '\\x03');
      await new Promise((r) => setTimeout(r, 400));
      api.ptyInput(window.__leaf.ptyId, '\\x03');
      return true;
    })()`);
    let left2 = -1;
    for (let i = 0; i < 50; i++) {
      await sleep(200);
      left2 = await c.eval(`globalAgents.size`);
      if (left2 === 0) break;
    }
    const stillStart = fs.readFileSync(lnFile, 'utf8').includes('start|');
    fs.chmodSync(lnFile, 0o644);
    check('the report really was lost', stillStart);
    check('the prompt coming back ends it anyway', left2 === 0, `${left2} agent(s) left`);

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('ERROR:', e.message); fail++;
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    app.exit(fail ? 1 : 0);
  }
})();
