/* global Terminal, FitAddon, WebLinksAddon, WebglAddon, Unicode11Addon, SearchAddon */

const state = {
  theme: null,
  tabs: [],
  activeTab: null
};

let tabCounter = 0;
let paneCounter = 0;
const panesByPty = new Map(); // ptyId -> leaf node

const glassState = { active: false, display: null, bounds: null };

const el = {
  glassBg: document.getElementById('glass-bg'),
  tabstrip: document.getElementById('tabstrip'),
  content: document.getElementById('content'),
  settings: document.getElementById('settings'),
  toast: document.getElementById('toast'),
  customCss: document.getElementById('custom-css')
};

// ---------- helpers ----------

function toast(msg, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.remove('show'), ms);
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------- theme ----------

// paste via term.paste(): respects bracketed paste mode, so multi-line
// pastes don't execute line-by-line in the shell
function pasteInto(term) {
  navigator.clipboard.readText().then((t) => {
    if (t) term.paste(t);
  });
}

// GPU (WebGL) renderer: enables customGlyphs box-drawing and faster rendering.
// Falls back to the DOM renderer if WebGL is unavailable.
function applyGpu(node) {
  const want = !state.theme || state.theme.gpuRenderer !== false;
  if (want && !node.webgl) {
    try {
      node.webgl = new WebglAddon.WebglAddon();
      node.webgl.onContextLoss(() => {
        node.webgl?.dispose();
        node.webgl = null;
      });
      node.term.loadAddon(node.webgl);
    } catch {
      node.webgl = null;
    }
  } else if (!want && node.webgl) {
    node.webgl.dispose();
    node.webgl = null;
  }
}

function xtermTheme(theme) {
  const t = theme.terminal || {};
  return {
    ...t,
    background: 'rgba(0,0,0,0)' // acrylic tint comes from the page, not xterm
  };
}

function applyTheme(theme, css) {
  if (!theme) return;
  state.theme = theme;
  const r = document.documentElement.style;
  r.setProperty('--tint', theme.tint || 'rgba(10,12,20,0.55)');
  r.setProperty('--accent', theme.accent || '#7aa2f7');
  r.setProperty('--fg', theme.terminal?.foreground || '#c8d3f5');
  r.setProperty('--pad', (theme.padding ?? 14) + 'px');
  r.setProperty('--radius', (theme.cornerRadius ?? 8) + 'px');
  r.setProperty('--font', theme.font?.family || 'Consolas, monospace');
  r.setProperty('--glass-blur', (theme.glassBlur ?? 40) + 'px');
  r.setProperty('--win-radius', (theme.windowRadius ?? 12) + 'px');
  document.body.classList.toggle('glass', glassState.active && theme.material === 'glass');
  if (typeof css === 'string') el.customCss.textContent = css;

  for (const node of panesByPty.values()) {
    const term = node.term;
    term.options.fontFamily = theme.font?.family || 'Consolas, monospace';
    term.options.fontSize = theme.font?.size || 14;
    term.options.lineHeight = theme.font?.lineHeight || 1.2;
    term.options.cursorStyle = theme.cursor?.style || 'bar';
    term.options.cursorBlink = theme.cursor?.blink !== false;
    term.options.minimumContrastRatio = theme.minContrast ?? 4.5;
    term.options.theme = xtermTheme(theme);
    try {
      term.unicode.activeVersion = theme.unicodeVersion || '11';
    } catch {}
    applyGpu(node);
    node.fit.fit();
  }
  syncSettingsUI();
}

// ---------- pane tree ----------
// leaf: { type:'leaf', id, ptyId, term, fit, el }
// split: { type:'split', dir:'row'|'col', children:[], sizes:[], el }

function findParent(node, target, parent = null) {
  if (node === target) return parent;
  if (node.type === 'split') {
    for (const c of node.children) {
      const found = findParent(c, target, node);
      if (found !== null || c === target) return found ?? node;
    }
  }
  return null;
}

function firstLeaf(node) {
  return node.type === 'leaf' ? node : firstLeaf(node.children[0]);
}

function allLeaves(node, out = []) {
  if (node.type === 'leaf') out.push(node);
  else node.children.forEach((c) => allLeaves(c, out));
  return out;
}

// ---------- buffer search ----------

const SEARCH_DECORATIONS = {
  matchBackground: '#5a4a1f',
  matchBorder: '#8a7020',
  matchOverviewRuler: '#8a7020',
  activeMatchBackground: '#c98a1f',
  activeMatchBorder: '#ffb84d',
  activeMatchColorOverviewRuler: '#ffb84d'
};

function attachPaneSearch(node) {
  const search = new SearchAddon.SearchAddon();
  node.term.loadAddon(search);
  node.search = search;

  const bar = document.createElement('div');
  bar.className = 'pane-search';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'pane-search-input';
  input.placeholder = 'Find';
  input.spellcheck = false;
  const count = document.createElement('span');
  count.className = 'pane-search-count';
  const prev = document.createElement('button');
  prev.textContent = '▲';
  prev.title = 'Previous match (Shift+Enter)';
  const next = document.createElement('button');
  next.textContent = '▼';
  next.title = 'Next match (Enter)';
  const close = document.createElement('button');
  close.textContent = '×';
  close.title = 'Close (Esc)';
  bar.append(input, count, prev, next, close);
  node.el.appendChild(bar);
  node.searchEl = bar;
  node.searchInput = input;

  search.onDidChangeResults(({ resultIndex, resultCount }) => {
    count.textContent = resultCount === 0 ? 'No results' : `${resultIndex + 1}/${resultCount}`;
  });

  function go(dir, incremental) {
    const query = input.value;
    if (!query) {
      search.clearDecorations();
      count.textContent = '';
      return;
    }
    const searchOpts = { decorations: SEARCH_DECORATIONS, incremental };
    if (dir === 'prev') search.findPrevious(query, searchOpts);
    else search.findNext(query, searchOpts);
  }

  input.addEventListener('input', () => go('next', true));
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      go(ev.shiftKey ? 'prev' : 'next', false);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      closePaneSearch(node);
    }
  });
  prev.addEventListener('click', () => go('prev', false));
  next.addEventListener('click', () => go('next', false));
  close.addEventListener('click', () => closePaneSearch(node));
}

