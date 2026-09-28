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
        hunks: [],
        raw: [] // the file's own slice of the patch, which says whether it changed
      };
      files.push(file);
      hunk = null;
    }
    if (!file) continue;
    // the patch's closing newline, which would otherwise make the last file
    // look changed whenever another is listed after it
    if (line) file.raw.push(line);
    if (line.startsWith('diff --git')) continue;
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
  const cwd = file.cwd || tab.diffCwd;
  if (entry.newNo && cwd && file.status !== 'deleted') {
    newNo.classList.add('linkable');
    newNo.title = `Open ${file.path}:${entry.newNo}`;
    newNo.addEventListener('click', (ev) => {
      ev.stopPropagation();
      api.openPath({ cwd, target: file.path, line: entry.newNo });
    });
  }
  return row;
}

function renderDiffFile(tab, file) {
  const el = document.createElement('div');
  el.className = 'diff-file';
  // the same path can be changed in two repos; which one is part of the key
  const id = file.id || file.path;
  el.dataset.path = id; // what the fold button folds it under
  if (tab.diffCollapsed.has(id)) el.classList.add('collapsed');

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
    if (el.classList.contains('collapsed')) tab.diffCollapsed.add(id);
    else tab.diffCollapsed.delete(id);
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

function untrackedOf(statusText) {
  return (statusText || '')
    .split('\n')
    .filter((l) => l.startsWith('??'))
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

// `cwd` is the repo the patch is from: the agent's own unless another repo it
// edited is picked above the diff. Keys for another repo's files carry its
// path (`prefix`), so nothing is shared with the agent's own files by accident.
function renderDiff(tab, patch, statusText, cwd = tab.diffCwd, prefix = '') {
  const files = parsePatch(patch);
  const untracked = untrackedOf(statusText);
  for (const f of files) {
    f.cwd = cwd;
    f.id = prefix + f.path;
  }

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

  if (!count) {
    tab.diffFileEls = new Map();
    tab.els.diffBody.replaceChildren(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'No changes yet' }));
    return;
  }

  // An agent editing one file changes one file's part of the patch. The others
  // keep the elements already on screen, with whatever was done to them — a
  // "show more" opened — instead of being rebuilt line by line on each save.
  const prev = tab.diffFileEls || new Map();
  const next = new Map();
  const reuse = (key, build) => {
    const el = prev.get(key) || build();
    next.set(key, el);
    return el;
  };
  const out = files.map((f) => reuse(prefix + f.raw.join('\n'), () => renderDiffFile(tab, f)));
  if (untracked.length) {
    const id = prefix + '\0untracked';
    out.push(reuse(id + '\n' + untracked.join('\n'), () => renderUntracked(tab, untracked, cwd, id)));
  }
  tab.diffFileEls = next;

  // Written to every 400ms while an agent works: replacing the contents would
  // otherwise throw the reader back to the top of the panel mid-sentence. Only
  // what moved is touched, so unchanged files aren't taken out and put back.
  const body = tab.els.diffBody;
  const keep = body.scrollTop;
  out.forEach((el, i) => {
    if (body.children[i] !== el) body.insertBefore(el, body.children[i] || null);
  });
  while (body.children.length > out.length) body.lastElementChild.remove();
  body.scrollTop = keep;
}

function renderUntracked(tab, untracked, cwd = tab.diffCwd, id = '\0untracked') {
  const el = document.createElement('div');
  el.className = 'diff-file';
  el.dataset.path = id;
  if (tab.diffCollapsed.has(id)) el.classList.add('collapsed');
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
    if (el.classList.contains('collapsed')) tab.diffCollapsed.add(id);
    else tab.diffCollapsed.delete(id);
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
    if (cwd) {
      row.title = `Open ${f}`;
      row.addEventListener('click', () => api.openPath({ cwd, target: f }));
    }
    body.appendChild(row);
  }
  el.append(head, body);
  return el;
}

api.onAgentStatus(({ agentId, status }) => {
  const agent = globalAgents.get(agentId);
  if (!agent) return;
  // finishing while you watch is seen already; any other state clears it
  if (status === 'done') {
    if (agent.status !== 'done') agent.unseen = !agentOnScreen(agent);
  } else {
    agent.unseen = false;
  }
  agent.status = status;
  renderAgentLists();
});

// How many files a repo's diff lists, for its chip: changed plus untracked.
function diffCount(patch, status) {
  const changed = (String(patch || '').match(/^diff --git /gm) || []).length;
  return changed + untrackedOf(status).length;
}

