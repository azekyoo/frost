// Checks the two things a split layout needs from the keyboard: zooming one pane
// over its tab and back, and moving a divider a step at a time.
//
// The assertions are about what is actually on screen — the rectangles the panes
// occupy — rather than the numbers in the layout tree, since the tree agreeing
// with itself proves nothing about what the user sees.
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(app.getPath('temp'), 'frost-panetest');
const PORT = 9426;
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

// What each pane actually occupies, in the order the layout holds them
const paneBoxes = `(() => allLeaves(state.activeTab.root).map((l) => {
  const r = l.el.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
}))()`;

const run = (command) => `(() => { runCommand(${JSON.stringify(command)}); return true; })()`;

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
    [ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(TMP, 'ud')}`],
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

    // Two panes side by side, the second one focused
    await w.eval('(async () => { await splitPane("row"); return true })()');
    await sleep(2500);
    const split = await w.eval(paneBoxes);
    check('the tab has two panes', split.length === 2, JSON.stringify(split));
    check(
      'and they start out about the same width',
      Math.abs(split[0].w - split[1].w) <= 8,
      `${split[0].w} vs ${split[1].w}`
    );

    // --- resize ----------------------------------------------------------
    // The focused pane is the right-hand one, so its edge moving left widens it
    await w.eval(run('pane.resizeLeft'));
    await w.eval(run('pane.resizeLeft'));
    await sleep(600);
    const resized = await w.eval(paneBoxes);
    check(
      'moving the edge left widens the pane on its right',
      resized[1].w > split[1].w + 20 && resized[0].w < split[0].w - 20,
      `${resized[0].w} | ${resized[1].w}`
    );
    check(
      'and the two still fill the tab',
      Math.abs(resized[0].w + resized[1].w - (split[0].w + split[1].w)) <= 12,
      `${resized[0].w + resized[1].w}`
    );

    const back = await (async () => {
      await w.eval(run('pane.resizeRight'));
      await w.eval(run('pane.resizeRight'));
      await sleep(600);
      return w.eval(paneBoxes);
    })();
    check(
      'and it goes back the way it came',
      Math.abs(back[0].w - split[0].w) <= 8,
      `${back[0].w} vs ${split[0].w}`
    );

    // Up and down do nothing in a row-only layout: there is no boundary to move
    const beforeVertical = await w.eval(paneBoxes);
    await w.eval(run('pane.resizeUp'));
    await sleep(400);
    const afterVertical = await w.eval(paneBoxes);
    check(
      'a direction with no boundary to move does nothing',
      JSON.stringify(beforeVertical) === JSON.stringify(afterVertical),
      JSON.stringify(afterVertical)
    );

    // --- zoom ------------------------------------------------------------
    const tabWidth = await w.eval('Math.round(state.activeTab.contentEl.getBoundingClientRect().width)');
    await w.eval(run('pane.zoom'));
    await sleep(600);
    const zoomed = await w.eval(paneBoxes);
    const focusedIndex = await w.eval('allLeaves(state.activeTab.root).indexOf(state.activeTab.activePane)');
    check(
      'zoom gives the focused pane the whole tab',
      Math.abs(zoomed[focusedIndex].w - tabWidth) <= 4,
      `${zoomed[focusedIndex].w} of ${tabWidth}`
    );
    check('the strip says the tab is zoomed', (await w.eval(`Boolean(document.querySelector('.tab.active .tab-zoom'))`)) === true);
    check(
      'the shells behind it are still running',
      (await w.eval('allLeaves(state.activeTab.root).filter((l) => l.ptyId).length')) === 2
    );

    // The terminal in it was resized to match, or it would be drawing at its old size
    const cols = await w.eval('state.activeTab.activePane.term.cols');
    const wide = await w.eval('Math.floor(state.activeTab.activePane.el.getBoundingClientRect().width)');
    check('and its terminal was resized to fit', cols > 60, `${cols} cols in ${wide}px`);

    await w.eval(run('pane.zoom'));
    await sleep(600);
    const restored = await w.eval(paneBoxes);
    check(
      'unzooming puts the layout back exactly as it was',
      JSON.stringify(restored) === JSON.stringify(back),
      JSON.stringify(restored)
    );
    check('and the marker goes', (await w.eval(`Boolean(document.querySelector('.tab.active .tab-zoom'))`)) === false);

    // Splitting while zoomed would hide the new pane behind the old one
    await w.eval(run('pane.zoom'));
    await sleep(400);
    await w.eval('(async () => { await splitPane("col"); return true })()');
    await sleep(2500);
    const afterSplit = await w.eval('Boolean(state.activeTab.zoomedPane)');
    const paneCount = await w.eval('allLeaves(state.activeTab.root).length');
    check('splitting lets go of the zoom', afterSplit === false);
    check('and the new pane is really there', paneCount === 3, `${paneCount} panes`);

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('ERROR:', e.message);
    fail++;
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    app.exit(fail ? 1 : 0);
  }
})();
