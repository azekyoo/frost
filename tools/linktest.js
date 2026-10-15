// Checks that a path wrapped onto a second row is still read as one path:
// soft wraps the terminal made, and hard wraps a program made itself.
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(app.getPath('temp'), 'frost-linktest');
const PORT = 9431;
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

    // A 30-column terminal written to directly, so the rows are exactly known
    const line = (writes, y) => `(async () => {
      const t = new Terminal({ cols: 30, rows: 10, allowProposedApi: true });
      for (const s of ${JSON.stringify(writes)}) await new Promise((r) => t.write(s, r));
      const l = logicalLine(t, ${y});
      t.dispose();
      return { text: l.text, first: l.map[0], last: l.map[l.map.length - 1], map: l.map };
    })()`;

    const soft = 'C:/aaaaaaaaaa/bbbbbbbbbbbbbbbbbbbb/icon.png';
    let r = await w.eval(line([soft], 1));
    check('a soft-wrapped path is one line from its first row', r.text === soft, r.text);
    r = await w.eval(line([soft], 2));
    check('and from its second row', r.text === soft, r.text);
    check('and ends on the second row', r.last.y === 2 && r.last.x === soft.length - 30, JSON.stringify(r.last));

    const head = '  see C:/xx/yyyyyyyyyyyyyyyyyy'; // 30 columns exactly
    r = await w.eval(line([head + '\r\n  zzz/icon.png'], 2));
    check(
      'a hard-wrapped path drops the indent of its second row',
      r.text === head.trimEnd() + 'zzz/icon.png',
      r.text
    );
    const z = r.map[head.length];
    check('and maps its rest to where it is on screen', z.x === 3 && z.y === 2, JSON.stringify(z));

    r = await w.eval(line(['hello\r\nworld'], 1));
    check('short rows are left alone', r.text === 'hello', r.text);

    r = await w.eval(line(['日本 C:/a.png'], 1));
    check('a wide character takes two cells', r.map[3].x === 6, JSON.stringify(r.map[3]));

    // Punctuation glued after a path is prose, a line number is not
    const trims = await w.eval(
      `['panes.js:', '\`panes.js\`:', 'a.js:12:', 'a.js:12', '(a.js),', 'a.js.'].map(trimCandidate)`
    );
    check(
      'a colon after a path is dropped, a line number kept',
      JSON.stringify(trims) === JSON.stringify(['panes.js', 'panes.js', 'a.js:12', 'a.js:12', 'a.js', 'a.js']),
      JSON.stringify(trims)
    );

    // A bare name not in the shell's folder is found by name in its repo
    const repo = JSON.stringify(ROOT);
    const res = await w.eval(
      `api.resolvePaths(${repo}, ['icon-48.png', 'panes.js', 'screenshot-hero.png', 'no-such-file.png', 'package.json', 'assets', 'src/renderer', 'renderer', 'the'])`
    );
    const found = res.paths;
    check('a bare name found once in the repo is a link', /assets[\\/]icon-48\.png$/.test(found['icon-48.png'] || ''), found['icon-48.png']);
    check('for any kind of file', /src[\\/]renderer[\\/]panes\.js$/.test(found['panes.js'] || ''), found['panes.js']);
    check('a name the repo has twice is not', !found['screenshot-hero.png'], found['screenshot-hero.png']);
    check('nor one it does not have', !found['no-such-file.png']);
    check('the shell folder still comes first', /frost[\\/]package\.json$/.test(found['package.json'] || ''), found['package.json']);

    // folders, where the shell is; never searched for by name
    check('a folder in the shell folder is a link', /frost[\\/]assets$/.test(res.dirs['assets'] || ''), res.dirs['assets']);
    check('a path to a folder too', /src[\\/]renderer$/.test(res.dirs['src/renderer'] || ''), res.dirs['src/renderer']);
    check('a folder elsewhere in the repo is not', !res.dirs['renderer']);
    check('nor a word of prose', !res.dirs['the'] && !res.paths['the']);

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('ERROR:', e.message);
    fail++;
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    app.exit(fail ? 1 : 0);
  }
})();
