// Checks that Frost can hand you one command's output without you selecting it.
//
// Everything here goes through a real PowerShell: the marks come from the prompt
// hook, so the only honest test is to type commands, let the shell answer, and
// then ask for the output of the one that just ran. The assertions are on the
// selected text — what a copy would put on the clipboard — rather than on line
// numbers, since the point is the text, not the arithmetic.
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(app.getPath('temp'), 'frost-marktest');
const PORT = 9427;
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

// Typed into the real shell, then waited on until the prompt hook has closed the
// command — that closing mark is what the whole feature is built on.
async function runCommand(w, line) {
  const before = await w.eval('(activePane().marks || []).length');
  await w.eval(`(() => { api.ptyInput(activePane().ptyId, ${JSON.stringify(line + '\r')}); return true })()`);
  const until = Date.now() + 20000;
  for (;;) {
    const now = await w.eval('(activePane().marks || []).length');
    if (now > before) return;
    if (Date.now() > until) throw new Error('the shell never reported finishing: ' + line);
    await sleep(250);
  }
}

// xterm joins rows with CRLF on Windows, which is what the clipboard wants
// there; the assertions are about the text, not about which newline it uses
const select = `(() => { const t = selectCommandOutput(activePane()); return t === null ? null : t.split('\\r\\n').join('\\n'); })()`;

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
        copyOnSelect: false, // the clipboard is not what is being tested
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
    FROST_SHOT: JSON.stringify({ configDir, bounds: { x: 40, y: 40, width: 900, height: 700 } })
  };
  for (const k of Object.keys(env)) if (/^CLAUDE/i.test(k)) delete env[k];
  const child = spawn(
    process.execPath,
    // keep drawing while covered: see the note in panetest.js
    [ROOT, '--disable-features=CalculateNativeWinOcclusion', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(TMP, 'ud')}`],
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

    // --- a plain command --------------------------------------------------
    await runCommand(w, 'echo alpha; echo beta; echo gamma');
    await sleep(400);
    const three = await w.eval(select);
    check('the output is exactly what the command printed', three === 'alpha\nbeta\ngamma', JSON.stringify(three));

    // --- and nothing around it -------------------------------------------
    check('the command line itself is not included', !String(three).includes('echo alpha'), JSON.stringify(three));
    check('and neither is the prompt', !/PS .*>/.test(String(three)), JSON.stringify(three));

    // --- a line longer than the window ------------------------------------
    // Wrapped rows are one line, and a copy that breaks them where the window
    // happens to end is a copy that cannot be pasted back
    await runCommand(w, "'x' * 300");
    await sleep(400);
    const long = await w.eval(select);
    check('a wrapped line comes back as one line', long === 'x'.repeat(300), `${String(long).length} chars, ${String(long).split('\n').length} line(s)`);

    // --- a command that printed nothing ------------------------------------
    await runCommand(w, '$null = 1');
    await sleep(400);
    const empty = await w.eval(select);
    check('a command that printed nothing selects nothing', empty === null, JSON.stringify(empty));

    // --- one that failed without a word --------------------------------------
    // still a command to send: that it failed is the whole message
    await runCommand(w, 'cmd /c exit 4');
    await sleep(400);
    const silent = await w.eval(`(() => {
      activePane().term.clearSelection(); // the earlier checks' selection would be sent instead
      const out = commandOutput(activePane());
      return out && { command: out.command, exit: out.exit, message: outputPrompt(out, 'C:\\\\dev\\\\demo') };
    })()`);
    check(
      'a silent failure is sent as one',
      silent?.message === '`cmd /c exit 4` failed (exit 4) in demo, printing nothing.',
      JSON.stringify(silent)
    );

    // --- scrolled up, it is still the last command -------------------------
    // what is on screen doesn't change what ran last, which is what is meant
    await runCommand(w, 'echo needle-one');
    await runCommand(w, '1..60 | ForEach-Object { "filler $_" }');
    await sleep(600);
    const scrolled = await w.eval(`(() => {
      const node = activePane();
      const marks = liveMarks(node);
      // the prompt of the echo, two commands back, put at the top of the screen
      node.term.scrollToLine(Math.max(0, marks[marks.length - 3].marker.line));
      return true; })()`);
    await sleep(400);
    const onScreen = await w.eval(select);
    check(
      'scrolled up, it still takes the last command',
      String(onScreen).startsWith('filler 1\n') && String(onScreen).endsWith('filler 60'),
      JSON.stringify(String(onScreen).slice(0, 40))
    );
    await w.eval('(() => { activePane().term.scrollToBottom(); return true })()');

    // --- what goes to an agent ---------------------------------------------
    // The command as typed, without the prompt in front of it, how it ended,
    // and what it printed — and the clipboard left alone while reading it
    await runCommand(w, 'cmd /c "echo boom & exit 3"');
    await sleep(600);
    // At the bottom, as after running it — the scroll lands a moment later —
    // and with the earlier checks' selection gone, so what is left selected
    // afterwards is this read's doing
    await w.eval('(() => { const t = activePane().term; t.scrollToBottom(); t.clearSelection(); return true })()');
    await sleep(200);
    const sent = await w.eval(`(() => {
      const node = activePane();
      const out = commandOutput(node);
      return out && { ...out, message: outputPrompt(out, 'C:\\\\dev\\\\demo') };
    })()`);
    check('the command is what was typed', sent?.command === 'cmd /c "echo boom & exit 3"', JSON.stringify(sent?.command));
    check('a failure is reported as one', sent?.exit === 3, JSON.stringify(sent?.exit));
    check('the output comes with it', JSON.stringify(sent?.output) === '["boom"]', JSON.stringify(sent?.output));
    check(
      'the message says what failed, where',
      /^`cmd \/c "echo boom & exit 3"` failed \(exit 3\) in demo:\n\n```\nboom\n```$/.test(sent?.message || ''),
      JSON.stringify(sent?.message)
    );
    const selection = await w.eval('activePane().term.hasSelection()');
    check('reading it selects nothing', selection === false, String(selection));

    // --- Enter on an empty line ------------------------------------------------
    // Redraws the prompt with $? still holding the failure: no command, and the
    // failure above is still the one to send — not an empty one at each prompt
    const marksBefore = await w.eval('liveMarks(activePane()).length');
    for (let i = 0; i < 2; i++) {
      await w.eval(`(() => { api.ptyInput(activePane().ptyId, '\\r'); return true })()`);
      await sleep(1200);
    }
    const afterEmpty = await w.eval(`(() => {
      const node = activePane();
      const marks = liveMarks(node);
      const out = commandOutput(node);
      return { marks: marks.length, open: marks[marks.length - 1].exit, command: out?.command, exit: out?.exit, output: out?.output };
    })()`);
    check('an empty Enter adds no command', afterEmpty.marks === marksBefore, `${marksBefore} → ${afterEmpty.marks}`);
    check('and reports no result', afterEmpty.open === null, JSON.stringify(afterEmpty.open));
    check(
      'the failure before it is still what gets sent',
      afterEmpty.command === 'cmd /c "echo boom & exit 3"' && afterEmpty.exit === 3,
      JSON.stringify(afterEmpty)
    );
    check('with its own output, not the empty prompts after it', JSON.stringify(afterEmpty.output) === '["boom"]', JSON.stringify(afterEmpty.output));

    // --- while the next one runs ----------------------------------------------
    // its output so far is the last output, so that is what goes
    await w.eval(`(() => { api.ptyInput(activePane().ptyId, 'echo early; Start-Sleep 3\\r'); return true })()`);
    await sleep(1500);
    const busy = await w.eval('(() => { const o = commandOutput(activePane()); return o && { running: !!o.running, output: o.output }; })()');
    check('while a command runs, its output so far is sent', busy?.running && JSON.stringify(busy.output) === '["early"]', JSON.stringify(busy));
    await sleep(2500);

    // --- a line the program broke at the edge itself ---------------------------
    // A real newline right at the last column, as a remote shell redrawing a
    // long command sends: read back as the one line it is
    const cols = await w.eval('activePane().term.cols');
    await runCommand(w, `[Console]::Write(('z' * ${cols}) + "\`r\`n" + "tail\`r\`n")`);
    await sleep(400);
    const edge = await w.eval('(() => { const o = commandOutput(activePane()); return o && o.output; })()');
    check('a row cut at the edge is joined to the next', JSON.stringify(edge) === JSON.stringify(['z'.repeat(cols) + 'tail']), JSON.stringify(edge));

    // --- inside another shell ---------------------------------------------------
    // ssh to a machine without Frost's hooks: the local command never finishes,
    // and the command worth sending is the last one run at the far end's prompt
    const before = await w.eval('(activePane().marks || []).length');
    await w.eval(`(() => { api.ptyInput(activePane().ptyId, 'pwsh -NoLogo -NoProfile\\r'); return true })()`);
    await sleep(4000);
    const nested = (await w.eval('(activePane().marks || []).length')) === before;
    await w.eval(`(() => { api.ptyInput(activePane().ptyId, 'echo inner-one; echo inner-two\\r'); return true })()`);
    await sleep(1500);
    const inner = await w.eval('(() => { const o = commandOutput(activePane()); return o && { command: o.command, output: o.output, exit: o.exit }; })()');
    if (nested) {
      check('inside another shell, it takes the last command there', inner?.command === 'echo inner-one; echo inner-two', JSON.stringify(inner?.command));
      check('and what it printed, up to the next prompt', JSON.stringify(inner?.output) === '["inner-one","inner-two"]', JSON.stringify(inner?.output));
    } else {
      console.log('  SKIP  the nested shell reported its own marks — nothing foreign to read');
    }

    // --- a selection -------------------------------------------------------------
    // what is selected goes as it stands, whatever is running
    const picked = await w.eval(`(() => {
      const node = activePane();
      const marks = liveMarks(node);
      node.term.selectLines(marks[marks.length - 1].marker.line + 2, marks[marks.length - 1].marker.line + 2);
      const o = commandOutput(node);
      node.term.clearSelection();
      return o && { selection: o.selection, output: o.output };
    })()`);
    check('a selection is sent as it stands', picked?.selection === true && picked.output.length === 1, JSON.stringify(picked));
    await w.eval(`(() => { api.ptyInput(activePane().ptyId, 'exit\\r'); return true })()`);
    await sleep(1500);

    // --- select all --------------------------------------------------------
    await w.eval(`(() => { runCommand('view.selectAll'); return true })()`);
    await sleep(300);
    const all = await w.eval('activePane().term.getSelection()');
    check('select all takes the whole buffer', all.includes('alpha') && all.includes('needle-one') && /PS .*>/.test(all), `${all.length} chars`);

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('ERROR:', e.message);
    fail++;
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    app.exit(fail ? 1 : 0);
  }
})();