function openPaneSearch(node) {
  if (!node?.searchEl) return;
  node.searchEl.classList.add('open');
  node.searchInput.focus();
  node.searchInput.select();
}

function closePaneSearch(node) {
  if (!node?.searchEl) return;
  node.searchEl.classList.remove('open');
  node.search.clearDecorations();
  node.term.focus();
}

async function createPane(opts = {}) {
  const id = 'pane-' + ++paneCounter;
  const paneEl = document.createElement('div');
  paneEl.className = 'pane';
  // unpadded inner host: FitAddon measures the terminal's parent, and the
  // pane's padding must not count as usable space or bottom rows get clipped
  const hostEl = document.createElement('div');
  hostEl.className = 'term-host';
  paneEl.appendChild(hostEl);

  const theme = state.theme || {};
  const term = new Terminal({
    allowProposedApi: true, // unicode width API is gated behind this in xterm 6
    allowTransparency: true,
    scrollback: 10000,
    fontFamily: theme.font?.family || 'Consolas, monospace',
    fontSize: theme.font?.size || 14,
    lineHeight: theme.font?.lineHeight || 1.2,
    cursorStyle: theme.cursor?.style || 'bar',
    cursorBlink: theme.cursor?.blink !== false,
    // Windows Terminal parity: builtin box/block glyphs, auto-contrast text
    customGlyphs: true,
    rescaleOverlappingGlyphs: true,
    minimumContrastRatio: theme.minContrast ?? 4.5,
    // tell xterm the backend is Windows ConPTY so it applies its quirk handling
    windowsPty: { backend: 'conpty' },
    theme: xtermTheme(theme)
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  // Modern character widths (emoji = 2 cols). theme.unicodeVersion picks the
  // active table ('11' or '6') and hot-reloads for live A/B testing.
  // Never let a broken addon kill terminal creation.
  try {
    term.loadAddon(new Unicode11Addon.Unicode11Addon());
    term.unicode.activeVersion = state.theme?.unicodeVersion || '11';
  } catch (e) {
    window.__unicodeError = String(e && e.stack ? e.stack : e);
    console.error('unicode11 addon failed', e);
  }
  term.open(hostEl);

  const node = { type: 'leaf', id, ptyId: null, term, fit, webgl: null, el: paneEl };
  applyGpu(node);
  attachPaneSearch(node);

  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    // shortcut executed by the window-level listener; just keep it away from the pty
    if (matchShortcut(ev)) return false;
    // clipboard — Windows Terminal behavior
    const ctrlOnly = ev.ctrlKey && !ev.shiftKey && !ev.altKey;
    if (ctrlOnly && ev.code === 'KeyC' && term.hasSelection()) {
      // copy instead of interrupt when text is selected
      navigator.clipboard.writeText(term.getSelection());
      term.clearSelection();
      return false;
    }
    if ((ctrlOnly || (ev.ctrlKey && ev.shiftKey)) && ev.code === 'KeyV') {
      // single controlled paste: preventDefault kills the browser's native
      // paste event, returning false keeps ^V away from the shell (PSReadLine
      // would paste on raw ^V too) — then paste exactly once ourselves
      ev.preventDefault();
      pasteInto(term);
      return false;
    }
    if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyC' && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection());
      return false;
    }
    return true;
  });

  // copy-on-select (debounced: selection changes continuously while dragging)
  let selTimer = null;
  term.onSelectionChange(() => {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      if (state.theme?.copyOnSelect !== false && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection());
      }
    }, 150);
  });

  paneEl.addEventListener('mousedown', () => focusPane(node));
  paneEl.addEventListener('contextmenu', async (ev) => {
    ev.preventDefault();
    if (term.hasSelection()) {
      await navigator.clipboard.writeText(term.getSelection());
      term.clearSelection();
    } else {
      pasteInto(term);
    }
  });

  const refit = debounce(() => {
    if (paneEl.isConnected) fit.fit();
  }, 30);
  new ResizeObserver(refit).observe(paneEl);

  term.onResize(({ cols, rows }) => {
    if (node.ptyId) api.ptyResize(node.ptyId, cols, rows);
  });

  const ptyId = await api.ptyCreate(term.cols, term.rows, opts);
  node.ptyId = ptyId;
  panesByPty.set(ptyId, node);
  term.onData((d) => api.ptyInput(ptyId, d));

  term.onTitleChange((title) => {
    const tab = tabOfPane(node);
    if (tab && tab.activePane === node) {
      tab.title = title || 'pwsh';
      renderTabs();
    }
  });

  return node;
}

function tabOfPane(node) {
  return state.tabs.find((t) => t.root && allLeaves(t.root).includes(node)) || null;
}

function renderNode(node) {
  if (node.type === 'leaf') return node.el;
  const wrap = document.createElement('div');
  wrap.className = 'split ' + node.dir;
  node.el = wrap;
  node.children.forEach((child, i) => {
    const childEl = renderNode(child);
    childEl.style.flex = `${node.sizes[i]} 1 0%`;
    wrap.appendChild(childEl);
    if (i < node.children.length - 1) {
      wrap.appendChild(makeDivider(node, i));
    }
  });
  return wrap;
}

