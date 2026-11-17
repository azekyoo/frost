// Loading: a new pane is empty until its shell has started, and a slow profile
// makes that a long, blank moment that reads as Frost hanging. Until there is
// something to type into — the shell's first prompt, or, for a pane opened to
// run claude, the moment claude's own prompt takes keys — a light runs around
// the pane's border and three dots pulse where the prompt will appear.
// theme.loadingStyle picks 'border', 'dots' or 'both'. A quick start shows
// nothing at all.

const LOAD_SHOW_AFTER = 150; // ms: a shell up before this never flickers a sweep
const LOAD_CAP_MS = 20000; // whatever happened, the sweep doesn't run forever
// a shell without Frost's prompt hook can't say it's ready: its first output,
// once it has gone quiet for a moment, is the closest sign
const LOAD_QUIET_MS = 250;

function attachLoading(node, { run, marked }) {
  const style = state.theme?.loadingStyle || 'both';
  const bar = document.createElement('div');
  bar.className = 'pane-loading';
  if (style !== 'dots') bar.insertAdjacentHTML('beforeend', '<div class="load-trace"></div>');
  if (style !== 'border') bar.insertAdjacentHTML('beforeend', '<div class="load-dots"><i></i><i></i><i></i></div>');
  const ld = { bar, done: false, timers: [] };
  node.loading = ld;

  const finish = () => {
    if (ld.done) return;
    ld.done = true;
    ld.timers.forEach(clearTimeout);
    if (!bar.isConnected) return;
    bar.classList.remove('on');
    bar.addEventListener('transitionend', (ev) => ev.target === bar && bar.remove());
    setTimeout(() => bar.remove(), 600); // no transition (hidden tab, reduced motion)
  };
  ld.finish = finish;

  ld.timers.push(
    setTimeout(() => {
      if (ld.done) return;
      node.el.appendChild(bar);
      placeLoadDots(node, bar);
      // next frame, so it fades in rather than appears
      requestAnimationFrame(() => !ld.done && bar.classList.add('on'));
    }, LOAD_SHOW_AFTER),
    setTimeout(finish, LOAD_CAP_MS)
  );
  // the dots stay at the cursor: a pane opened to run claude draws the shell's
  // prompt and the command first, and the dots move along past them
  node.term.onWriteParsed(() => !ld.done && bar.isConnected && placeLoadDots(node, bar));

  if (run) {
    // claude switches on focus reporting once its prompt is up; no shell does
    node.term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (params.includes(1004)) finish();
      return false;
    });
  } else if (marked) {
    node.term.parser.registerOscHandler(133, (data) => {
      if (String(data).startsWith('A')) finish();
      return false;
    });
  } else {
    let quiet = null;
    node.term.onWriteParsed(() => {
      if (ld.done) return;
      clearTimeout(quiet);
      quiet = setTimeout(finish, LOAD_QUIET_MS);
      ld.timers.push(quiet);
    });
  }
}

// where the cursor is — the top left, in a fresh shell — one cell tall
function placeLoadDots(node, bar) {
  const dots = bar.querySelector('.load-dots');
  const screen = node.term.element?.querySelector('.xterm-screen');
  if (!dots || !screen) return;
  const pane = node.el.getBoundingClientRect();
  const box = screen.getBoundingClientRect();
  const cellW = box.width / node.term.cols;
  const cellH = box.height / node.term.rows;
  const buf = node.term.buffer.active;
  Object.assign(dots.style, {
    left: box.left - pane.left - node.el.clientLeft + buf.cursorX * cellW + 'px',
    top: box.top - pane.top - node.el.clientTop + buf.cursorY * cellH + 'px',
    height: cellH + 'px'
  });
  dots.style.setProperty('--cell', cellH + 'px');
}
