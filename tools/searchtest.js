// Checks that the buffer search's three options do what their buttons claim:
// match case, whole word, regular expression. The addon has always supported
// them, so what is being tested is that the bar passes them through, that the
// buttons reflect one shared set of options, and that a half-typed regex is
// reported as such rather than searched for.
//
// Driven over the debugging protocol against a real pane holding known text.
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(app.getPath('temp'), 'frost-searchtest');
const PORT = 9425;
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

// The count the bar itself shows: what the user reads, rather than what the
// addon was asked. "3/5" means five matches, "No results" means none.
const countText = `document.querySelector('.pane-search.open .pane-search-count').textContent`;

// The search runs on input, so the query is typed the way a person types it
const typeQuery = (q) => `(() => {
  const pane = activePane();
  openPaneSearch(pane);
  pane.searchInput.value = ${JSON.stringify(q)};
  pane.searchInput.dispatchEvent(new Event('input'));
  return true; })()`;

const setOptions = (opts) => `(() => {
  Object.assign(searchOptions, ${JSON.stringify(opts)});
  applySearchOptions(); // what a toggle button does
  return JSON.stringify(searchOptions); })()`;

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

    // Known text, written straight into the terminal rather than run as a
    // command: the shell would echo the line and change the counts.
    await w.eval(`(() => {
      const t = activePane().term;
      t.write('needle Needle NEEDLEHAY haystack needles\\r\\n');
      return true; })()`);
    await sleep(600);

    await w.eval(setOptions({ caseSensitive: false, wholeWord: false, regex: false }));
    await w.eval(typeQuery('needle'));
    await sleep(500);
    const plain = await w.eval(countText);
    check('a plain search finds every spelling', /\/4$/.test(plain), plain);

    await w.eval(setOptions({ caseSensitive: true }));
    await sleep(500);
    const cased = await w.eval(countText);
    check('match case drops the other spellings', /\/2$/.test(cased), cased);

    await w.eval(setOptions({ caseSensitive: false, wholeWord: true }));
    await sleep(500);
    const word = await w.eval(countText);
    check('whole word drops the ones inside longer words', /\/2$/.test(word), word);

    await w.eval(setOptions({ wholeWord: false, regex: true }));
    await w.eval(typeQuery('need(le|les)\\b'));
    await sleep(500);
    const rx = await w.eval(countText);
    check('a regular expression is treated as one', /\/3$/.test(rx), rx);

    await w.eval(typeQuery('need(le'));
    await sleep(400);
    const bad = await w.eval(countText);
    const marked = await w.eval(`document.querySelector('.pane-search.open').classList.contains('bad')`);
    check('a half-typed pattern is reported, not searched', bad === 'Bad pattern', bad);
    check('and the box says so', marked === true);

    // --- more matches than the addon tracks --------------------------------
    // Past its highlight limit it stops knowing which match is current and
    // reports -1, which used to render as "0/1000": a position it does not have,
    // and a total that is only the ceiling.
    await w.eval(setOptions({ caseSensitive: false, wholeWord: false, regex: false }));
    await w.eval(`(() => {
      const t = activePane().term;
      for (let i = 0; i < 40; i++) t.write('hay '.repeat(40) + '\\r\\n');
      return true; })()`);
    await sleep(800);
    await w.eval(typeQuery('hay'));
    await sleep(1200);
    const many = await w.eval(countText);
    check('past the tracking limit it says so rather than claiming 0', /\+ matches$/.test(many), many);

    // --- how much is kept -------------------------------------------------
    const limit = await w.eval('activePane().term.options.scrollback');
    check('scrollback follows the setting', limit === 10000, String(limit));
    const changed = await w.eval(`(() => {
      const t = { ...state.theme, scrollback: 25000 };
      applyTheme(t, undefined);
      return activePane().term.options.scrollback; })()`);
    check('and a new value reaches the panes already open', changed === 25000, String(changed));
    const clamped = await w.eval(`(() => {
      applyTheme({ ...state.theme, scrollback: 5 }, undefined);
      return activePane().term.options.scrollback; })()`);
    check('an unusable value is brought into range', clamped === 1000, String(clamped));
    await w.eval(`(() => { applyTheme({ ...state.theme, scrollback: 10000 }, undefined); return true })()`);

    // The options are one set for the app, so a second pane's buttons show them
    await w.eval('(async () => { await splitPane("row"); return true })()');
    await sleep(2500);
    const shown = await w.eval(`(() => {
      const panes = allPanes();
      const other = panes[panes.length - 1];
      openPaneSearch(other);
      return other.searchToggles.map((b) => b.classList.contains('on')).join(','); })()`);
    check('a new pane shows the same options', shown === 'false,false,false', shown);

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('ERROR:', e.message);
    fail++;
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    app.exit(fail ? 1 : 0);
  }
})();