function makeDivider(splitNode, index) {
  const d = document.createElement('div');
  d.className = 'divider';
  d.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    d.setPointerCapture(ev.pointerId);
    d.classList.add('dragging');
    const horizontal = splitNode.dir === 'row';
    const rect = splitNode.el.getBoundingClientRect();
    const total = horizontal ? rect.width : rect.height;
    const startPos = horizontal ? ev.clientX : ev.clientY;
    const a = splitNode.sizes[index];
    const b = splitNode.sizes[index + 1];
    const sum = splitNode.sizes.reduce((x, y) => x + y, 0);

    const move = (mv) => {
      const delta = ((horizontal ? mv.clientX : mv.clientY) - startPos) / total * sum;
      let na = Math.max(0.08, a + delta);
      let nb = Math.max(0.08, b - delta);
      const pairSum = a + b;
      if (na + nb !== pairSum) {
        if (na <= 0.08) nb = pairSum - na;
        else na = pairSum - nb;
      }
      splitNode.sizes[index] = na;
      splitNode.sizes[index + 1] = nb;
      const kids = [...splitNode.el.children].filter((c) => !c.classList.contains('divider'));
      kids[index].style.flex = `${na} 1 0%`;
      kids[index + 1].style.flex = `${nb} 1 0%`;
    };
    const up = (uv) => {
      d.classList.remove('dragging');
      d.removeEventListener('pointermove', move);
      d.removeEventListener('pointerup', up);
    };
    d.addEventListener('pointermove', move);
    d.addEventListener('pointerup', up);
  });
  return d;
}

function renderTab(tab) {
  tab.contentEl.replaceChildren(renderNode(tab.root));
  allLeaves(tab.root).forEach((leaf) => leaf.fit.fit());
}

function focusPane(node) {
  const tab = tabOfPane(node);
  if (!tab) return;
  tab.activePane = node;
  document.querySelectorAll('.pane.focused').forEach((p) => p.classList.remove('focused'));
  node.el.classList.add('focused');
  node.term.focus();
}

async function splitPane(dir) {
  const tab = state.activeTab;
  if (!tab || !tab.activePane) return;
  const target = tab.activePane;
  const newLeaf = await createPane();
  const parent = tab.root === target ? null : findParent(tab.root, target);

  if (parent && parent.dir === dir) {
    const i = parent.children.indexOf(target);
    parent.children.splice(i + 1, 0, newLeaf);
    const half = parent.sizes[i] / 2;
    parent.sizes[i] = half;
    parent.sizes.splice(i + 1, 0, half);
  } else {
    const split = { type: 'split', dir, children: [target, newLeaf], sizes: [1, 1], el: null };
    if (!parent) {
      tab.root = split;
    } else {
      parent.children[parent.children.indexOf(target)] = split;
    }
  }
  renderTab(tab);
  focusPane(newLeaf);
}

function destroyLeaf(node) {
  if (node.ptyId) {
    panesByPty.delete(node.ptyId);
    api.ptyKill(node.ptyId);
  }
  node.term.dispose();
  node.el.remove();
}

function removePane(node, { killPty = true } = {}) {
  const tab = tabOfPane(node);
  if (!tab) return;

  if (killPty) destroyLeaf(node);
  else {
    node.term.dispose();
    node.el.remove();
  }

  if (tab.root === node) {
    closeTab(tab, { killPtys: false });
    return;
  }

  const parent = findParent(tab.root, node);
  const i = parent.children.indexOf(node);
  parent.children.splice(i, 1);
  parent.sizes.splice(i, 1);

  if (parent.children.length === 1) {
    const survivor = parent.children[0];
    if (tab.root === parent) {
      tab.root = survivor;
    } else {
      const gp = findParent(tab.root, parent);
      gp.children[gp.children.indexOf(parent)] = survivor;
    }
  }
  renderTab(tab);
  focusPane(firstLeaf(tab.root));
}

// ---------- tabs ----------

async function newTab() {
  const tab = {
    id: 'tab-' + ++tabCounter,
    title: 'pwsh',
    root: null,
    activePane: null,
    contentEl: document.createElement('div')
  };
  tab.contentEl.className = 'tab-content';
  const leaf = await createPane();
  tab.root = leaf;
  state.tabs.push(tab);
  activateTab(tab);
  renderTab(tab);
  focusPane(leaf);
}

function activateTab(tab) {
  state.activeTab = tab;
  el.content.replaceChildren(tab.contentEl);
  renderTabs();
  if (tab.kind === 'agents') {
    const visible = [...tab.centerLeaves].find((l) => l.el.style.display !== 'none');
    if (visible) {
      visible.fit.fit();
      visible.term.focus();
    }
    return;
  }
  allLeaves(tab.root).forEach((leaf) => leaf.fit.fit());
  if (tab.activePane) focusPane(tab.activePane);
  else focusPane(firstLeaf(tab.root));
}

function closeTab(tab, { killPtys = true } = {}) {
  if (tab.kind === 'agents') {
    for (const leaf of tab.centerLeaves) {
      try {
        const agent = agentsByPty.get(leaf.ptyId);
        if (agent) {
          agentsByPty.delete(leaf.ptyId);
          globalAgents.delete(agent.id);
        }
        if (leaf.ptyId) {
          panesByPty.delete(leaf.ptyId);
          api.ptyKill(leaf.ptyId);
        }
        leaf.term.dispose();
        leaf.el.remove();
      } catch {}
    }
    api.agentsSelectDiff(null);
  } else if (killPtys) {
    allLeaves(tab.root).forEach(destroyLeaf);
  }
  const i = state.tabs.indexOf(tab);
  state.tabs.splice(i, 1);
  if (state.tabs.length === 0) {
    window.close();
    return;
  }
  if (state.activeTab === tab) {
    activateTab(state.tabs[Math.max(0, i - 1)]);
  } else {
    renderTabs();
  }
}

