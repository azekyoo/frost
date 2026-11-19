// Clicking a Claude Code session in the rail twice must not resume it twice. Runs without claude installed being relevant: the command simply
// fails inside the pane, while the pane bookkeeping — the thing under test — is
// identical either way.
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DEMO = 'C:\\dev\\aurora-notes';
const LAB = path.join(app.getPath('temp'), 'frost-resumelab');
const PORT = 9600;
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
  fs.rmSync(LAB, { recursive: true, force: true });
  const configDir = path.join(LAB, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'theme.json'), JSON.stringify({
    material: 'glass', restoreSession: false, autoDetectAgents: false, startDir: DEMO,
    notify: { agentBlocked: false, agentDone: false, commandSeconds: 0 }
  }, null, 2));
  fs.writeFileSync(path.join(configDir, 'agents.json'), JSON.stringify({ spaces: [] }, null, 2));
  // a Claude Code transcript for the rail to offer, in a config dir of its own
  // so the real ~/.claude is never read
  const claudeDir = path.join(LAB, 'claude');
  const SID = '00000000-0000-4000-8000-000000000001';
  const project = path.join(claudeDir, 'projects', 'C--dev-aurora-notes');
  fs.mkdirSync(project, { recursive: true });
  // a second one, open in "another terminal": this test runner's own pid, so
  // the process is alive, and a /rename name that has to win over its title
  const SID2 = '00000000-0000-4000-8000-000000000002';
  fs.writeFileSync(path.join(project, SID2 + '.jsonl'), [
    { type: 'user', cwd: DEMO, sessionId: SID2, gitBranch: 'main', message: { role: 'user', content: 'yo' } },
    { type: 'ai-title', aiTitle: 'Old title', sessionId: SID2 }
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(project, SID2 + '.jsonl'), past, past); // older, so Lab session is listed first
  fs.mkdirSync(path.join(claudeDir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'sessions', process.pid + '.json'), JSON.stringify({
    pid: process.pid, sessionId: SID2, cwd: DEMO, name: 'Renamed elsewhere', nameSource: 'user'
  }));
  // Enough newer sessions to fill the Sessions list, then one in another folder
  // behind them: off the list, but New session still has to offer its folder.
  for (let i = 0; i < 38; i++) {
    const id = `00000000-0000-4000-8000-1000000000${String(i).padStart(2, '0')}`;
    const f = path.join(project, id + '.jsonl');
    fs.writeFileSync(f, JSON.stringify({ type: 'user', cwd: DEMO, sessionId: id, message: { role: 'user', content: 'filler ' + i } }) + '\n');
    const t = new Date(Date.now() - (2 + i) * 60000);
    fs.utimesSync(f, t, t);
  }
  const OLD = path.join(LAB, 'old-project');
  const LIVE = path.join(LAB, 'live-project');
  fs.mkdirSync(OLD, { recursive: true });
  fs.mkdirSync(LIVE, { recursive: true });
  const oldProject = path.join(claudeDir, 'projects', 'lab-old-project');
  fs.mkdirSync(oldProject, { recursive: true });
  const oldFile = path.join(oldProject, '00000000-0000-4000-8000-000000000003.jsonl');
  fs.writeFileSync(oldFile, JSON.stringify({ type: 'user', cwd: OLD, sessionId: 'old', message: { role: 'user', content: 'long ago' } }) + '\n');
  const dayAgo = new Date(Date.now() - 86400e3);
  fs.utimesSync(oldFile, dayAgo, dayAgo);

  // Two more, each on a live stand-in process. One file's procStart matches its
  // process: a claude still open elsewhere. The other's doesn't: a file left by
  // a shutdown whose pid went to someone else after the reboot.
  const sitters = [0, 1].map(() => spawn('ping', ['-n', '300', '127.0.0.1'], { stdio: 'ignore', windowsHide: true }));
  await sleep(500);
  const startOf = (pid) => spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`], { encoding: 'utf8' }).stdout.trim();
  const SID_LIVE = '00000000-0000-4000-8000-000000000004';
  const SID_REUSED = '00000000-0000-4000-8000-000000000005';
  for (const [i, sid, title, procStart] of [
    [0, SID_LIVE, 'Truly open', startOf(sitters[0].pid)],
    [1, SID_REUSED, 'Pid reused', '134000000000000000']
  ]) {
    const f = path.join(project, sid + '.jsonl');
    fs.writeFileSync(f, [
      { type: 'user', cwd: DEMO, sessionId: sid, message: { role: 'user', content: title } },
      { type: 'ai-title', aiTitle: title, sessionId: sid }
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const t = new Date(Date.now() - (70 + i * 10) * 1000); // just behind "Renamed elsewhere"
    fs.utimesSync(f, t, t);
    fs.writeFileSync(path.join(claudeDir, 'sessions', sitters[i].pid + '.json'), JSON.stringify({
      pid: sitters[i].pid, sessionId: sid, cwd: DEMO, procStart, name: 'derived', nameSource: 'derived'
    }));
  }

  // and a leftover from a crashed claude, whose pid is long gone
  fs.writeFileSync(path.join(claudeDir, 'sessions', '999999.json'), JSON.stringify({
    pid: 999999, sessionId: SID, cwd: DEMO, name: 'ghost', nameSource: 'user'
  }));
  fs.writeFileSync(path.join(project, SID + '.jsonl'), [
    { type: 'user', cwd: DEMO, sessionId: SID, gitBranch: 'main', message: { role: 'user', content: 'hi' } },
    { type: 'ai-title', aiTitle: 'Lab session', sessionId: SID }
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');

  const env = { ...process.env, FROST_SHOT: JSON.stringify({ configDir, bounds: { x: 50, y: 50, width: 1150, height: 680 } }) };
  for (const k of Object.keys(env)) if (/^CLAUDE/i.test(k)) delete env[k];
  env.CLAUDE_CONFIG_DIR = claudeDir;
  // keep drawing while covered: see the note in panetest.js
  const child = spawn(process.execPath, [ROOT, '--disable-features=CalculateNativeWinOcclusion', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(LAB, 'ud')}`],
    { cwd: ROOT, stdio: 'ignore', env });

  let pass = 0, fail = 0;
  const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

  try {
    await sleep(4000);
    const list = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())).filter(t => t.type === 'page');
    const c = connect(list[0].webSocketDebuggerUrl);
    await c.ready; await c.send('Runtime.enable');
    for (let i = 0; i < 140; i++) {
      if (await c.eval(`Boolean(typeof state!=='undefined' && state.activeTab && state.activeTab.activePane && state.activeTab.activePane.cwd)`)) break;
      await sleep(200);
    }

    await c.eval(`(async () => { await newAgentTab(); return true; })()`);
    await sleep(2500);
    const rows = await c.eval(`[...agentTabs()[0].els.sessionsList.querySelectorAll('.agent-row.dormant')].map((r) => r.querySelector('.agent-name').textContent + ' | ' + r.querySelector('.agent-meta').textContent)`);
    check('the session is offered by its title', rows[0] === 'Lab session | aurora-notes · just now', JSON.stringify(rows));
    check('a crashed leftover does not count as running', !String(rows[0]).includes('elsewhere') && !rows.some((r) => r.startsWith('ghost')));
    check('one open elsewhere says so, under its /rename name',
      rows[1] === 'Renamed elsewhere | aurora-notes · open elsewhere', JSON.stringify(rows[1]));
    check('one whose process started when its file says is open elsewhere',
      rows[2] === 'Truly open | aurora-notes · open elsewhere', JSON.stringify(rows[2]));
    check('one whose pid now belongs to another process is not',
      rows[3] === 'Pid reused | aurora-notes · 1m ago', JSON.stringify(rows[3]));

    const before = await c.eval(`agentTabs()[0].centerLeaves.size`);

    // two clicks in quick succession, as a real double-click would land
    await c.eval(`(() => {
      const row = agentTabs()[0].els.sessionsList.querySelector('.agent-row.dormant');
      row.click(); row.click();
      return true;
    })()`);
    await sleep(3500);
    const after = await c.eval(`agentTabs()[0].centerLeaves.size`);
    check('two clicks open one session', after - before === 1, `${after - before} pane(s) added`);

    const resumed = await c.eval(`[...agentTabs()[0].centerLeaves].map((l) => l.resumedSession).filter(Boolean)`);
    check('it resumes that session by id', resumed.length === 1 && resumed[0] === SID, JSON.stringify(resumed));

    const busy = await c.eval(`Boolean(agentTabs()[0].els.sessionsList.querySelector('.agent-row.busy'))`);

    check('the row shows it is resuming', busy);

    // clicking again while it is in flight must still not add another
    await c.eval(`(() => {
      const row = agentTabs()[0].els.sessionsList.querySelector('.agent-row.dormant');
      if (row) row.click();
      return true;
    })()`);
    await sleep(2000);
    const after2 = await c.eval(`agentTabs()[0].centerLeaves.size`);
    check('a later click is still ignored', after2 === after, `${after2} total`);

    const listed = await c.eval(`claudeSessions.map((s) => s.cwd.split(/[\\\\/]/).pop())`);
    check('the old folder is past the end of the Sessions list', listed.length === 40 && !listed.includes('old-project'), `${listed.length} rows`);

    // New session, with a claude running in a folder no transcript mentions:
    // the running one comes first, then history past the list's end
    await c.eval(`(() => {
      globalAgents.set('fake-live', { id: 'fake-live', name: 'live', cwd: ${JSON.stringify(LIVE)}, branch: 'main', status: 'working' });
      agentTabs()[0].els.layout.querySelector('.rail-new').click();
      return true;
    })()`);
    await sleep(800);
    const withLive = await c.eval(`palette.items.map((it) => it.label)`);
    check('new session offers the live folder first, then all of history',
      JSON.stringify(withLive) === '["live-project","aurora-notes","old-project","Browse…"]', JSON.stringify(withLive));
    await c.eval(`(() => { closePalette(); globalAgents.delete('fake-live'); renderAgentLists(); return true; })()`);

    // and without it, the history alone
    await c.eval(`(() => { agentTabs()[0].els.layout.querySelector('.rail-new').click(); return true; })()`);
    await sleep(800);
    const offered = await c.eval(`palette.items.map((it) => it.label)`);
    check('new session offers the recent folders and Browse',
      JSON.stringify(offered) === '["aurora-notes","old-project","Browse…"]', JSON.stringify(offered));
    await c.eval(`(() => { el.paletteInput.value = 'zzz'; el.paletteInput.dispatchEvent(new Event('input')); return true; })()`);
    const filtered = await c.eval(`palette.items.map((it) => it.label)`);
    check('typing filters folders but keeps Browse', JSON.stringify(filtered) === '["Browse…"]', JSON.stringify(filtered));
    await c.eval(`(() => { el.paletteInput.value = ''; el.paletteInput.dispatchEvent(new Event('input')); choosePalette(0); return true; })()`);
    await sleep(2500);
    const after3 = await c.eval(`agentTabs()[0].centerLeaves.size`);
    check('picking a folder opens a pane there', after3 === after2 + 1, `${after3} total`);
    const open = await c.eval(`Boolean(el.palette.classList.contains('open'))`);
    check('the picker closes', !open);

    // open elsewhere: Frost's own dialog, Cancel focused, and backing out
    // leaves nothing started and nothing stuck
    const paneCount = await c.eval(`agentTabs()[0].centerLeaves.size`);
    await c.eval(`(() => {
      const row = [...agentTabs()[0].els.sessionsList.querySelectorAll('.agent-row.dormant')]
        .find((r) => r.querySelector('.agent-name').textContent === 'Renamed elsewhere');
      row.click();
      return true;
    })()`);
    await sleep(500);
    const dlg = await c.eval(`({
      open: modal.root.classList.contains('open'),
      title: modal.title.textContent,
      focused: document.activeElement === modal.later
    })`);
    check('open elsewhere asks in a Frost dialog', dlg.open && dlg.title.includes('Renamed elsewhere'), JSON.stringify(dlg));
    check('Cancel has the focus', dlg.focused);
    await c.eval(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true; })()`);
    await sleep(500);
    const afterEsc = await c.eval(`({
      open: modal.root.classList.contains('open'),
      panes: agentTabs()[0].centerLeaves.size,
      stuck: resuming.has('${'00000000-0000-4000-8000-000000000002'}')
    })`);
    check('Esc backs out: no pane, no stuck row', !afterEsc.open && afterEsc.panes === paneCount && !afterEsc.stuck, JSON.stringify(afterEsc));

    // ---- groups: by repo, one order for both sections, folded per section ----
    const sessGroups = await c.eval(`(() => {
      const list = agentTabs()[0].els.sessionsList;
      return {
        groups: [...list.querySelectorAll(':scope > .rail-group')].map((g) => g.querySelector('.group-name').textContent),
        loose: list.querySelectorAll(':scope > .agent-row').length
      };
    })()`);
    check("sessions sit under their folder's heading", sessGroups.groups.includes('aurora-notes') && sessGroups.loose === 0, JSON.stringify(sessGroups));

    // a live agent in a folder never seen before: its group joins at the bottom
    await c.eval(`(() => {
      const leaf = [...agentTabs()[0].centerLeaves][0];
      globalAgents.set('fake-a', { id: 'fake-a', name: 'demo', cwd: ${JSON.stringify(DEMO)}, branch: 'main', status: 'idle', leaf });
      globalAgents.set('fake-b', { id: 'fake-b', name: 'live', cwd: ${JSON.stringify(LIVE)}, branch: 'main', status: 'idle', leaf });
      renderAgentLists();
      return true;
    })()`);
    await sleep(1500);
    const agentGroups = await c.eval(`[...agentTabs()[0].els.agentsList.querySelectorAll(':scope > .rail-group .group-name')].map((n) => n.textContent)`);
    check("a new folder's group goes to the bottom", JSON.stringify(agentGroups) === '["aurora-notes","live-project"]', JSON.stringify(agentGroups));

    // dragging live-project's heading above aurora-notes moves it in both sections
    await c.eval(`(() => {
      const list = agentTabs()[0].els.agentsList;
      const [first, last] = [...list.querySelectorAll(':scope > .rail-group')];
      const head = last.querySelector('.group-head');
      const top = first.getBoundingClientRect().top;
      const y0 = head.getBoundingClientRect().top + 4;
      head.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientY: y0 }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientY: y0 - 10 }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientY: top - 2 }));
      window.dispatchEvent(new MouseEvent('mouseup', { clientY: top - 2 }));
      return true;
    })()`);
    await sleep(1200);
    const dragged = await c.eval(`[...agentTabs()[0].els.agentsList.querySelectorAll(':scope > .rail-group .group-name')].map((n) => n.textContent)`);
    check('dragging a heading reorders the groups', JSON.stringify(dragged) === '["live-project","aurora-notes"]', JSON.stringify(dragged));

    // folding a group under Sessions leaves it open under Agents
    await c.eval(`(() => {
      const g = [...agentTabs()[0].els.sessionsList.querySelectorAll(':scope > .rail-group')]
        .find((x) => x.querySelector('.group-name').textContent === 'aurora-notes');
      g.querySelector('.group-head').click();
      return true;
    })()`);
    await sleep(800);
    const folds = await c.eval(`(() => {
      const find = (list) => [...list.querySelectorAll(':scope > .rail-group')].find((x) => x.querySelector('.group-name').textContent === 'aurora-notes');
      return { sessions: find(agentTabs()[0].els.sessionsList).classList.contains('collapsed'), agents: find(agentTabs()[0].els.agentsList).classList.contains('collapsed') };
    })()`);
    check('folding is per section', folds.sessions && !folds.agents, JSON.stringify(folds));
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(path.join(configDir, 'agents.json'), 'utf8')).groups || {}; } catch {}
    const names = (saved.order || []).map((k) => k.split(/[\\\\/]/).pop());
    check('order and folds are saved', names[0] === 'live-project' && names.includes('aurora-notes') && (saved.collapsed?.sessions || []).length === 1, JSON.stringify(saved));

    // the heading's + starts a session in that group's folder
    const beforePlus = await c.eval(`agentTabs()[0].centerLeaves.size`);
    await c.eval(`(() => { agentTabs()[0].els.agentsList.querySelector('.rail-group .group-new').click(); return true; })()`);
    await sleep(2500);
    const plus = await c.eval(`(() => { const ls = [...agentTabs()[0].centerLeaves]; return { n: ls.length, cwd: ls[ls.length - 1].cwd }; })()`);
    check('+ opens a session in that folder', plus.n === beforePlus + 1 && /live-project$/i.test(String(plus.cwd).replace(/[\\\\/]+$/, '')), JSON.stringify(plus));
    await c.eval(`(() => { globalAgents.delete('fake-a'); globalAgents.delete('fake-b'); renderAgentLists(); return true; })()`);

    // by time: one list, newest first, no headings; and it is remembered
    await c.eval(`(() => { agentTabs()[0].els.layout.querySelector('.rail-sort').click(); return true; })()`);
    await sleep(800);
    const flat = await c.eval(`(() => {
      const list = agentTabs()[0].els.sessionsList;
      return {
        groups: list.querySelectorAll('.rail-group').length,
        rows: list.querySelectorAll(':scope > .agent-row').length,
        first: list.querySelector(':scope > .agent-row .agent-name')?.textContent,
        label: agentTabs()[0].els.layout.querySelector('.rail-sort').dataset.mode
      };
    })()`);
    let sort = '';
    try { sort = JSON.parse(fs.readFileSync(path.join(configDir, 'agents.json'), 'utf8')).groups?.sessionsSort; } catch {}
    check('by time lists sessions flat, newest first, and is saved',
      flat.groups === 0 && flat.rows > 0 && flat.label === 'time' && sort === 'time', JSON.stringify({ ...flat, sort }));
    await c.eval(`(() => { agentTabs()[0].els.layout.querySelector('.rail-sort').click(); return true; })()`);
    await sleep(500);
    const back = await c.eval(`agentTabs()[0].els.sessionsList.querySelectorAll(':scope > .rail-group').length`);
    check('clicking again groups them by repo', back > 0, `${back} group(s)`);

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('ERROR:', e.message); fail++;
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    for (const s of sitters) s.kill();
    app.exit(fail ? 1 : 0);
  }
})();
