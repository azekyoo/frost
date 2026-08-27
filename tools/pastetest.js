// Checks the two things that stand between the clipboard and the shell: the
// warning shown before pasting text with line breaks in it, and the ligature
// joiner that decides which characters are drawn as one piece of text.
//
// Both are asked of a real window — the modal that actually appears, and the
// joiner the terminal actually holds — rather than of the functions in isolation.
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(app.getPath('temp'), 'frost-pastetest');
const PORT = 9428;
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

// What the clipboard holds, put there through the page so the paste path is the
// real one — read back by the same navigator.clipboard the renderer uses. The
// clipboard refuses a document that is not focused, and another window stealing
// focus mid-run is ordinary, so the page is brought to the front each time.
async function setClipboard(w, text) {
  await w.send('Page.bringToFront');
  await w.eval(`navigator.clipboard.writeText(${JSON.stringify(text)}).then(() => true)`);
}

const modalState = `(() => {
  const root = document.getElementById('modal');
  return {
    open: root.classList.contains('open'),
    title: root.querySelector('.modal-title').textContent,
    note: root.querySelector('.modal-note').textContent,
    confirm: root.querySelector('.modal-confirm').textContent,
    cancel: root.querySelector('.modal-later').textContent
  }; })()`;

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
    FROST_SHOT: JSON.stringify({ configDir, bounds: { x: 40, y: 40, width: 1000, height: 700 } })
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

    // --- one line goes straight through ------------------------------------
    await setClipboard(w, 'echo one-liner');
    await w.eval('(() => { pasteInto(activePane().term); return true })()');
    await sleep(600);
    const quiet = await w.eval(modalState);
    check('a single line is pasted without asking', quiet.open === false, JSON.stringify(quiet.title));

    // --- several lines ask first --------------------------------------------
    // Inert on purpose: this is typed at a real shell, and a confirmed paste
    // does run it — which is the very thing the warning exists for
    await setClipboard(w, 'echo first\necho second\necho third\n');
    await w.eval('(() => { pasteInto(activePane().term); return true })()');
    await sleep(600);
    const asked = await w.eval(modalState);
    check('several lines are held back and asked about', asked.open === true, JSON.stringify(asked));
    check('it counts the lines', /3 lines/.test(asked.title), asked.title);
    check('it shows the first one', asked.note.includes('echo first'), asked.note);
    check('and the buttons are about pasting, not restarting', asked.confirm === 'Paste' && asked.cancel === 'Cancel', `${asked.confirm} / ${asked.cancel}`);

    // Cancelling types nothing at all
    const before = await w.eval('activePane().term.buffer.active.cursorY');
    await w.eval(`(() => { document.querySelector('#modal .modal-later').click(); return true })()`);
    await sleep(500);
    const afterCancel = await w.eval('activePane().term.buffer.active.cursorY');
    check('cancelling pastes nothing', afterCancel === before, `row ${before} -> ${afterCancel}`);

    // Confirming pastes it — into the prompt, not run, since nothing presses Enter
    await w.eval('(() => { pasteInto(activePane().term); return true })()');
    await sleep(500);
    await w.eval(`(() => { document.querySelector('#modal .modal-confirm').click(); return true })()`);
    await sleep(900);
    const line = await w.eval(`(() => {
      const b = activePane().term.buffer.active;
      let text = '';
      for (let i = 0; i < b.length; i++) text += (b.getLine(i)?.translateToString(true) || '') + '\\n';
      return text; })()`);
    check('confirming does paste it', line.includes('echo first'), line.slice(-120).trim());

    // --- turned off, nothing is asked ---------------------------------------
    await w.eval(`(() => { applyTheme({ ...state.theme, paste: { warnMultiline: false } }, undefined); return true })()`);
    await setClipboard(w, 'echo alpha\necho beta\n');
    await w.eval('(() => { pasteInto(activePane().term); return true })()');
    await sleep(700);
    const off = await w.eval(modalState);
    check('the warning can be turned off', off.open === false, JSON.stringify(off.title));

    // --- ligatures -----------------------------------------------------------
    const noJoiner = await w.eval('activePane().ligatureId === undefined');
    check('ligatures are off by default', noJoiner === true);
    await w.eval(`(() => {
      applyTheme({ ...state.theme, font: { ...state.theme.font, ligatures: true } }, undefined);
      return true })()`);
    await sleep(400);
    const joined = await w.eval('typeof activePane().ligatureId === "number"');
    check('turning them on registers a joiner', joined === true);

    // The joiner is what decides which characters are drawn as one run
    const ranges = await w.eval(`(() => {
      const found = [];
      const seen = new Set();
      const text = 'if (a != b) => c -> d';
      LIGATURES.lastIndex = 0;
      let m;
      while ((m = LIGATURES.exec(text))) found.push(text.slice(m.index, m.index + m[0].length));
      return found.join(' '); })()`);
    check('and it finds the sequences a ligature font draws', ranges === '!= => ->', ranges);

    // Joining alone renders nothing: Chromium suppresses ligature substitution
    // for any text whose letter-spacing is not zero, and xterm's DOM renderer
    // puts a sub-pixel correction on every span. This is the half that was
    // missing when the feature first went in and did visibly nothing.
    await w.eval(`(() => { activePane().term.write('a != b => c\\r\\n'); return true })()`);
    await sleep(600);
    const spacing = await w.eval(`(() => {
      const rows = [...document.querySelectorAll('.xterm-rows > div')];
      const row = rows.find((r) => r.textContent.includes('!='));
      const span = row && [...row.children].find((c) => c.textContent === '=>');
      if (!span) return 'no joined span';
      return getComputedStyle(span).letterSpacing; })()`);
    check('the joined run is left unspaced, so the font can shape it', spacing === 'normal' || spacing === '0px', String(spacing));

    await w.eval(`(() => {
      applyTheme({ ...state.theme, font: { ...state.theme.font, ligatures: false } }, undefined);
      return true })()`);
    await sleep(400);
    const gone = await w.eval('activePane().ligatureId === undefined');
    check('and turning them off takes it away again', gone === true);
    const restored = await w.eval(`(() => {
      const rows = [...document.querySelectorAll('.xterm-rows > div')];
      const row = rows.find((r) => r.textContent.includes('!='));
      const span = row && row.children[0];
      return span ? getComputedStyle(span).letterSpacing : 'none'; })()`);
    check('and the cell-width correction comes back', restored !== 'normal' && restored !== '0px', String(restored));

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('ERROR:', e.message);
    fail++;
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    app.exit(fail ? 1 : 0);
  }
})();