function renderTabs() {
  el.tabstrip.replaceChildren(
    ...state.tabs.map((tab) => {
      const t = document.createElement('div');
      t.className = 'tab' + (tab === state.activeTab ? ' active' : '');
      if (tab.kind === 'agents') {
        const dot = document.createElement('span');
        dot.className = 'tab-dot st-' + worstAgentStatus(tab);
        t.appendChild(dot);
      }
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = tab.title;
      const close = document.createElement('button');
      close.className = 'close';
      close.textContent = '×';
      close.title = 'Close tab';
      // stopPropagation on mousedown: otherwise the tab re-activates and the
      // tab strip re-renders, destroying this button before 'click' can fire
      close.addEventListener('mousedown', (ev) => ev.stopPropagation());
      close.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeTab(tab);
      });
      t.append(title, close);
      t.addEventListener('mousedown', () => activateTab(tab));
      return t;
    })
  );
}

// ---------- agent mode ----------

const globalAgents = new Map(); // agentId -> agent {id,name,cwd,branch,git,ptyId,leaf,status}
const agentsByPty = new Map(); // ptyId -> agent
const pendingNames = new Map(); // ptyId -> preferred display name
let sessions = []; // resumable past sessions [{name,cwd,branch,lastSeen}]
const STATUS_RANK = { blocked: 4, working: 3, done: 2, idle: 1, exited: 0 };

function agentTabs() {
  return state.tabs.filter((t) => t.kind === 'agents');
}

function worstAgentStatus() {
  let worst = 'idle';
  for (const a of globalAgents.values()) {
    if ((STATUS_RANK[a.status] ?? 0) > (STATUS_RANK[worst] ?? 0)) worst = a.status;
  }
  return worst;
}

function renderAgentLists() {
  for (const t of agentTabs()) renderAgentList(t);
  renderTabs();
}

async function newAgentTab() {
  const tab = {
    id: 'tab-' + ++tabCounter,
    kind: 'agents',
    title: 'agents',
    root: null,
    activePane: null,
    contentEl: document.createElement('div'),
    centerLeaves: new Set(),
    selected: null,
    els: {}
  };
  tab.contentEl.className = 'tab-content';
  buildAgentLayout(tab);
  state.tabs.push(tab);
  activateTab(tab);
  // default center terminal: cd anywhere and run `claude` — auto-registers
  const leaf = await createPane();
  addCenterLeaf(tab, leaf, true);
  const cfg = await api.agentsGetConfig();
  renderSpaces(tab, cfg);
  sessions = await api.agentsGetSessions();
  renderAgentList(tab);
}

function addCenterLeaf(tab, leaf, show) {
  tab.centerLeaves.add(leaf);
  leaf.el.classList.add('agent-pane');
  tab.els.empty.style.display = 'none';
  tab.els.center.appendChild(leaf.el);
  if (show) setCenterVisible(tab, leaf);
  else leaf.el.style.display = 'none';
}

function setCenterVisible(tab, leaf) {
  for (const l of tab.centerLeaves) l.el.style.display = l === leaf ? '' : 'none';
  requestAnimationFrame(() => {
    leaf.fit.fit();
    leaf.term.focus();
  });
}

function buildAgentLayout(tab) {
  const layout = document.createElement('div');
  layout.className = 'agents-layout';
  layout.innerHTML = `
    <div class="agents-rail">
      <div class="rail-section">
        <div class="rail-head"><h4>Spaces</h4><button class="rail-add" title="Add a git repo">+</button></div>
        <div class="spaces-list"></div>
      </div>
      <div class="rail-section">
        <div class="rail-head"><h4>Agents</h4></div>
        <div class="agents-list"></div>
      </div>
    </div>
    <div class="agents-center">
      <div class="agents-empty">cd into a repo and run <b>claude</b> — it becomes an agent automatically.</div>
    </div>
    <div class="agents-diff">
      <div class="diff-head">
        <span class="diff-title">Diff watch</span>
        <div class="diff-toggle">
          <button data-mode="session" class="active" title="Everything since the agent started, commits included">Session</button>
          <button data-mode="uncommitted" title="Working tree vs HEAD only">Uncommitted</button>
        </div>
      </div>
      <div class="diff-body"><p class="hint">No agent selected</p></div>
    </div>`;
  tab.contentEl.appendChild(layout);
  tab.diffMode = 'session';
  tab.els = {
    spacesList: layout.querySelector('.spaces-list'),
    agentsList: layout.querySelector('.agents-list'),
    center: layout.querySelector('.agents-center'),
    empty: layout.querySelector('.agents-empty'),
    diffTitle: layout.querySelector('.diff-title'),
    diffBody: layout.querySelector('.diff-body')
  };
  layout.querySelectorAll('.diff-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      tab.diffMode = btn.dataset.mode;
      layout.querySelectorAll('.diff-toggle button').forEach((b) => b.classList.toggle('active', b === btn));
      if (tab.selected) api.agentsSelectDiff({ agentId: tab.selected, mode: tab.diffMode });
    });
  });
  layout.querySelector('.rail-add').addEventListener('click', async () => {
    const cfg = await api.agentsAddSpace();
    if (!cfg) return;
    if (cfg.error) {
      toast(cfg.error);
      return;
    }
    renderSpaces(tab, cfg);
  });
}

