// The diff panel beside an agent: what has changed in its repo, rendered from
// the patch main sends.

// ---------- diff viewer ----------

// A unified patch carries more than the +/- prefix each line starts with: which
// side of the change a line belongs to, what it is numbered in the file you
// would open, whether the file was added, deleted or renamed. Reading it as
// plain text throws all of that away, so it is parsed once into a shape the view
// can be built from.
function parsePatch(patch) {
  const files = [];
  let file = null;
  let hunk = null;
  for (const line of String(patch || '').split('\n')) {
    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      file = {
        path: m ? m[2] : line.slice(11).trim(),
        oldPath: m ? m[1] : '',
        status: 'modified',
        binary: false,
        adds: 0,
        dels: 0,
        hunks: []
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (line.startsWith('new file')) {
      file.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file')) {
      file.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      file.oldPath = line.slice(12);
      file.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      file.path = line.slice(10);
      file.status = 'renamed';
      continue;
    }
    if (line.startsWith('Binary files')) {
      file.binary = true;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      hunk = { context: m ? m[3].trim() : '', oldNo: m ? +m[1] : 0, newNo: m ? +m[2] : 0, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    // headers we have either already read or have no use for
    if (
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('old mode') ||
      line.startsWith('new mode') ||
      line.startsWith('similarity index') ||
      line.startsWith('\\') // "\ No newline at end of file"
    ) {
      continue;
    }
    if (!hunk) continue;
    const kind = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx';
    const entry = { kind, text: line.slice(1) };
    if (kind === 'add') {
      entry.newNo = hunk.newNo++;
      file.adds++;
    } else if (kind === 'del') {
      entry.oldNo = hunk.oldNo++;
      file.dels++;
    } else {
      entry.oldNo = hunk.oldNo++;
      entry.newNo = hunk.newNo++;
    }
    hunk.lines.push(entry);
  }
  return files;
}

// Where a removed line and the line replacing it differ. Only the run between
// the common prefix and the common suffix can have changed, which is cheap to
// find and is the part worth pointing at — a renamed variable in a long line is
// otherwise a whole red line beside a whole green one, and the eye has to hunt.
function inlineSpan(a, b) {
  if (!a || !b) return null;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a[start] === b[start]) start++;
  let tail = 0;
  while (tail < max - start && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  // nothing shared at either end: the line was rewritten, and marking all of it
  // says no more than the +/- already does
  if (start === 0 && tail === 0) return null;
  return { start, endA: a.length - tail, endB: b.length - tail };
}

function lineText(parent, text, span, side) {
  const code = document.createElement('span');
  code.className = 'dl-text';
  if (!span) {
    code.textContent = text || ' ';
  } else {
    const end = side === 'del' ? span.endA : span.endB;
    const mid = text.slice(span.start, end);
    code.append(text.slice(0, span.start));
    if (mid) {
      const mark = document.createElement('span');
      mark.className = 'dl-word';
      mark.textContent = mid;
      code.appendChild(mark);
    }
    code.append(text.slice(end));
  }
  parent.appendChild(code);
}

// Pair each removed line with the line that replaced it, so the two can be
// compared. Only balanced runs are paired: three lines deleted and one added is
// a rewrite, not three edits, and guessing which is which would mislead.
function pairRuns(lines) {
  const pairs = new Map();
  for (let i = 0; i < lines.length; ) {
    if (lines[i].kind !== 'del') {
      i++;
      continue;
    }
    let d = i;
    while (d < lines.length && lines[d].kind === 'del') d++;
    let a = d;
    while (a < lines.length && lines[a].kind === 'add') a++;
    const dels = d - i;
    const adds = a - d;
    if (dels && dels === adds) {
      for (let k = 0; k < dels; k++) pairs.set(i + k, d + k);
    }
    i = a > d ? a : d;
  }
  return pairs;
}

const DIFF_LINE_CAP = 600; // per file, before a "show the rest" button

function diffLineRow(tab, file, entry, span) {
  const row = document.createElement('div');
  row.className = 'diff-line ' + entry.kind;
  const oldNo = document.createElement('span');
  oldNo.className = 'dl-no';
  oldNo.textContent = entry.oldNo || '';
  const newNo = document.createElement('span');
  newNo.className = 'dl-no';
  newNo.textContent = entry.newNo || '';
  const sign = document.createElement('span');
  sign.className = 'dl-sign';
  sign.textContent = entry.kind === 'add' ? '+' : entry.kind === 'del' ? '−' : ' ';
  row.append(oldNo, newNo, sign);
  lineText(row, entry.text, span, entry.kind);
  // the number is the one place in the row where "take me there" is unambiguous
  if (entry.newNo && tab.diffCwd && file.status !== 'deleted') {
    newNo.classList.add('linkable');
    newNo.title = `Open ${file.path}:${entry.newNo}`;
    newNo.addEventListener('click', (ev) => {
      ev.stopPropagation();
      api.openPath({ cwd: tab.diffCwd, target: file.path, line: entry.newNo });
    });
  }
  return row;
}

function renderDiffFile(tab, file) {
  const el = document.createElement('div');
  el.className = 'diff-file';
  el.dataset.path = file.path;
  if (tab.diffCollapsed.has(file.path)) el.classList.add('collapsed');

  const head = document.createElement('div');
  head.className = 'diff-file-head';
  const chev = document.createElement('span');
  chev.className = 'df-chev';
  chev.textContent = '▾';
  const badge = document.createElement('span');
  badge.className = 'df-badge ' + file.status;
  badge.textContent = file.status[0].toUpperCase();
  badge.title = file.status;
  // basename first and whole, directory after it as context — a column of
  // truncated paths that all begin "src/renderer/…" identifies nothing
  const slash = file.path.lastIndexOf('/');
  const name = document.createElement('span');
  name.className = 'df-name';
  name.textContent = file.path.slice(slash + 1);
  const dir = document.createElement('span');
  dir.className = 'df-dir';
  dir.textContent = slash > -1 ? file.path.slice(0, slash) : '';
  const title = file.status === 'renamed' ? `${file.oldPath} → ${file.path}` : file.path;
  name.title = title;
  dir.title = title;
  const stat = document.createElement('span');
  stat.className = 'df-stat';
  if (file.adds) {
    const s = document.createElement('span');
    s.className = 'add';
    s.textContent = '+' + file.adds;
    stat.appendChild(s);
  }
  if (file.dels) {
    const s = document.createElement('span');
    s.className = 'del';
    s.textContent = '−' + file.dels;
    stat.appendChild(s);
  }
  head.append(chev, badge, name, dir, stat);
  head.addEventListener('click', () => {
    el.classList.toggle('collapsed');
    if (el.classList.contains('collapsed')) tab.diffCollapsed.add(file.path);
    else tab.diffCollapsed.delete(file.path);
  });

  const body = document.createElement('div');
  body.className = 'diff-file-body';
  if (file.binary) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Binary file';
    body.appendChild(p);
  }

  let drawn = 0;
  const overflow = [];
  for (const hunk of file.hunks) {
    const hd = document.createElement('div');
    hd.className = 'diff-line hunk';
    hd.textContent = hunk.context || `line ${hunk.newNo}`;
    (drawn < DIFF_LINE_CAP ? body : overflow).appendChild(hd);
    const pairs = pairRuns(hunk.lines);
    const partner = new Map();
    for (const [d, a] of pairs) {
      partner.set(d, a);
      partner.set(a, d);
    }
    hunk.lines.forEach((entry, i) => {
      let span = null;
      const other = partner.get(i);
      if (other !== undefined) {
        const a = entry.kind === 'del' ? entry.text : hunk.lines[other].text;
        const b = entry.kind === 'del' ? hunk.lines[other].text : entry.text;
        span = inlineSpan(a, b);
      }
      const row = diffLineRow(tab, file, entry, span);
      if (drawn < DIFF_LINE_CAP) body.appendChild(row);
      else overflow.push(row);
      drawn++;
    });
  }
  if (overflow.length) {
    const more = document.createElement('button');
    more.className = 'diff-more';
    more.textContent = `Show ${overflow.length} more lines`;
    more.addEventListener('click', () => {
      more.replaceWith(...overflow);
    });
    body.appendChild(more);
  }

  el.append(head, body);
  return el;
}

function renderDiff(tab, patch, statusText) {
  const files = parsePatch(patch);
  const untracked = (statusText || '')
    .split('\n')
    .filter((l) => l.startsWith('??'))
    .map((l) => l.slice(3).trim())
    .filter(Boolean);

  const adds = files.reduce((n, f) => n + f.adds, 0);
  const dels = files.reduce((n, f) => n + f.dels, 0);
  const count = files.length + untracked.length;
  if (!count) {
    tab.els.diffSummary.textContent = '';
  } else {
    // same green and red as the per-file counts, so the totals read as the same
    // quantity summed rather than as a separate label
    const plus = document.createElement('span');
    plus.className = 'add';
    plus.textContent = `+${adds}`;
    const minus = document.createElement('span');
    minus.className = 'del';
    minus.textContent = `−${dels}`;
    tab.els.diffSummary.replaceChildren(`${count} file${count > 1 ? 's' : ''} · `, plus, ' ', minus);
  }

  if (!files.length && !untracked.length) {
    tab.els.diffBody.replaceChildren(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'No changes yet' }));
    return;
  }

  const out = files.map((f) => renderDiffFile(tab, f));

  if (untracked.length) {
    const el = document.createElement('div');
    el.className = 'diff-file';
    el.dataset.path = ' untracked';
    if (tab.diffCollapsed.has(' untracked')) el.classList.add('collapsed');
    const head = document.createElement('div');
    head.className = 'diff-file-head';
    const chev = document.createElement('span');
    chev.className = 'df-chev';
    chev.textContent = '▾';
    const badge = document.createElement('span');
    badge.className = 'df-badge untracked';
    badge.textContent = '?';
    badge.title = 'untracked';
    const name = document.createElement('span');
    name.className = 'df-name';
    name.textContent = `untracked (${untracked.length})`;
    head.append(chev, badge, name);
    head.addEventListener('click', () => {
      el.classList.toggle('collapsed');
      if (el.classList.contains('collapsed')) tab.diffCollapsed.add(' untracked');
      else tab.diffCollapsed.delete(' untracked');
    });
    const body = document.createElement('div');
    body.className = 'diff-file-body';
    for (const f of untracked) {
      const row = document.createElement('div');
      row.className = 'diff-line add untracked-row';
      const text = document.createElement('span');
      text.className = 'dl-text';
      text.textContent = f;
      row.appendChild(text);
      if (tab.diffCwd) {
        row.title = `Open ${f}`;
        row.addEventListener('click', () => api.openPath({ cwd: tab.diffCwd, target: f }));
      }
      body.appendChild(row);
    }
    el.append(head, body);
    out.push(el);
  }

  // Written to every 400ms while an agent works: replacing the contents would
  // otherwise throw the reader back to the top of the panel mid-sentence.
  const keep = tab.els.diffBody.scrollTop;
  tab.els.diffBody.replaceChildren(...out);
  tab.els.diffBody.scrollTop = keep;
}

