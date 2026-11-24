// ---------- find in file ----------
// The terminal's find bar, same look and same Aa / ab / .* options (one set for
// the whole app, as there). Matches are painted with the CSS highlight API
// rather than by wrapping them in elements, so the highlighted code and the
// rendered markdown are searched as they are, without being rebuilt.

const PEEK_FIND_MAX = 5000;

function peekBuildFind(root) {
  const bar = document.createElement('div');
  bar.className = 'pane-search peek-find';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'pane-search-input';
  input.placeholder = 'Find';
  input.spellcheck = false;
  const count = document.createElement('span');
  count.className = 'pane-search-count';
  const mkBtn = (text, title, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', fn);
    return b;
  };
  const toggles = SEARCH_TOGGLES.map(({ key, label, title }) => {
    const b = mkBtn(label, title, () => {
      searchOptions[key] = !searchOptions[key];
      applySearchOptions(); // the panes' bars show the same set
      peekSyncToggles();
      peekFindRun(false);
    });
    b.className = 'pane-search-toggle';
    b.addEventListener('mousedown', (ev) => ev.preventDefault()); // keep the caret in the box
    return b;
  });
  bar.append(
    input,
    ...toggles,
    count,
    mkBtn('▲', 'Previous match (Shift+Enter)', () => peekFindStep(-1)),
    mkBtn('▼', 'Next match (Enter)', () => peekFindStep(1)),
    mkBtn('×', 'Close (Esc)', peekCloseFind)
  );
  root.querySelector('.peek-main').appendChild(bar);
  peek.find = { bar, input, count, toggles, ranges: [], lines: [], index: -1 };

  input.addEventListener('input', () => peekFindRun(true));
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') peekFindStep(ev.shiftKey ? -1 : 1);
    else if (ev.key === 'Escape') peekCloseFind();
    else if (ev.altKey && !ev.ctrlKey && !ev.shiftKey && SEARCH_TOGGLES.some((t) => t.code === ev.code)) {
      const hit = SEARCH_TOGGLES.find((t) => t.code === ev.code);
      searchOptions[hit.key] = !searchOptions[hit.key];
      applySearchOptions();
      peekSyncToggles();
      peekFindRun(false);
    } else return;
    ev.preventDefault();
    ev.stopPropagation(); // Esc closes the bar, not the whole viewer
  });
}

function peekSyncToggles() {
  peek.find.toggles.forEach((b, i) => b.classList.toggle('on', Boolean(searchOptions[SEARCH_TOGGLES[i].key])));
}

function peekOpenFind() {
  if (!peek.file) return;
  const { bar, input } = peek.find;
  peekSyncToggles();
  bar.classList.add('open');
  // a selection in the file is the likeliest thing to look for
  const sel = window.getSelection().toString();
  if (sel && !sel.includes('\n')) input.value = sel;
  input.focus();
  input.select();
  peekFindRun(false);
}

function peekCloseFind() {
  const f = peek.find;
  if (!f) return;
  f.bar.classList.remove('open');
  peekClearFind();
  peek.root.querySelector('.peek-body').focus({ preventScroll: true });
}

function peekClearFind() {
  const f = peek.find;
  CSS.highlights.delete('peek-find');
  CSS.highlights.delete('peek-find-active');
  f.ranges = [];
  f.lines = [];
  f.index = -1;
  f.count.textContent = '';
  f.bar.classList.remove('bad');
  peekDrawMini();
}

// What is on screen: the code, or the rendered markdown.
function peekFindTarget() {
  const md = peek.root.querySelector('.peek-md');
  return md.hidden ? peek.root.querySelector('.peek-code code') : md;
}

// keep: stay on the current match while it still matches (typing a longer query)
function peekFindRun(keep) {
  const f = peek.find;
  if (!f?.bar.classList.contains('open')) return;
  const before = f.ranges[f.index];
  const anchor = before ? { node: before.startContainer, offset: before.startOffset } : null;
  peekClearFind();
  const query = f.input.value;
  if (!query || !peek.file) return;
  let re;
  try {
    let src = searchOptions.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (searchOptions.wholeWord) src = `\\b(?:${src})\\b`;
    re = new RegExp(src, 'g' + (searchOptions.caseSensitive ? '' : 'i'));
  } catch {
    // half-typed regex: a search that cannot run yet, not an error
    f.bar.classList.add('bad');
    f.count.textContent = 'Bad pattern';
    return;
  }

  // the text nodes in order, so a match can span highlight.js's spans
  const target = peekFindTarget();
  const nodes = [];
  let text = '';
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n, start: text.length });
    text += n.data;
  }
  const locate = (pos, from) => {
    let i = from;
    while (i < nodes.length - 1 && nodes[i + 1].start <= pos) i++;
    return i;
  };
  const isCode = target.tagName === 'CODE';
  let ni = 0;
  let line = 1;
  let lineAt = 0;
  for (let m = re.exec(text); m && f.ranges.length < PEEK_FIND_MAX; m = re.exec(text)) {
    if (!m[0].length) {
      re.lastIndex++;
      continue;
    }
    const s = locate(m.index, ni);
    const e = locate(m.index + m[0].length - 1, s);
    ni = s;
    const range = document.createRange();
    range.setStart(nodes[s].node, m.index - nodes[s].start);
    range.setEnd(nodes[e].node, m.index + m[0].length - nodes[e].start);
    f.ranges.push(range);
    if (isCode) {
      for (let i = text.indexOf('\n', lineAt); i !== -1 && i < m.index; i = text.indexOf('\n', i + 1)) {
        line++;
        lineAt = i + 1;
      }
      f.lines.push(line);
    }
  }
  if (!f.ranges.length) {
    f.count.textContent = 'No results';
    return;
  }
  CSS.highlights.set('peek-find', new Highlight(...f.ranges));
  // the match just left, if it is still one; otherwise the first below the view
  let index = -1;
  if (keep && anchor) {
    index = f.ranges.findIndex(
      (r) => r.startContainer === anchor.node && r.startOffset === anchor.offset
    );
  }
  if (index < 0) {
    const top = peek.root.querySelector('.peek-body').getBoundingClientRect().top;
    index = Math.max(0, f.ranges.findIndex((r) => r.getBoundingClientRect().top >= top));
  }
  peekFindSelect(index);
  peekDrawMini();
}

function peekFindStep(dir) {
  const f = peek.find;
  if (!f.ranges.length) return peekFindRun(false);
  peekFindSelect((f.index + dir + f.ranges.length) % f.ranges.length);
}

function peekFindSelect(index) {
  const f = peek.find;
  f.index = index;
  const range = f.ranges[index];
  CSS.highlights.set('peek-find-active', new Highlight(range));
  f.count.textContent = `${index + 1}/${f.ranges.length}${f.ranges.length >= PEEK_FIND_MAX ? '+' : ''}`;
  // into view, centred, sideways too for a match far along a long line
  const body = peek.root.querySelector('.peek-body');
  const box = body.getBoundingClientRect();
  const r = range.getBoundingClientRect();
  if (r.top < box.top + 40 || r.bottom > box.bottom - 20) body.scrollTop += r.top - box.top - body.clientHeight / 2;
  const gutter = peek.root.querySelector('.peek-gutter').offsetWidth;
  if (r.left < box.left + gutter || r.right > box.right - 20) body.scrollLeft += r.left - box.left - body.clientWidth / 2;
}