function renderSpaces(tab, cfg) {
  tab.els.spacesList.replaceChildren(
    ...(cfg.spaces || []).map((space) => {
      const row = document.createElement('div');
      row.className = 'space-row';
      const name = document.createElement('span');
      name.className = 'space-name';
      name.textContent = space.name;
      name.title = space.path;
      const btn = document.createElement('button');
      btn.textContent = '+ agent';
      btn.title = 'Spawn a Claude Code agent here';
      btn.addEventListener('click', () => showSpawnForm(tab, space, row));
      const del = document.createElement('button');
      del.className = 'space-remove';
      del.textContent = '×';
      del.title = 'Remove this space (repo itself is untouched)';
      del.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const cfg = await api.agentsRemoveSpace(space.path);
        renderSpaces(tab, cfg);
      });
      row.append(name, btn, del);
      return row;
    })
  );
  if (!(cfg.spaces || []).length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No spaces yet — add a git repo with +';
    tab.els.spacesList.appendChild(p);
  }
}

function showSpawnForm(tab, space, row) {
  if (row.nextElementSibling?.classList.contains('spawn-form')) {
    row.nextElementSibling.remove();
    return;
  }
  tab.els.spacesList.querySelectorAll('.spawn-form').forEach((f) => f.remove());
  const form = document.createElement('div');
  form.className = 'spawn-form';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'agent name';
  input.spellcheck = false;
  const wtLabel = document.createElement('label');
  wtLabel.className = 'spawn-wt';
  const wtCheck = document.createElement('input');
  wtCheck.type = 'checkbox';
  wtLabel.append(wtCheck, document.createTextNode(' isolate in worktree (own branch)'));
  form.append(input, wtLabel);
  row.after(form);
  input.focus();
  input.addEventListener('keydown', async (ev) => {
    if (ev.key === 'Escape') form.remove();
    if (ev.key === 'Enter' && input.value.trim()) {
      const task = input.value.trim();
      const useWorktree = wtCheck.checked;
      form.remove();
      await spawnAgent(tab, space, task, useWorktree);
    }
  });
}

async function spawnAgent(tab, space, task, useWorktree = false) {
  const res = await api.agentsSpawn({ spacePath: space.path, task, useWorktree });
  if (!res || res.error) {
    toast(res?.error || 'Agent spawn failed');
    return;
  }
  const leaf = await createPane({ cwd: res.cwd, run: res.run });
  addCenterLeaf(tab, leaf, true);
  pendingNames.set(leaf.ptyId, task);
  if (res.agentId) {
    // auto-detect off: agent pre-registered by the main process
    api.agentsTrack({ agentId: res.agentId, ptyId: leaf.ptyId });
    registerAgent({
      agentId: res.agentId,
      ptyId: leaf.ptyId,
      cwd: res.cwd,
      name: task,
      branch: res.branch,
      git: true
    });
  }
}

function registerAgent({ agentId, ptyId, cwd, name, branch, git }) {
  const leaf = panesByPty.get(ptyId);
  if (!leaf) return null;
  const agent = {
    id: agentId,
    name: pendingNames.get(ptyId) || name,
    cwd,
    branch,
    git,
    ptyId,
    leaf,
    status: 'working'
  };
  pendingNames.delete(ptyId);
  globalAgents.set(agentId, agent);
  agentsByPty.set(ptyId, agent);
  // if an agent tab hosts this pane in its center, select it there
  const host = agentTabs().find((t) => t.centerLeaves.has(leaf));
  if (host) selectAgent(host, agentId, { focus: false });
  renderAgentLists();
  return agent;
}

function selectAgent(tab, agentId, { focus = true } = {}) {
  const agent = globalAgents.get(agentId);
  if (!agent) return;
  if (tab.centerLeaves.has(agent.leaf)) {
    tab.selected = agentId;
    if (focus) setCenterVisible(tab, agent.leaf);
    else {
      for (const l of tab.centerLeaves) l.el.style.display = l === agent.leaf ? '' : 'none';
      agent.leaf.fit.fit();
    }
    tab.els.diffTitle.textContent = `${agent.name} · ${agent.branch}`;
    api.agentsSelectDiff({ agentId, mode: tab.diffMode });
    renderAgentList(tab);
    return;
  }
  // pane lives elsewhere (normal tab or another agent tab) — jump to it
  const homeTab = agentTabs().find((t) => t.centerLeaves.has(agent.leaf)) || tabOfPane(agent.leaf);
  if (homeTab) {
    activateTab(homeTab);
    if (homeTab.kind === 'agents') selectAgent(homeTab, agentId);
    else focusPane(agent.leaf);
  }
}

async function resumeSession(tab, session) {
  const leaf = await createPane({ cwd: session.cwd, run: 'claude --continue' });
  addCenterLeaf(tab, leaf, true);
  pendingNames.set(leaf.ptyId, session.name);
}

function renderAgentList(tab) {
  const rows = [];
  for (const agent of globalAgents.values()) {
    const row = document.createElement('div');
    row.className = 'agent-row' + (tab.selected === agent.id ? ' selected' : '');
    row.innerHTML = `
      <span class="agent-dot st-${agent.status}"></span>
      <span class="agent-name"></span>
      <span class="agent-meta"></span>`;
    row.querySelector('.agent-name').textContent = agent.name;
    row.querySelector('.agent-meta').textContent = `${agent.branch} · ${agent.status}`;
    row.addEventListener('click', () => selectAgent(tab, agent.id));
    rows.push(row);
  }
  const liveCwds = new Set([...globalAgents.values()].map((a) => a.cwd));
  for (const s of sessions) {
    if (liveCwds.has(s.cwd)) continue;
    const row = document.createElement('div');
    row.className = 'agent-row dormant';
    row.title = `Resume last Claude session in ${s.cwd}`;
    row.innerHTML = `
      <span class="agent-dot st-exited"></span>
      <span class="agent-name"></span>
      <button class="session-remove" title="Forget this session">×</button>
      <span class="agent-meta"></span>`;
    row.querySelector('.agent-name').textContent = s.name;
    row.querySelector('.agent-meta').textContent = `${s.branch} · resume`;
    row.addEventListener('click', () => resumeSession(tab, s));
    row.querySelector('.session-remove').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      sessions = await api.agentsRemoveSession(s.cwd);
      renderAgentLists();
    });
    rows.push(row);
  }
  tab.els.agentsList.replaceChildren(...rows);
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No agents yet — run claude in the terminal';
    tab.els.agentsList.appendChild(p);
  }
}

