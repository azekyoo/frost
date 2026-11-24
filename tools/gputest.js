// Checks that the GPU renderer is handed out by visibility: a pane holds a WebGL
// context while it is on screen, a couple of recently hidden panes keep theirs so
// flipping back is instant, and every other shell gives its context back. One
// context per shell, hidden tabs included, is what made typing lag.
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(app.getPath('temp'), 'frost-gputest');
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

// Which panes hold a WebGL context, by tab position
const gpuState = `(() => state.tabs.map((t) => allLeaves(t.root).map((l) => Boolean(l.webgl))))()`;
const countGpu = `(() => [...panesByPty.values()].filter((n) => n.webgl).length)()`;
const activeHasGpu = `Boolean(state.activeTab.activePane.webgl)`;

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const configDir = path.join(TMP, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'theme.json'),
    JSON.stringify(
      {
        material: 'glass',
        gpuRenderer: true,
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
    FROST_SHOT: JSON.stringify({ configDir, bounds: { x: 40, y: 40, width: 1100, height: 700 } })
  };
  for (const k of Object.keys(env)) if (/^CLAUDE/i.test(k)) delete env[k];
  const child = spawn(
    process.execPath,
    [
      ROOT,
      '--disable-features=CalculateNativeWinOcclusion',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${path.join(TMP, 'ud')}`
    ],
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
    await sleep(500);
    check('the first pane draws with the GPU', await w.eval(activeHasGpu));

    // Six tabs: only the one on screen and the two hidden most recently keep one
    for (let i = 0; i < 5; i++) {
      await w.eval('(async () => { await newTab(); return true })()');
      await sleep(1200);
    }
    await sleep(500);
    check('six tabs open', (await w.eval('state.tabs.length')) === 6);
    check('the tab on screen draws with the GPU', await w.eval(activeHasGpu));
    const n = await w.eval(countGpu);
    check('only three of six shells hold a context', n === 3, `${n} — ${JSON.stringify(await w.eval(gpuState))}`);
    const recent = await w.eval(gpuState);
    check(
      'and they are the visible tab and the two before it',
      JSON.stringify(recent.map((t) => t[0])) === JSON.stringify([false, false, false, true, true, true]),
      JSON.stringify(recent)
    );

    // Back to a recent tab: its context was kept, nothing to rebuild
    const keptBefore = await w.eval(`(() => { const t = state.tabs[4]; return allLeaves(t.root)[0].webgl; })() !== null`);
    await w.eval('(() => { activateTab(state.tabs[4]); return true })()');
    await sleep(300);
    check('a recently hidden tab comes back with its context', keptBefore && (await w.eval(activeHasGpu)));

    // Back to the oldest tab: it gets a context again, in the same moment it is
    // shown, so no frame is painted by the DOM renderer first (that frame blinks)
    const sameMoment = await w.eval(`(() => { activateTab(state.tabs[0]); return ${activeHasGpu}; })()`);
    check('an old tab has its context before its first frame', sameMoment === true);
    // and has drawn into it: a fresh canvas left for xterm's own observer is
    // blank for that frame
    await w.eval('(() => { activateTab(state.tabs[5]); return true })()');
    await sleep(300);
    const drewNow = await w.eval(`(() => {
      const leaf = allLeaves(state.tabs[1].root)[0];
      let drew = false;
      const sub = leaf.term.onRender(() => { drew = true; });
      activateTab(state.tabs[1]);
      sub.dispose();
      return { gpu: Boolean(leaf.webgl), drew };
    })()`);
    check('and a tab given a new context draws before its first frame', drewNow.gpu && drewNow.drew, JSON.stringify(drewNow));
    await w.eval('(() => { activateTab(state.tabs[0]); return true })()');
    await sleep(300);
    await sleep(300);
    check('an old tab gets a context when shown again', await w.eval(activeHasGpu));

    const after = await w.eval(countGpu);
    check('and the total stays at three', after === 3, JSON.stringify(await w.eval(gpuState)));

    // A shell that comes up while its tab is in the background leaves no light
    // behind: the tab was out of the page when the light should have faded
    await w.eval('(async () => { await newTab(); return true })()');
    await w.eval('(() => { activateTab(state.tabs[0]); return true })()');
    await sleep(6000);
    const stuck = await w.eval(`Boolean(state.tabs[state.tabs.length - 1].contentEl.querySelector('.pane-loading'))`);
    check('a tab whose shell came up in the background shows no loading light', stuck === false);
    await w.eval('(() => { closeTab(state.tabs[state.tabs.length - 1]); activateTab(state.tabs[0]); return true })()');
    await sleep(500);

    // Splits on screen all draw with the GPU, whatever the hidden count
    await w.eval('(async () => { await splitPane("row"); await splitPane("col"); return true })()');
    await sleep(2500);
    const panes = await w.eval(`allLeaves(state.activeTab.root).map((l) => Boolean(l.webgl))`);
    check('every pane in a split on screen has a context', panes.length === 3 && panes.every(Boolean), JSON.stringify(panes));

    // Closing a tab lets go of its panes entirely
    await w.eval('(() => { closeTab(state.tabs[0]); return true })()');
    await sleep(500);
    const watched = await w.eval('gpuPanes.size');
    const live = await w.eval('panesByPty.size');
    check('a closed pane is no longer watched', watched === live, `${watched} watched, ${live} live`);

    // Turning the setting off gives everything back
    await w.eval('(() => { state.theme.gpuRenderer = false; for (const n of panesByPty.values()) applyGpu(n); return true })()');
    check('with the setting off no pane holds a context', (await w.eval(countGpu)) === 0);

    console.log(`\n${pass} passed, ${fail} failed`);
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