api.onAgentStatus(({ agentId, status }) => {
  const agent = globalAgents.get(agentId);
  if (!agent) return;
  agent.status = status;
  renderAgentLists();
});

api.onAgentDiff(({ key, patch, status, nogit }) => {
  for (const tab of agentTabs()) {
    if (tab.diffKey !== key) continue;
    if (nogit) {
      tab.els.diffBody.innerHTML = '<p class="hint">Not a git repository — no diff available</p>';
    } else {
      renderDiff(tab, patch, status);
    }
  }
});

api.onAgentDetected((msg) => {
  sessions = msg.sessions || sessions;
  const existing = agentsByPty.get(msg.ptyId);
  if (existing) {
    // claude re-launched in the same pane: refresh identity
    globalAgents.delete(existing.id);
    agentsByPty.delete(msg.ptyId);
  }
  registerAgent(msg);
});

// Clicking a notification should land you on the agent it was about.
api.onAgentReveal((agentId) => {
  const agent = globalAgents.get(agentId);
  if (!agent) return;
  const host = agentTabs().find((t) => t.centerLeaves.has(agent.leaf));
  if (host) {
    activateTab(host);
    selectAgent(host, agentId);
    return;
  }
  const tab = tabOfPane(agent.leaf);
  if (tab) {
    activateTab(tab);
    focusPane(agent.leaf);
  }
});

api.onAgentEnded(({ agentId, sessions: s }) => {
  if (s) sessions = s;
  const agent = globalAgents.get(agentId);
  if (agent) {
    globalAgents.delete(agentId);
    agentsByPty.delete(agent.ptyId);
    for (const tab of agentTabs()) {
      if (tab.selected === agentId) tab.selected = null;
      if (tab.diffKey === 'agent:' + agentId) tab.diffKey = null;
    }
  }
  renderAgentLists();
  refreshWorktrees();
});