function renderDiff(tab, patch, statusText) {
  const out = document.createElement('div');
  const untracked = (statusText || '')
    .split('\n')
    .filter((l) => l.startsWith('??'))
    .map((l) => l.slice(3).trim());
  if (!patch.trim() && !untracked.length) {
    out.innerHTML = '<p class="hint">No changes yet</p>';
    tab.els.diffBody.replaceChildren(out);
    return;
  }
  let body = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git')) {
      const m = / b\/(.+)$/.exec(line);
      const file = document.createElement('div');
      file.className = 'diff-file';
      const head = document.createElement('div');
      head.className = 'diff-file-head';
      head.textContent = m ? m[1] : line;
      body = document.createElement('div');
      body.className = 'diff-file-body';
      const b = body;
      head.addEventListener('click', () => b.classList.toggle('collapsed'));
      file.append(head, body);
      out.appendChild(file);
    } else if (!body) {
      continue;
    } else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) {
      continue;
    } else {
      const d = document.createElement('div');
      d.className =
        'diff-line' +
        (line.startsWith('+') ? ' add' : line.startsWith('-') ? ' del' : line.startsWith('@@') ? ' hunk' : '');
      d.textContent = line || ' ';
      body.appendChild(d);
    }
  }
  if (untracked.length) {
    const file = document.createElement('div');
    file.className = 'diff-file';
    const head = document.createElement('div');
    head.className = 'diff-file-head';
    head.textContent = `untracked (${untracked.length})`;
    const b = document.createElement('div');
    b.className = 'diff-file-body';
    untracked.forEach((f) => {
      const d = document.createElement('div');
      d.className = 'diff-line add';
      d.textContent = '+ ' + f;
      b.appendChild(d);
    });
    head.addEventListener('click', () => b.classList.toggle('collapsed'));
    file.append(head, b);
    out.appendChild(file);
  }
  tab.els.diffBody.replaceChildren(out);
}

api.onAgentStatus(({ agentId, status }) => {
  const agent = globalAgents.get(agentId);
  if (!agent) return;
  agent.status = status;
  renderAgentLists();
});

api.onAgentDiff(({ agentId, patch, status, nogit }) => {
  for (const tab of agentTabs()) {
    if (tab.selected !== agentId) continue;
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

api.onAgentEnded(({ agentId, sessions: s }) => {
  if (s) sessions = s;
  const agent = globalAgents.get(agentId);
  if (agent) {
    globalAgents.delete(agentId);
    agentsByPty.delete(agent.ptyId);
    for (const tab of agentTabs()) {
      if (tab.selected === agentId) tab.selected = null;
    }
  }
  renderAgentLists();
});

// ---------- shortcuts ----------

function matchShortcut(ev) {
  const ctrlShift = ev.ctrlKey && ev.shiftKey && !ev.altKey;
  const altShift = ev.altKey && ev.shiftKey && !ev.ctrlKey;

  if (ctrlShift && ev.code === 'KeyT') return () => newTab();
  if (ctrlShift && ev.code === 'KeyA') return () => newAgentTab();
  if (ctrlShift && ev.code === 'KeyW') {
    return () => state.activeTab?.activePane && removePane(state.activeTab.activePane);
  }
  if (altShift && (ev.code === 'Equal' || ev.code === 'NumpadAdd')) return () => splitPane('row');
  if (altShift && (ev.code === 'Minus' || ev.code === 'NumpadSubtract')) return () => splitPane('col');
  if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.code === 'Comma') return () => toggleSettings();
  if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.code === 'KeyF') {
    return () => state.activeTab?.activePane && openPaneSearch(state.activeTab.activePane);
  }
  if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.code === 'Tab') return () => cycleTab(1);
  if (ev.ctrlKey && ev.shiftKey && ev.code === 'Tab') return () => cycleTab(-1);
  return null;
}

function cycleTab(dir) {
  if (state.tabs.length < 2) return;
  const i = state.tabs.indexOf(state.activeTab);
  activateTab(state.tabs[(i + dir + state.tabs.length) % state.tabs.length]);
}

window.addEventListener('focus', () => document.body.classList.add('win-focused'));
window.addEventListener('blur', () => document.body.classList.remove('win-focused'));
if (document.hasFocus()) document.body.classList.add('win-focused');

window.addEventListener('keydown', (ev) => {
  const action = matchShortcut(ev);
  if (action) {
    ev.preventDefault();
    ev.stopPropagation();
    action();
  }
});

// ---------- settings UI ----------

