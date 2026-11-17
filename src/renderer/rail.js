// Command rail: every finished command in the scrollback as a tick in the
// pane's right margin, green or red by how it exited, with a faint window for
// the part on screen. Hovering a tick names the command; clicking it scrolls
// there. A long session becomes something to look across instead of scroll
// through. It lives in the pane's padding, outside the terminal, so it covers
// neither the text nor xterm's own scrollbar.

const RAIL_REFRESH_MS = 120;
const RAIL_HIT = 8; // px from a tick that still counts as on it
const RAIL_W = 10;

const railOn = () => state.theme?.commandRail !== false;

function attachCommandRail(node) {
  const rail = document.createElement('div');
  rail.className = 'cmd-rail';
  const view = document.createElement('div');
  view.className = 'rail-view';
  const ticks = document.createElement('div');
  ticks.className = 'rail-ticks';
  rail.append(view, ticks);
  const card = document.createElement('div');
  card.className = 'rail-card';
  node.el.append(rail, card);

  const r = { node, rail, view, ticks, card, timer: null, items: [], hover: null };
  node.rail = r;

  const schedule = () => {
    if (r.timer) return;
    r.timer = setTimeout(() => {
      r.timer = null;
      railPaint(r);
    }, RAIL_REFRESH_MS);
  };
  node.railRefresh = schedule;
  node.term.onScroll(schedule);
  node.term.onLineFeed(schedule);
  node.term.onResize(schedule);
  node.term.buffer.onBufferChange(schedule);
  // a command finishing gets its tick; runs after the marks' own handler
  node.term.parser.registerOscHandler(133, () => {
    schedule();
    return false;
  });
  new ResizeObserver(schedule).observe(node.el);

  rail.addEventListener('mousemove', (ev) => railHover(r, ev.clientY));
  rail.addEventListener('mouseleave', () => railUnhover(r));
  // the terminal keeps the focus: the rail is a tool, not a field
  rail.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    if (ev.button !== 0) return;
    const item = railItemAt(r, ev.clientY);
    if (!item || item.mark.marker.isDisposed) return;
    node.term.scrollToLine(Math.max(0, item.mark.marker.line));
    node.term.focus();
  });
}

function railPaint(r) {
  const { node, rail } = r;
  const term = node.term;
  const screen = term.element?.querySelector('.xterm-screen');
  const buf = term.buffer.active;
  const marks = railOn() && buf.type === 'normal' ? liveMarks(node).filter((m) => m.exit !== null) : [];
  if (!screen || !marks.length || !node.el.offsetParent) {
    rail.classList.remove('on');
    railUnhover(r);
    r.items = [];
    return;
  }

  // Beside xterm's scrollbar, never under it: the scrollbar runs down the
  // terminal's right edge and takes the pointer while it shows. The rail sits
  // in the gap between that edge and the pane's; a pane with too little
  // padding for it gets it just inside, left of the scrollbar.
  const pane = node.el.getBoundingClientRect();
  const box = screen.getBoundingClientRect();
  const xr = term.element.getBoundingClientRect().right;
  const border = node.el.clientLeft || 0;
  const gap = pane.right - border - xr;
  const width = Math.min(RAIL_W, Math.max(6, gap - 4));
  const sb = term.element.querySelector('.xterm-scrollable-element > .scrollbar.vertical');
  const sbW = sb?.offsetWidth || 14;
  const left = gap >= width + 2 ? xr + (gap - width) / 2 : xr - sbW - width - 2;
  const top = box.top - pane.top;
  const height = box.height;
  Object.assign(rail.style, {
    top: top + 'px',
    height: height + 'px',
    width: width + 'px',
    right: '',
    left: Math.round(left - pane.left - border) + 'px'
  });

  const len = Math.max(buf.length, 1);
  const showView = buf.length > term.rows;
  r.view.hidden = !showView;
  if (showView) {
    Object.assign(r.view.style, {
      top: (buf.viewportY / len) * height + 'px',
      height: Math.max((term.rows / len) * height, 6) + 'px'
    });
  }

  // one node per tick, reused: a busy shell repaints this often
  const frag = [];
  r.items = marks.map((mark, i) => {
    const y = (mark.marker.line / len) * height;
    let t = r.ticks.children[i];
    if (!t) {
      t = document.createElement('div');
      frag.push(t);
    }
    t.className = 'rail-tick' + (mark.exit !== 0 ? ' failed' : '') + (r.hover?.mark === mark ? ' hot' : '');
    t.style.top = y + 'px';
    return { mark, y, el: t };
  });
  if (frag.length) r.ticks.append(...frag);
  while (r.ticks.children.length > marks.length) r.ticks.lastChild.remove();
  rail.classList.add('on');
  if (r.hover) {
    const still = r.items.find((it) => it.mark === r.hover.mark);
    if (still) railShowCard(r, still);
    else railUnhover(r);
  }
}

function railItemAt(r, clientY) {
  const y = clientY - r.rail.getBoundingClientRect().top;
  let best = null;
  for (const it of r.items) {
    const d = Math.abs(it.y - y);
    if (d <= RAIL_HIT && (!best || d < best.d)) best = { it, d };
  }
  return best?.it || null;
}

function railHover(r, clientY) {
  const item = railItemAt(r, clientY);
  if (item?.mark === r.hover?.mark) return;
  r.hover?.el.classList.remove('hot');
  r.hover = item;
  r.rail.classList.toggle('pointing', !!item);
  if (!item) return r.card.classList.remove('on');
  item.el.classList.add('hot');
  railShowCard(r, item);
}

function railUnhover(r) {
  r.hover?.el.classList.remove('hot');
  r.hover = null;
  r.rail.classList.remove('pointing');
  r.card.classList.remove('on');
}

function railShowCard(r, item) {
  const { node, card } = r;
  const out = markOutput(node, commandRegion(node, item.mark));
  const failed = item.mark.exit !== 0;
  const command = out?.command || '(empty prompt)';
  const lines = out?.output.length || 0;
  card.replaceChildren(
    Object.assign(document.createElement('div'), {
      className: 'rail-cmd',
      textContent: command.length > 90 ? command.slice(0, 89) + '…' : command
    }),
    Object.assign(document.createElement('div'), {
      className: 'rail-meta' + (failed ? ' failed' : ''),
      textContent:
        (failed ? `✕ exit ${item.mark.exit}` : '✓') +
        ` · ${lines ? `${lines} line${lines === 1 ? '' : 's'}` : 'no output'} · click to jump`
    })
  );
  card.classList.add('on');
  const pane = node.el.getBoundingClientRect();
  const rail = r.rail.getBoundingClientRect();
  const h = card.offsetHeight;
  const y = rail.top - pane.top + item.y - h / 2;
  card.style.top = Math.max(4, Math.min(y, pane.height - h - 4)) + 'px';
  card.style.right = pane.right - rail.left + 6 + 'px';
}

function refreshAllRails() {
  for (const leaf of allPanes()) leaf.railRefresh?.();
}
