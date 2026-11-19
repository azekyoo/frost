// Loading: a new pane is empty until its shell has started, and a slow profile
// makes that a long, blank moment that reads as Frost hanging. Until there is
// something to type into — the shell's first prompt, or, for a pane opened to
// run claude, the moment claude's own prompt takes keys — a light runs around
// the pane's border. A quick start shows nothing at all.

const LOAD_SHOW_AFTER = 150; // ms: a shell up before this never flickers a sweep
const LOAD_CAP_MS = 20000; // whatever happened, the sweep doesn't run forever
// a shell without Frost's prompt hook can't say it's ready: its first output,
// once it has gone quiet for a moment, is the closest sign
const LOAD_QUIET_MS = 250;

function attachLoading(node, { run, marked }) {
  const bar = document.createElement('div');
  bar.className = 'pane-loading';
  bar.innerHTML = '<div class="load-trace"></div>';
  const ld = { bar, done: false, timers: [] };
  node.loading = ld;

  const finish = () => {
    if (ld.done) return;
    ld.done = true;
    ld.timers.forEach(clearTimeout);
    // A tab in the background has its panes taken out of the page, so a shell
    // that comes up there has nothing on screen to fade: the light goes now,
    // or it is still sweeping when the tab is next shown, and for good.
    if (!bar.isConnected) {
      bar.remove();
      return;
    }
    bar.classList.remove('on');
    bar.addEventListener('transitionend', (ev) => ev.target === bar && bar.remove());
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
  // Any other command is typed at the shell's first prompt and the shell is
  // ready then, as for a plain pane: only claude has a prompt of its own to
  // wait for.
  if (run && !/^\s*claude(\.exe|\.cmd)?(\s|$)/i.test(run)) run = null;
  if (run) {
    // claude switches on focus reporting once its prompt is up. ConPTY does
    // too, as the shell starts — so only one after the shell's first prompt,
    // when the command has been typed, is claude's (the order main's type-ahead
    // goes by). A shell without the hook never says when that is: the same
    // guess main makes for it.
    const started = Date.now();
    let prompted = false;
    if (marked) {
      node.term.parser.registerOscHandler(133, (data) => {
        if (String(data).startsWith('A')) prompted = true;
        return false;
      });
    }
    node.term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      const typed = marked ? prompted : Date.now() - started > 1500;
      if (typed && params.includes(1004)) finish();
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