const s = {
  material: document.getElementById('s-material'),
  colorMode: document.getElementById('s-colormode'),
  glassBlur: document.getElementById('s-glass-blur'),
  glassBlurVal: document.getElementById('s-glass-blur-val'),
  contrast: document.getElementById('s-contrast'),
  gpu: document.getElementById('s-gpu'),
  autoDetect: document.getElementById('s-autodetect'),
  copyOnSelect: document.getElementById('s-copyonselect'),
  startDir: document.getElementById('s-startdir'),
  tintColor: document.getElementById('s-tint-color'),
  tintAlpha: document.getElementById('s-tint-alpha'),
  tintAlphaVal: document.getElementById('s-tint-alpha-val'),
  accent: document.getElementById('s-accent'),
  fontFamily: document.getElementById('s-font-family'),
  fontSize: document.getElementById('s-font-size'),
  fontSizeVal: document.getElementById('s-font-size-val'),
  padding: document.getElementById('s-padding'),
  paddingVal: document.getElementById('s-padding-val'),
  radius: document.getElementById('s-radius'),
  radiusVal: document.getElementById('s-radius-val'),
  cursorStyle: document.getElementById('s-cursor-style'),
  cursorBlink: document.getElementById('s-cursor-blink')
};

function toggleSettings() {
  el.settings.classList.toggle('open');
  const diag = document.getElementById('diag');
  if (el.settings.classList.contains('open') && diag) {
    const node = state.activeTab ? firstLeaf(state.activeTab.root) : null;
    diag.textContent = node
      ? `diag — renderer: ${node.webgl ? 'webgl' : 'dom'} · unicode: ${node.term.unicode.activeVersion} · ${node.term.cols}x${node.term.rows}`
      : 'diag — no terminal';
  }
}

document.getElementById('btn-settings').addEventListener('click', toggleSettings);
document.getElementById('btn-settings-close').addEventListener('click', toggleSettings);
document.getElementById('btn-newtab').addEventListener('click', () => newTab());
document.getElementById('btn-agents').addEventListener('click', () => newAgentTab());
async function populateFontList() {
  const families = await api.fontsList();
  const ctx = document.createElement('canvas').getContext('2d');
  const isMono = (f) => {
    ctx.font = `16px "${f}"`;
    return Math.abs(ctx.measureText('iiiiii').width - ctx.measureText('WWWWWW').width) < 0.5;
  };
  const monos = families.filter(isMono);
  const current = s.fontFamily.value;
  s.fontFamily.replaceChildren(
    ...monos.map((f) => {
      const o = document.createElement('option');
      o.value = f;
      o.textContent = f;
      return o;
    })
  );
  if (current && !monos.includes(current)) {
    const o = document.createElement('option');
    o.value = current;
    o.textContent = current;
    s.fontFamily.prepend(o);
  }
  if (current) s.fontFamily.value = current;
}

document.getElementById('s-startdir-browse').addEventListener('click', async () => {
  const dir = await api.pickDir();
  if (dir) {
    s.startDir.value = dir;
    onSettingChange();
  }
});
document.getElementById('btn-open-theme').addEventListener('click', () => api.themeOpenFile('json'));
document.getElementById('btn-open-css').addEventListener('click', () => api.themeOpenFile('css'));

function parseTint(tint) {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\)/.exec(tint || '');
  if (!m) return { hex: '#0a0c14', alpha: 0.55 };
  const hex =
    '#' + [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, '0')).join('');
  return { hex, alpha: m[4] !== undefined ? +m[4] : 1 };
}

function hexToRgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

let syncing = false;

