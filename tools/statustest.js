// End-to-end agent status test: launches a real Frost, opens an agent tab in the
// demo repo, runs claude for real, prompts it, and records every status change
// with a timestamp. Then clicks between panes to check focus doesn't fake work,
// and idles to check nothing drifts back to "working" on its own.
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DEMO = process.env.FROST_SHOT_REPO || 'C:\\dev\\aurora-notes';
const TMP = path.join(app.getPath('temp'), 'frost-statustest');
const PORT = 9411;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('window-all-closed', () => {});

class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data); const p = this.pending.get(m.id);
      if (!p) return; this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    });
  }
  static async attach(port, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) {
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((res, rej) => {
            ws.addEventListener('open', res, { once: true });
            ws.addEventListener('error', rej, { once: true });
          });
          return new Cdp(ws);
        }
      } catch {}
      if (Date.now() > deadline) throw new Error('debugger never came up');
      await sleep(250);
    }
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
  async waitForApp(timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const ok = await this.eval(
          `Boolean(document.readyState==='complete' && typeof state!=='undefined' && state.activeTab
             && state.activeTab.activePane && state.activeTab.activePane.ptyId
             && state.activeTab.activePane.cwd)`
        );
        if (ok) return;
      } catch {}
      if (Date.now() > deadline) throw new Error('app never reached a prompt');
      await sleep(200);
    }
  }
}

function setup() {
  fs.rmSync(TMP, { recursive: true, force: true });
  const cfg = path.join(TMP, 'config');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'agents.json'),
    JSON.stringify({ spaces: [{ name: 'aurora-notes', path: DEMO }] }, null, 2));
  fs.writeFileSync(path.join(cfg, 'theme.json'), JSON.stringify({
    material: 'glass', autoDetectAgents: true, restoreSession: false,
    notify: { agentBlocked: false, agentDone: false, commandSeconds: 0 },
    startDir: DEMO
  }, null, 2));
  return cfg;
}

(async () => {
  const configDir = setup();
  const env = { ...process.env, FROST_SHOT: JSON.stringify({ configDir, bounds: { x: 60, y: 60, width: 1280, height: 760 } }) };
  // a nested claude must not inherit this session's markers
  for (const k of Object.keys(env)) if (/^CLAUDE/i.test(k)) delete env[k];

  const child = spawn(process.execPath, [ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(TMP, 'ud')}`],
    { cwd: ROOT, stdio: 'ignore', env });

  try {
    const dbg = await Cdp.attach(PORT);
    await dbg.send('Runtime.enable');
    await dbg.waitForApp();
    console.log('app ready');

    // start recording every status change
    await dbg.eval(`
      window.__log = [];
      window.__t0 = Date.now();
      window.__rec = setInterval(() => {
        for (const a of globalAgents.values()) {
          const last = window.__log[window.__log.length - 1];
          if (!last || last.status !== a.status) {
            window.__log.push({ at: ((Date.now()-window.__t0)/1000).toFixed(1), status: a.status });
          }
        }
      }, 200);
      true`);

    console.log('opening agent tab and launching claude...');
    await dbg.eval(`(async () => {
      await newAgentTab();
      const leaf = [...state.activeTab.centerLeaves][0];
      const until = Date.now() + 20000;
      while (!leaf.cwd && Date.now() < until) await new Promise(r=>setTimeout(r,100));
      api.ptyInput(leaf.ptyId, 'claude\\r');
      window.__leaf = leaf;
      const reg = Date.now() + 90000;
      while (globalAgents.size === 0 && Date.now() < reg) await new Promise(r=>setTimeout(r,200));
      return globalAgents.size;
    })()`);
    console.log('agent registered');

    await sleep(8000);
    console.log('status before prompting:', await dbg.eval(`[...globalAgents.values()].map(a=>a.status)`));

    console.log('prompting the agent...');
    await dbg.eval(`api.ptyInput(window.__leaf.ptyId, 'What is 2+2? Reply with just the number.\\r'), true`);

    // watch it work then settle
    for (let i = 0; i < 40; i++) {
      await sleep(3000);
      const s = await dbg.eval(`[...globalAgents.values()].map(a=>a.status)[0]`);
      if (s === 'done' || s === 'blocked') { console.log(`settled at ${s} after ~${(i+1)*3}s`); break; }
    }

    console.log('clicking between panes 5x (focus should not fake work)...');
    const beforeClicks = await dbg.eval(`[...globalAgents.values()].map(a=>a.status)[0]`);
    await dbg.eval(`(async () => {
      const tab = agentTabs()[0];
      const id = [...globalAgents.keys()][0];
      for (let i=0;i<5;i++){ selectAgent(tab, id); await new Promise(r=>setTimeout(r,900)); }
      return true;
    })()`);
    await sleep(1500);
    const afterClicks = await dbg.eval(`[...globalAgents.values()].map(a=>a.status)[0]`);

    console.log('idling 45s to check for drift...');
    await sleep(45000);
    const afterIdle = await dbg.eval(`[...globalAgents.values()].map(a=>a.status)[0]`);

    const log = await dbg.eval(`window.__log`);
    console.log('\n=== status timeline (seconds since start) ===');
    for (const e of log) console.log(`  ${String(e.at).padStart(6)}s  ${e.status}`);
    console.log('\n=== results ===');
    console.log('before clicks :', beforeClicks);
    console.log('after clicks  :', afterClicks, afterClicks === beforeClicks ? '(unchanged — good)' : '(CHANGED — focus still fakes work)');
    console.log('after 45s idle:', afterIdle, afterIdle === beforeClicks ? '(unchanged — good)' : '(DRIFTED)');
  } catch (e) {
    console.error('FAILED:', e.message);
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    app.exit(0);
  }
})();
