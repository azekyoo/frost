// Tab previews: resting on a tab you aren't in slides out a small live copy of
// its panes, laid out as they are, so an agent waiting on you, a build that
// finished or a server that fell over shows without switching to it. Drawn as
// text straight off each terminal's buffer — a hidden tab paints nothing, but
// its buffer is always current — and redrawn while it stays open.

const PREVIEW_DELAY = 380;
const PREVIEW_REFRESH_MS = 400;
const PREVIEW_W = 440;

const previewsOn = () => state.theme?.tabPreviews !== false;
const pv = { node: null, tab: null, tabEl: null, timer: null, live: null };

function previewNode() {
  if (pv.node) return pv.node;
  pv.node = document.createElement('div');
  pv.node.id = 'tab-preview';
  document.body.appendChild(pv.node);
  return pv.node;
}

// the panes of a tab as a tree; an agents tab shows the agent you're on
function previewTree(tab) {
  if (tab.root) return tab.root;
  const leaves = [...(tab.centerLeaves || [])];
  return leaves.find((l) => l.el.style.display !== 'none') || leaves[0] || null;
}

function previewLeaf(leaf) {
  const div = document.createElement('div');
  div.className = 'pv-leaf' + (leaf === pv.tab?.activePane ? ' active' : '');
  const pre = document.createElement('pre');
  const buf = leaf.term.buffer.active;
  const lines = [];
  for (let i = 0; i < leaf.term.rows; i++) {
    lines.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? '');
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  pre.textContent = lines.join('\n');
  div.appendChild(pre);
  return div;
}

function previewSplit(node) {
  if (node.type === 'leaf') return previewLeaf(node);
  const wrap = document.createElement('div');
  wrap.className = 'pv-split ' + node.dir;
  node.children.forEach((child, i) => {
    const c = previewSplit(child);
    c.style.flex = `${node.sizes[i]} 1 0%`;
    wrap.appendChild(c);
  });
  return wrap;
}

function paintPreview() {
  const tab = pv.tab;
  const tree = tab && state.tabs.includes(tab) ? previewTree(tab) : null;
  if (!tree || !pv.tabEl?.isConnected) return hidePreview();
  const node = previewNode();
  // laid out at the size the tab really has, then shrunk: the text wraps
  // and sits where it would on screen
  const area = el.content.getBoundingClientRect();
  const w = Math.max(area.width, 200);
  const h = Math.max(area.height, 120);
  const cardW = Math.min(PREVIEW_W, window.innerWidth * 0.45);
  const scale = cardW / w;

  const head = document.createElement('div');
  head.className = 'pv-head';
  const pane = tab.activePane || (tree.type === 'leaf' ? tree : null);
  head.append(
    Object.assign(document.createElement('span'), { className: 'pv-title', textContent: tabLabel(tab) }),
    Object.assign(document.createElement('span'), { className: 'pv-cwd', textContent: pane?.cwd || '' })
  );
  const stage = document.createElement('div');
  stage.className = 'pv-stage';
  stage.style.width = cardW + 'px';
  stage.style.height = h * scale + 'px';
  const layout = previewSplit(tree);
  layout.classList.add('pv-layout');
  Object.assign(layout.style, {
    width: w + 'px',
    height: h + 'px',
    transform: `scale(${scale})`,
    fontFamily: state.theme?.font?.family || 'Consolas, monospace',
    fontSize: (state.theme?.font?.size || 16) + 'px',
    lineHeight: state.theme?.font?.lineHeight || 1.15
  });
  stage.appendChild(layout);
  node.replaceChildren(head, stage);

  const r = pv.tabEl.getBoundingClientRect();
  const x = Math.max(6, Math.min(r.left, window.innerWidth - node.offsetWidth - 6));
  node.style.transform = `translate(${Math.round(x)}px, ${Math.round(r.bottom + 6)}px)`;
  node.classList.add('show');
}

function showPreview(tab, tabEl) {
  pv.tab = tab;
  pv.tabEl = tabEl;
  paintPreview();
  clearInterval(pv.live);
  pv.live = setInterval(paintPreview, PREVIEW_REFRESH_MS);
}

function hidePreview() {
  clearTimeout(pv.timer);
  clearInterval(pv.live);
  pv.timer = pv.live = null;
  pv.tab = pv.tabEl = null;
  pv.node?.classList.remove('show');
}

// Delegated: the strip rebuilds its tabs often, under a resting pointer too
el.tabstrip.addEventListener('mouseover', (ev) => {
  const t = ev.target instanceof Element ? ev.target.closest('.tab') : null;
  const tab = t?.tabData;
  if (!tab || ev.buttons || !previewsOn() || tab === state.activeTab) {
    if (!t?.tabData || tab === state.activeTab) hidePreview();
    return;
  }
  if (pv.tab === tab) {
    pv.tabEl = t; // the same tab, redrawn
    return;
  }
  clearTimeout(pv.timer);
  // already showing one: moving along the strip swaps at once
  if (pv.live) return showPreview(tab, t);
  pv.timer = setTimeout(() => showPreview(tab, t), PREVIEW_DELAY);
});
el.tabstrip.addEventListener('mouseleave', hidePreview);
for (const ev of ['mousedown', 'wheel', 'keydown']) {
  document.addEventListener(ev, hidePreview, { capture: true, passive: true });
}
window.addEventListener('blur', hidePreview);
