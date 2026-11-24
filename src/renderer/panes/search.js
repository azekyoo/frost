// ---------- buffer search ----------

const SEARCH_DECORATIONS = {
  matchBackground: '#5a4a1f',
  matchBorder: '#8a7020',
  matchOverviewRuler: '#8a7020',
  activeMatchBackground: '#c98a1f',
  activeMatchBorder: '#ffb84d',
  activeMatchColorOverviewRuler: '#ffb84d'
};

// Match case, whole word, regular expression — the three every editor has, and
// the addon has always supported them; the bar simply never asked. Held per app
// rather than per pane: a search is a habit, and having to set "match case"
// again in the next pane is the same annoyance as not having it at all. Not
// written to disk, so a new Frost starts plain.
const searchOptions = { caseSensitive: false, wholeWord: false, regex: false };

const SEARCH_TOGGLES = [
  { key: 'caseSensitive', label: 'Aa', title: keyText('Match case (Alt+C)'), code: 'KeyC' },
  { key: 'wholeWord', label: 'ab', title: keyText('Whole word (Alt+W)'), code: 'KeyW' },
  { key: 'regex', label: '.*', title: keyText('Regular expression (Alt+R)'), code: 'KeyR' }
];

// The addon stops adding to its match list at this many and reports that number
// as the total, so a count equal to it is a floor rather than an answer. Named
// here because the bar has to know the same number to say so.
const SEARCH_HIGHLIGHT_LIMIT = 1000;

function attachPaneSearch(node) {
  const search = new SearchAddon.SearchAddon({ highlightLimit: SEARCH_HIGHLIGHT_LIMIT });
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

  const toggles = SEARCH_TOGGLES.map(({ key, label, title }) => {
    const b = document.createElement('button');
    b.className = 'pane-search-toggle';
    b.textContent = label;
    b.title = title;
    b.addEventListener('mousedown', (ev) => ev.preventDefault()); // keep the caret in the box
    b.addEventListener('click', () => {
      searchOptions[key] = !searchOptions[key];
      applySearchOptions();
    });
    return b;
  });
  node.searchToggles = toggles;

  bar.append(input, ...toggles, count, prev, next, close);
  node.el.appendChild(bar);
  node.searchEl = bar;
  node.searchInput = input;

  search.onDidChangeResults(({ resultIndex, resultCount }) => {
    if (resultCount === 0) {
      count.textContent = 'No results';
      return;
    }
    // At the limit the total is a ceiling, not a count — there may be ten times
    // as many — and past it the addon stops tracking which match is current and
    // reports -1, which used to render as the position "0". Neither is a thing
    // to state as fact, so both say what is actually known.
    if (resultCount >= SEARCH_HIGHLIGHT_LIMIT || resultIndex < 0) {
      count.textContent = `${SEARCH_HIGHLIGHT_LIMIT}+ matches`;
      return;
    }
    count.textContent = `${resultIndex + 1}/${resultCount}`;
  });

  function go(dir, incremental) {
    const query = input.value;
    bar.classList.remove('bad');
    if (!query) {
      search.clearDecorations();
      count.textContent = '';
      return;
    }
    // A regex is typed a character at a time, so most of the way to a working
    // one it is a broken one. That is not an error to report, only a search
    // that cannot run yet — the box says so and the count stays quiet.
    if (searchOptions.regex) {
      try {
        new RegExp(query);
      } catch {
        search.clearDecorations();
        bar.classList.add('bad');
        count.textContent = 'Bad pattern';
        return;
      }
    }
    const searchOpts = { ...searchOptions, decorations: SEARCH_DECORATIONS, incremental };
    if (dir === 'prev') search.findPrevious(query, searchOpts);
    else search.findNext(query, searchOpts);
  }
  // Flipping an option is not typing. Incremental keeps the current selection
  // while it still matches, which is right for a query growing a letter at a
  // time and wrong here. clearDecorations() is the other half: the addon caches
  // its match list against the term it was built for, so with the term unchanged
  // the count would keep answering the old question — turning on match case
  // moved the selection but went on reporting every casing.
  function rerun() {
    search.clearDecorations();
    go('next', false);
  }
  node.searchRerun = rerun;

  input.addEventListener('input', () => go('next', true));
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      go(ev.shiftKey ? 'prev' : 'next', false);
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closePaneSearch(node);
      return;
    }
    // The same letters every editor uses, so the options are reachable without
    // leaving the box for the mouse
    if (ev.altKey && !ev.ctrlKey && !ev.shiftKey) {
      const hit = SEARCH_TOGGLES.find((t) => t.code === ev.code);
      if (!hit) return;
      ev.preventDefault();
      searchOptions[hit.key] = !searchOptions[hit.key];
      applySearchOptions();
    }
  });
  prev.addEventListener('click', () => go('prev', false));
  next.addEventListener('click', () => go('next', false));
  close.addEventListener('click', () => closePaneSearch(node));
}

// Every pane in every tab of this window: the options are one set, so the
// buttons showing them have to agree wherever they are on screen.
function allPanes() {
  const out = [];
  for (const tab of state.tabs) {
    if (tab.kind === 'agents') out.push(...tab.centerLeaves, ...(tab.dockLeaves || []));
    else if (tab.root) out.push(...allLeaves(tab.root));
  }
  return out;
}

// The options are one set, so every bar showing them updates — buttons and
// counts alike. A bar left open in another pane answering the old question is
// the same lie as the one this fixed in the pane you are looking at.
function applySearchOptions() {
  for (const pane of allPanes()) {
    syncSearchToggles(pane);
    if (pane.searchEl?.classList.contains('open')) pane.searchRerun?.();
  }
}

function syncSearchToggles(node) {
  if (!node?.searchToggles) return;
  node.searchToggles.forEach((b, i) => {
    b.classList.toggle('on', Boolean(searchOptions[SEARCH_TOGGLES[i].key]));
  });
}

function openPaneSearch(node) {
  if (!node?.searchEl) return;
  syncSearchToggles(node);
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

