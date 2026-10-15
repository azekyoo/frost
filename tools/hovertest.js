// Checks that resting the pointer on an image path in a command shows its
// picture, and that the command block around it waits until the pointer leaves.
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(app.getPath('temp'), 'frost-hovertest');
const PORT = 9432;
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
  // Windows reports a window covered by others as hidden, and Chromium stops
  // drawing it — so a fit waiting on the next frame never comes, and the zoom
  // check failed whenever something else was on top of the test window.
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


    // A real command in the real shell, so it is a command block as well
    const runCommand = async (line) => {
      // a new prompt's mark, not a count of them: a clear takes marks away
      const lastId = '(activePane().marks.at(-1)?.marker.id ?? -1)';
      const before = await w.eval(lastId);
      await w.eval(`(() => { api.ptyInput(activePane().ptyId, ${JSON.stringify(line + '\r')}); return true })()`);
      const until = Date.now() + 20000;
      while ((await w.eval(lastId)) === before) {
        if (Date.now() > until) throw new Error('the shell never finished: ' + line);
        await sleep(250);
      }
    };
    await runCommand(`cd '${ROOT}'`);
    await runCommand('echo assets/icon-48.png');
    await sleep(500);

    // where "assets/icon-48.png" sits on screen, on the command's own row
    const spot = await w.eval(`(() => {
      const t = activePane().term;
      const buf = t.buffer.active;
      for (let r = buf.length - 1; r >= 0; r--) {
        const s = buf.getLine(r).translateToString(true);
        const i = s.indexOf('echo assets/icon-48.png');
        if (i < 0) continue;
        const box = t.element.querySelector('.xterm-screen').getBoundingClientRect();
        const cw = box.width / t.cols, ch = box.height / t.rows;
        const row = r - buf.viewportY;
        return { x: box.left + (i + 10) * cw, y: box.top + (row + 0.5) * ch };
      }
      return null;
    })()`);
    check('the command is on screen', !!spot, JSON.stringify(spot));

    const mouse = (x, y) => w.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await mouse(spot.x - 200, spot.y + 200);
    await sleep(300);
    await mouse(spot.x, spot.y);
    await sleep(80);
    await mouse(spot.x + 1, spot.y); // a hand is never perfectly still
    const seen = [];
    for (let i = 0; i < 24; i++) {
      await sleep(50);
      const s = await w.eval(`[!!document.querySelector('#image-card.show'), !!activePane().el.querySelector('.cmd-bar.on')]`);
      seen.push((s[0] ? 'C' : '-') + (s[1] ? 'B' : '-'));
    }
    console.log('  timeline (C card, B block bar, 50 ms steps): ' + seen.join(' '));
    const tail = seen.slice(-6);
    check('resting on an image path keeps the card', tail.every((s) => s[0] === 'C'), tail.join(' '));
    check('and holds the block bar off while it is up', tail.every((s) => s[1] === '-'), tail.join(' '));

    // off the path, still on the command: the block comes back
    await mouse(spot.x + 300, spot.y);
    await sleep(80);
    await mouse(spot.x + 301, spot.y);
    await sleep(700);
    const after = await w.eval(`[!!document.querySelector('#image-card.show'), !!activePane().el.querySelector('.cmd-bar.on')]`);
    check('moving off the path closes the card', !after[0]);
    check('and offers the block again', after[1]);

    // A column listing (PowerShell's ls, narrow): names cut short with …, and
    // a row filled right to the edge, which is not a wrapped line
    await runCommand('cls');
    await w.eval(`(() => {
      const t = activePane().term;
      const row1 = 'CHANGEL…  LICENSE  nowhere'.padEnd(t.cols - 'package.js…'.length) + 'package.js…';
      t.write('\\r\\n' + row1 + '\\r\\nREADME.md\\r\\n');
      return true;
    })()`);
    await sleep(400);
    const isLink = async (word) => {
      const spot = await w.eval(`(() => {
        const t = activePane().term, buf = t.buffer.active;
        for (let r = buf.length - 1; r >= 0; r--) {
          const s = buf.getLine(r).translateToString(true);
          const i = s.indexOf(${JSON.stringify(word)});
          if (i < 0) continue;
          const box = t.element.querySelector('.xterm-screen').getBoundingClientRect();
          const cw = box.width / t.cols, ch = box.height / t.rows;
          return { x: box.left + (i + 1.5) * cw, y: box.top + (r - buf.viewportY + 0.5) * ch };
        }
        return null;
      })()`);
      if (!spot) return 'not on screen';
      await mouse(spot.x, spot.y + 300);
      await sleep(150);
      await mouse(spot.x, spot.y);
      await sleep(700);
      return w.eval(`!!activePane().term.element.querySelector('.xterm-cursor-pointer') || activePane().term.element.classList.contains('xterm-cursor-pointer')`);
    };
    check('a name on the row after a full one is a link', (await isLink('README.md')) === true);
    check('a name cut short is a link to the one it starts', (await isLink('CHANGEL…')) === true);
    check('and at the very edge too', (await isLink('package.js…')) === true);
    check('a file without an extension is a link', (await isLink('LICENSE')) === true);
    check('a word that is no file is not', (await isLink('nowhere')) === false);

    // A folder in the listing: Ctrl+click opens Peek on its repo, the folder
    // unfolded and picked out
    await w.eval(`(() => { activePane().term.write('assets  docs\\r\\n'); return true })()`);
    await sleep(300);
    check('a folder is a link', (await isLink('assets')) === true);
    const at = await w.eval(`(() => {
      const t = activePane().term, buf = t.buffer.active;
      for (let r = buf.length - 1; r >= 0; r--) {
        if (!buf.getLine(r).translateToString(true).startsWith('assets  docs')) continue;
        const box = t.element.querySelector('.xterm-screen').getBoundingClientRect();
        return { x: box.left + 2.5 * (box.width / t.cols), y: box.top + (r - buf.viewportY + 0.5) * (box.height / t.rows) };
      }
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await w.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1, modifiers: 2 });
    }
    await sleep(1500);
    const peekState = await w.eval(`({
      open: !!document.querySelector('#peek.open'),
      picked: document.querySelector('#peek .peek-tree .peek-row.dir.selected')?.dataset.path || null
    })`);
    check('Ctrl+click on it opens Peek', peekState.open);
    check('with that folder picked out in the tree', peekState.picked === 'assets', JSON.stringify(peekState));

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('ERROR:', e.message);
    fail++;
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    app.exit(fail ? 1 : 0);
  }
})();