function syncSettingsUI() {
  const t = state.theme;
  if (!t) return;
  syncing = true;
  const tint = parseTint(t.tint);
  s.material.value = t.material || 'acrylic';
  s.colorMode.value = t.colorMode || 'dark';
  s.glassBlur.value = t.glassBlur ?? 40;
  s.glassBlurVal.textContent = (t.glassBlur ?? 40) + 'px';
  s.contrast.value = String(t.minContrast ?? 4.5);
  s.gpu.checked = t.gpuRenderer !== false;
  s.autoDetect.checked = t.autoDetectAgents !== false;
  s.copyOnSelect.checked = t.copyOnSelect !== false;
  s.startDir.value = t.startDir || '';
  s.tintColor.value = tint.hex;
  s.tintAlpha.value = Math.round(tint.alpha * 100);
  s.tintAlphaVal.textContent = Math.round(tint.alpha * 100) + '%';
  s.accent.value = t.accent || '#7aa2f7';
  const fam = (t.font?.family || '').split(',')[0].replace(/"/g, '').trim();
  if (fam && ![...s.fontFamily.options].some((o) => o.value === fam)) {
    const o = document.createElement('option');
    o.value = fam;
    o.textContent = fam;
    s.fontFamily.prepend(o);
  }
  s.fontFamily.value = fam;
  s.fontSize.value = t.font?.size || 14;
  s.fontSizeVal.textContent = (t.font?.size || 14) + 'px';
  s.padding.value = t.padding ?? 14;
  s.paddingVal.textContent = (t.padding ?? 14) + 'px';
  s.radius.value = t.cornerRadius ?? 8;
  s.radiusVal.textContent = (t.cornerRadius ?? 8) + 'px';
  s.cursorStyle.value = t.cursor?.style || 'bar';
  s.cursorBlink.checked = t.cursor?.blink !== false;
  syncing = false;
}

const saveTheme = debounce(() => {
  if (state.theme) api.themeSave(state.theme);
}, 200);

function onSettingChange() {
  if (syncing || !state.theme) return;
  const t = state.theme;
  const [r, g, b] = hexToRgb(s.tintColor.value);
  const alpha = (+s.tintAlpha.value / 100).toFixed(2);
  t.material = s.material.value;
  t.colorMode = s.colorMode.value;
  t.glassBlur = +s.glassBlur.value;
  t.minContrast = parseFloat(s.contrast.value);
  t.gpuRenderer = s.gpu.checked;
  t.autoDetectAgents = s.autoDetect.checked;
  t.copyOnSelect = s.copyOnSelect.checked;
  t.startDir = s.startDir.value.trim();
  t.tint = `rgba(${r}, ${g}, ${b}, ${alpha})`;
  t.accent = s.accent.value;
  t.font = t.font || {};
  if (s.fontFamily.value) t.font.family = `"${s.fontFamily.value}", Consolas, monospace`;
  t.font.size = +s.fontSize.value;
  t.padding = +s.padding.value;
  t.cornerRadius = +s.radius.value;
  t.cursor = t.cursor || {};
  t.cursor.style = s.cursorStyle.value;
  t.cursor.blink = s.cursorBlink.checked;
  applyTheme(t, undefined);
  saveTheme();
}

for (const input of Object.values(s)) {
  if (input && input.tagName) {
    input.addEventListener('input', onSettingChange);
    input.addEventListener('change', onSettingChange);
  }
}

// ---------- glass background ----------

function updateGlassPos({ bounds, display }) {
  if (bounds) glassState.bounds = bounds;
  if (display) glassState.display = display;
  const b = glassState.bounds;
  const d = glassState.display;
  if (!b || !d) return;
  // #glass-bg is inset -80px, so shift the wallpaper by +80 to stay screen-aligned
  el.glassBg.style.backgroundSize = `${d.width}px ${d.height}px`;
  el.glassBg.style.backgroundPosition = `${d.x - b.x + 80}px ${d.y - b.y + 80}px`;
}

async function initGlass() {
  const info = await api.glassInfo();
  if (!info.wallpaper) {
    toast('Glass mode: could not read wallpaper — tint only');
    return;
  }
  el.glassBg.style.backgroundImage = `url("${info.wallpaper}")`;
  updateGlassPos(info);
  api.onWinBounds(updateGlassPos);
}

// ---------- pty events ----------

api.onPtyData(({ id, data }) => {
  panesByPty.get(id)?.term.write(data);
});

api.onPtyExit(({ id }) => {
  const agent = agentsByPty.get(id);
  if (agent) {
    agentsByPty.delete(id);
    globalAgents.delete(agent.id);
    for (const tab of agentTabs()) {
      if (tab.selected === agent.id) tab.selected = null;
    }
    renderAgentLists();
  }
  const node = panesByPty.get(id);
  if (!node) return;
  // panes hosted in an agent-tab center stay as frozen output; others close
  const inAgentCenter = agentTabs().some((t) => t.centerLeaves.has(node));
  if (inAgentCenter) return;
  panesByPty.delete(id);
  removePane(node, { killPty: false });
});

api.onThemeChanged(({ theme, css, error, notice }) => {
  if (error) {
    toast(error);
    return;
  }
  applyTheme(theme, css);
  if (notice) toast(notice);
});

// ---------- boot ----------

document.getElementById('btn-min').addEventListener('click', () => api.winMinimize());
document.getElementById('btn-max').addEventListener('click', () => api.winMaximize());
document.getElementById('btn-close').addEventListener('click', () => api.winClose());

(async () => {
  const { theme, css, frameless } = await api.themeGet();
  glassState.active = Boolean(frameless);
  if (frameless) {
    document.body.classList.add('frameless');
    await initGlass();
  }
  applyTheme(theme, css);
  populateFontList();

  // Wait for the terminal font before opening the first terminal — opening
  // with a fallback font bakes wrong glyph metrics into the renderer atlas
  // (garbled emoji/status lines until a manual renderer reset).
  try {
    await document.fonts.load(`${theme.font?.size || 14}px ${theme.font?.family || 'monospace'}`);
    await document.fonts.ready;
  } catch {}

  await newTab();

  // Belt and braces: one atlas rebuild after boot in case a font swapped late
  setTimeout(() => {
    for (const node of panesByPty.values()) {
      try {
        node.webgl?.clearTextureAtlas();
        node.term.refresh(0, node.term.rows - 1);
      } catch {}
    }
  }, 1500);

  // Write renderer diagnostics to config/diag.json (debugging aid)
  setTimeout(() => {
    try {
      const node = state.activeTab ? firstLeaf(state.activeTab.root) : null;
      const report = {
        when: new Date().toISOString(),
        unicodeActive: node ? node.term.unicode.activeVersion : null,
        unicodeRegistered: node ? node.term.unicode.versions : null,
        unicodeError: window.__unicodeError || null,
        renderer: node ? (node.webgl ? 'webgl' : 'dom') : null,
        cols: node?.term.cols,
        rows: node?.term.rows,
        themeUnicodeVersion: state.theme?.unicodeVersion || null,
        wideTest: null
      };

      // probe: write "🚦 X" into a hidden terminal, inspect cell layout
      const probe = new Terminal({ allowProposedApi: true });
      try {
        probe.loadAddon(new Unicode11Addon.Unicode11Addon());
        probe.unicode.activeVersion = state.theme?.unicodeVersion || '11';
      } catch (e) {
        report.probeUnicodeError = String(e);
      }
      const div = document.createElement('div');
      div.style.cssText = 'position:absolute;left:-9999px;top:0;width:400px;height:120px;';
      document.body.appendChild(div);
      probe.open(div);
      probe.write('\u{1F6A6} X', () => {
        const line = probe.buffer.active.getLine(0);
        const cells = [];
        for (let i = 0; i < 6; i++) {
          const c = line.getCell(i);
          cells.push({ i, ch: c ? c.getChars() : null, w: c ? c.getWidth() : null });
        }
        report.wideTest = cells;
        api.diagReport(report);
        probe.dispose();
        div.remove();
      });
    } catch (e) {
      api.diagReport({ diagError: String(e) });
    }
  }, 2500);
})();
