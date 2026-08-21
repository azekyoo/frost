// Checks what the tab strip gained: dragging a tab sideways reorders it,
// dragging it off the strip opens it in a window of its own with the same shell
// still running and its scrollback intact, and a renamed tab keeps its name.
//
// It also drags a tab from one window onto the other and checks it is handed
// over rather than opening a third window.
//
// Real mouse events over the debugging protocol rather than calls into the drag
// functions: the thing worth testing is the gesture, including the slop
// threshold, the distance below the strip that means "detach", and the drop
// target main works out from the pointer.
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(app.getPath('temp'), 'frost-tabtest');
const PORT = 9424;
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
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      }
      return r.result?.value;
    },
    async mouse(type, x, y) {
      await send('Input.dispatchMouseEvent', {
        type,
        x: Math.round(x),
        y: Math.round(y),
        button: 'left',
        buttons: type === 'mouseReleased' ? 0 : 1,
        clickCount: 1
      });
    }
  };
}

// The copy of the tab that follows the cursor is a window of its own, so it
// appears here too — it is not a Frost window and is never counted as one.
const isGhost = (t) => /dragghost\.html/.test(t.url || '');

async function ghostTarget() {
  return (await targets()).find((t) => t.type === 'page' && isGhost(t)) || null;
}

async function pageClients() {
  const list = (await targets()).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && !isGhost(t));
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
      const ok = await c.eval(
        `Boolean(typeof state!=='undefined' && state.activeTab && state.activeTab.activePane && state.activeTab.activePane.cwd)`
      );
      if (ok) return;
    } catch {}
    if (Date.now() > until) throw new Error('window never became ready');
    await sleep(250);
  }
}

// The strip is the drag surface, so every gesture is expressed in its own
// coordinates: the centre of the nth tab, and how far below it to let go.
const tabRect = (n) =>
  `(() => { const r = el.tabstrip.children[${n}].getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, bottom: r.bottom }; })()`;

const bufferText = `(() => {
  const t = state.activeTab.activePane.term, b = t.buffer.active; let s = '';
  for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) s += l.translateToString(true) + '\\n'; }
  return s; })()`;