// Another repo the agent has edited gets a chip beside its own, and the panel
// shows one repo at a time: the agent's own unless another is picked. Session
// and Uncommitted then mean that repo's session or working tree.
function renderDiffRepos(tab) {
  const m = tab.diffMsg;
  const row = tab.els.diffRepos;
  const extra = m?.extra || [];
  if (!extra.length) {
    tab.diffRepo = null;
    row.hidden = true;
    row.replaceChildren();
    return;
  }
  if (tab.diffRepo && !extra.some((x) => x.cwd === tab.diffRepo)) tab.diffRepo = null;
  const own = tab.diffCwd || '';
  const chips = [
    { cwd: null, name: own.split(/[\\/]/).pop() || 'this folder', title: own, n: m.nogit ? null : diffCount(m.patch, m.status) },
    ...extra.map((x) => ({ cwd: x.cwd, name: x.name, title: `${x.cwd} · ${x.branch}`, n: diffCount(x.patch, x.status) }))
  ];
  row.hidden = false;
  row.replaceChildren(
    ...chips.map((c) => {
      const b = document.createElement('button');
      b.className = 'diff-repo' + (c.cwd === tab.diffRepo ? ' active' : '');
      b.title = c.title;
      const name = document.createElement('span');
      name.className = 'dr-name';
      name.textContent = c.name;
      b.appendChild(name);
      if (c.n !== null) {
        const n = document.createElement('span');
        n.className = 'dr-count';
        n.textContent = c.n;
        b.appendChild(n);
      }
      b.addEventListener('click', () => {
        if (tab.diffRepo === c.cwd) return;
        tab.diffRepo = c.cwd;
        renderDiffRepos(tab);
        renderDiffView(tab);
      });
      return b;
    })
  );
}

// The picked repo's part of the last diff main sent.
function renderDiffView(tab) {
  const m = tab.diffMsg;
  if (!m) return;
  const x = tab.diffRepo && (m.extra || []).find((r) => r.cwd === tab.diffRepo);
  if (x) {
    renderDiff(tab, x.patch, x.status, x.cwd, x.cwd + '\n');
  } else if (m.nogit) {
    tab.diffFileEls = null;
    tab.els.diffSummary.textContent = '';
    tab.els.diffBody.innerHTML = '<p class="hint">Not a git repository — no diff available</p>';
  } else {
    renderDiff(tab, m.patch, m.status);
  }
}

api.onAgentDiff((msg) => {
  const { key, patch, status, nogit, extra = [] } = msg;
  for (const tab of agentTabs()) {
    if (tab.diffKey !== key) continue;
    // most file events leave the diff as it was: a save of identical content,
    // an ignored file git doesn't report
    const more = extra.length ? '\0' + JSON.stringify(extra) : '';
    const shown = (nogit ? key + '\0nogit' : key + '\0' + patch + '\0' + status) + more;
    if (tab.diffShown === shown) continue;
    // another agent's files are never this one's, even at the same path
    if (!tab.diffShown?.startsWith(key + '\0')) tab.diffFileEls = null;
    tab.diffShown = shown;
    tab.diffMsg = { patch, status, nogit, extra };
    renderDiffRepos(tab);
    renderDiffView(tab);
  }
});

api.onAgentDetected((msg) => {
  const existing = agentsByPty.get(msg.ptyId);
  if (existing) {
    // claude re-launched in the same pane: refresh identity
    globalAgents.delete(existing.id);
    agentsByPty.delete(msg.ptyId);
  }
  registerAgent(msg);
  refreshSessions();
});

// /rename, or Claude Code titling the session: the agent is renamed wherever it
// is named — its row, and the diff panel if that is showing it.
api.onAgentTitle(({ agentId, title }) => {
  const agent = globalAgents.get(agentId);
  if (!agent || agent.name === title) return;
  agent.name = title;
  for (const tab of agentTabs()) {
    if (tab.diffKey === 'agent:' + agentId) tab.els.diffTitle.textContent = `${agent.name} · ${agent.branch}`;
  }
  renderAgentLists();
});

// The SessionStart hook names the Claude Code session a pane is running, which
// is what ties a live agent to its row in the sessions list.
api.onAgentSession(({ agentId, sessionId }) => {
  const agent = globalAgents.get(agentId);
  if (!agent) return;
  agent.sessionId = sessionId;
  resuming.delete(sessionId);
  refreshSessions();
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

api.onAgentEnded(({ agentId }) => {
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
  refreshSessions();
});
