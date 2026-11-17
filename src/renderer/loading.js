// Loading sweep: a new pane is empty until its shell has started, and a slow
// profile makes that a long, blank moment that reads as Frost hanging. A thin
// light sweeps along the pane's top edge until there is something to type
// into: the shell's first prompt, or — for a pane opened to run claude — the
// moment claude's own prompt takes keys. A quick start shows nothing at all.

const LOAD_SHOW_AFTER = 150; // ms: a shell up before this never flickers a sweep
const LOAD_CAP_MS = 20000; // whatever happened, the sweep doesn't run forever
// a shell without Frost's prompt hook can't say it's ready: its first output,
// once it has gone quiet for a moment, is the closest sign
const LOAD_QUIET_MS = 250;

function attachLoading(node, { run, marked }) {
  const bar = document.createElement('div');
  bar.className = 'pane-loading';
  bar.innerHTML = '<span></span>';
  const ld = { bar, done: false, timers: [] };
  node.loading = ld;

  const finish = () => {
    if (ld.done) return;
    ld.done = true;
    ld.timers.forEach(clearTimeout);
    if (!bar.isConnected) return;
    bar.classList.remove('on');
    bar.addEventListener('transitionend', () => bar.remove(), { once: true });
    setTimeout(() => bar.remove(), 600); // no transition (hidden tab, reduced motion)
  };
  ld.finish = finish;

  ld.timers.push(
    setTimeout(() => {
      if (ld.done) return;
      node.el.appendChild(bar);
      // next frame, so it fades in rather than appears
      requestAnimationFrame(() => !ld.done && bar.classList.add('on'));
    }, LOAD_SHOW_AFTER),
    setTimeout(finish, LOAD_CAP_MS)
  );

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