async function drag(c, from, to, { steps = 8, midway = null, hold = 0 } = {}) {
  await c.mouse('mousePressed', from.x, from.y);
  for (let i = 1; i <= steps; i++) {
    await c.mouse('mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await sleep(30);
    if (midway && i === steps) await midway();
  }
  if (hold) await sleep(hold);
  await c.mouse('mouseReleased', to.x, to.y);
}

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
    // No fixed bounds: the same rectangle for every window would put the second
    // one exactly on top of the first, and a hand-off needs somewhere to drop
    // that is over one window and not the other. Left alone, a new window is
    // offset from the one it was opened from, which gives that.
    FROST_SHOT: JSON.stringify({ configDir })
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
    let [w1] = await pageClients();
    await waitReady(w1);
    console.log('window ready');

    // two more tabs, so there is an order to change and a tab to move out
    await w1.eval('(async () => { await newTab(); await newTab(); return state.tabs.length })()');
    await sleep(2500);
    const count = await w1.eval('state.tabs.length');
    check('three tabs open', count === 3, `${count} tab(s)`);

    // --- reorder ---------------------------------------------------------
    const ids = await w1.eval('state.tabs.map((t) => t.id)');
    const first = await w1.eval(tabRect(0));
    const third = await w1.eval(tabRect(2));
    let ghostSeen = null;
    await drag(w1, first, { x: third.x, y: third.y }, {
      midway: async () => {
        const ghost = await ghostTarget();
        ghostSeen = ghost
          ? {
              title: ghost.title,
              placeholder: await w1.eval('Boolean(document.querySelector(".tab.dragging"))')
            }
          : null;
      }
    });
    await sleep(400);
    const after = await w1.eval('state.tabs.map((t) => t.id)');
    check(
      'dragging a tab along the strip reorders it',
      after[2] === ids[0] && after.length === 3,
      after.join(',')
    );
    const domOrder = await w1.eval('[...el.tabstrip.children].map((n) => n.tabData.id)');
    check('the strip and the tab list agree afterwards', domOrder.join(',') === after.join(','), domOrder.join(','));
    check('a copy of the tab follows the cursor', Boolean(ghostSeen), JSON.stringify(ghostSeen));
    check('and the tab it came from is left as a placeholder', ghostSeen?.placeholder === true);
    check('no placeholder is left once dropped', (await w1.eval('!document.querySelector(".tab.dragging")')) === true);

    // --- rename ----------------------------------------------------------
    await w1.eval(`(() => {
      startTabRename(state.tabs[0]);
      const input = document.querySelector('.tab-rename');
      input.value = 'renamed-tab';
      input.blur();
      return true; })()`);
    await sleep(300);
    const named = await w1.eval('state.tabs[0].customTitle');
    const shown = await w1.eval('el.tabstrip.children[0].querySelector(".title").textContent');
    check('a renamed tab keeps the name', named === 'renamed-tab', String(named));
    check('the strip shows it', shown === 'renamed-tab', String(shown));

    // emptying the name hands the tab back to its live title
    await w1.eval(`(() => {
      startTabRename(state.tabs[0]);
      const input = document.querySelector('.tab-rename');
      input.value = '   ';
      input.blur();
      return true; })()`);
    await sleep(300);
    const cleared = await w1.eval('state.tabs[0].customTitle');
    check('emptying it restores the live title', cleared === null, String(cleared));

    // --- move a tab to its own window ------------------------------------
    // A marker in the tab about to move, so the scrollback can be recognised
    // on the other side, and the shell's own identity checked afterwards
    await w1.eval(`(() => { activateTab(state.tabs[2]); return true })()`);
    await sleep(600);
    const movingPty = await w1.eval('state.activeTab.activePane.ptyId');
    await w1.eval(`api.ptyInput(state.activeTab.activePane.ptyId, 'echo MOVED_MARKER\\r'), true`);
    await sleep(2500);
    const beforeText = await w1.eval(bufferText);
    check('the marker is in the tab before it moves', beforeText.includes('MOVED_MARKER'));

    const moving = await w1.eval(tabRect(2));
    // held at the end: the drop target is asked for over IPC, and the answer
    // has to be in before the button comes up
    await drag(w1, moving, { x: moving.x, y: moving.bottom + 160 }, { hold: 400 });
    await sleep(4500);

    const leftBehind = await w1.eval('state.tabs.length');
    check('the tab left the window it was dragged from', leftBehind === 2, `${leftBehind} tab(s)`);

    const clients = await pageClients();
    check('a window opened for it', clients.length === 2, `${clients.length} page target(s)`);
    if (clients.length < 2) throw new Error('no second window');
    const w2 = clients.find((c) => c !== w1) || clients[1];
    await waitReady(w2);

    const adoptedPty = await w2.eval('state.activeTab.activePane.ptyId');
    check('it is the same shell, not a new one', adoptedPty === movingPty, `pty ${movingPty} -> ${adoptedPty}`);
    const movedText = await w2.eval(bufferText);
    check('the scrollback came with it', movedText.includes('MOVED_MARKER'));

    // and it is still a live shell in there
    await w2.eval(`api.ptyInput(state.activeTab.activePane.ptyId, 'echo STILL_ALIVE\\r'), true`);
    await sleep(2500);
    const aliveText = await w2.eval(bufferText);
    check('the shell still runs commands after the move', aliveText.includes('STILL_ALIVE'));

    const oldWindowPtys = await w1.eval('[...panesByPty.keys()]');
    check(
      'the window it left no longer holds the shell',
      !oldWindowPtys.includes(movingPty),
      oldWindowPtys.join(',')
    );

    // --- and back again ---------------------------------------------------
    // The second window sits offset from the first, so a point past the first
    // window's right edge is over the second and outside the first. Dropping a
    // tab of window 1 there is a hand-off, not a detach.
    // The drop point has to be just past window 1's right edge, in window 1's
    // own CSS pixels — which are not screen pixels when the monitor is scaled,
    // so the page's zoom factor is what converts the 25px overshoot.
    const geom = await w1.eval('({ z: uiZoom || 1, w: window.innerWidth })');
    const dropX = geom.w + 25 / geom.z;
    const probe = await w1.eval(`api.tabDropTarget({ x: ${dropX}, y: 300 })`);
    check('main can name the window under that point', Boolean(probe?.frostId), JSON.stringify(probe));
    const before1 = await w1.eval('state.tabs.length');
    const before2 = await w2.eval('state.tabs.length');
    const handing = await w1.eval(tabRect(1));
    let mergeGhost = null;
    await drag(
      w1,
      handing,
      { x: dropX, y: 300 },
      {
        hold: 500,
        midway: async () => {
          await sleep(200); // the drop-target answer arrives over IPC
          const ghost = await ghostTarget();
          mergeGhost = ghost
            ? await (async () => {
                const c = connect(ghost.webSocketDebuggerUrl);
                await c.ready;
                await c.send('Runtime.enable');
                return c.eval(`document.body.dataset.mode`);
              })()
            : null;
        }
      }
    );
    await sleep(3000);

    check('the copy says it will merge while over the other window', mergeGhost === 'merge', String(mergeGhost));
    const now1 = await w1.eval('state.tabs.length');
    const now2 = await w2.eval('state.tabs.length');
    check('the tab left the window it was dragged from', now1 === before1 - 1, `${before1} -> ${now1}`);
    check('the window it was dropped on took it', now2 === before2 + 1, `${before2} -> ${now2}`);
    const windowsNow = (await pageClients()).length;
    check('no third window was opened for it', windowsNow === 2, `${windowsNow} window(s)`);
    await w2.eval(`api.ptyInput(state.activeTab.activePane.ptyId, 'echo MERGED_ALIVE\\r'), true`);
    await sleep(2500);
    const mergedText = await w2.eval(bufferText);
    check('its shell survived the second move too', mergedText.includes('MERGED_ALIVE'));

    // --- dropped on the other window's tab strip -------------------------
    // The aim people actually take: its tabs, not its terminal. That point sits
    // at the same height as this window's own strip, which is why height cannot
    // be what decides between reordering here and handing the tab over.
    // In window 1's coordinates, where window 2's own strip is: the windows are
    // offset from each other, so window 1's strip height is above window 2
    // altogether and would be over nothing.
    const originY1 = await w1.eval('window.screenY');
    const stripScreenY = await w2.eval('window.screenY + el.tabstrip.getBoundingClientRect().top + 12');
    const stripY = stripScreenY - originY1;
    // A spare tab first: this window is down to its last one, and handing that
    // one over closes the window — which would leave nothing to ask afterwards.
    await w1.eval('(async () => { await newTab(); return state.tabs.length })()');
    await sleep(2000);
    const strip1 = await w1.eval('state.tabs.length');
    const strip2 = await w2.eval('state.tabs.length');
    const aiming = await w1.eval(tabRect(0));
    await drag(w1, aiming, { x: dropX, y: stripY }, { hold: 500 });
    await sleep(3000);
    const stripNow1 = await w1.eval('state.tabs.length');
    const stripNow2 = await w2.eval('state.tabs.length');
    check(
      "a tab dropped on the other window's tabs is handed over",
      stripNow2 === strip2 + 1,
      `${strip2} -> ${stripNow2}`
    );
    check('and leaves the window it came from', stripNow1 === strip1 - 1, `${strip1} -> ${stripNow1}`);
    const stillTwo = (await pageClients()).length;
    check('still two windows', stillTwo === 2, `${stillTwo} window(s)`);

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('ERROR:', e.message);
    fail++;
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    app.exit(fail ? 1 : 0);
  }
})();
