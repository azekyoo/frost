// ---------- window stalls ----------
// The main process's stall log can't see the window: a frame held up here
// (typing effects lagging, the whole window turning sluggish) left no trace.
// Chromium reports every animation frame that ran long, with the scripts that
// ran in it; one over WINDOW_SLOW_MS goes to the same stalls.log, with what the
// window held at the time, so the next slow spell names its cause.

const WINDOW_SLOW_MS = 200;
// a slow spell is many long frames in a row: one line every few seconds says
// it as well as fifty, and the count of the rest is kept
const WINDOW_STALL_GAP_MS = 3000;
let windowStallAt = 0;
let windowStallsSkipped = 0;

// "file:///C:/…/src/renderer/panes/glow.js" -> "panes/glow.js"
const stallSource = (url) => String(url || '').replace(/^.*\/(?:src\/renderer|node_modules)\//, '').slice(0, 80);

function windowStallLine(e) {
  const scripts = [...(e.scripts || [])]
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 3)
    .map((s) => {
      const where = stallSource(s.sourceURL) + (s.sourceFunctionName ? ' ' + s.sourceFunctionName : '');
      return `${s.invoker || s.invokerType || '?'} ${Math.round(s.duration)}ms${where.trim() ? ' (' + where.trim() + ')' : ''}`;
    });
  const panes = allPanes();
  const heap = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) + 'MB' : '?';
  const held = [
    `tabs ${state.tabs.length}`,
    `panes ${panes.length}`,
    `gpu ${panes.filter((n) => n.webgl).length}`,
    `effects ${state.theme?.typingGlow === true ? 'on' : 'off'}`,
    `heap ${heap}`
  ].join(', ');
  const skipped = windowStallsSkipped ? ` (+${windowStallsSkipped} more since the last)` : '';
  return (
    `window slow ${Math.round(e.duration)}ms, blocking ${Math.round(e.blockingDuration || 0)}ms${skipped}: ` +
    (scripts.join('; ') || 'no script (layout, paint or GPU)') +
    ` | ${held}`
  );
}

try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      // a hidden window isn't drawn, and nothing in it is waited on
      if (e.duration < WINDOW_SLOW_MS || document.visibilityState === 'hidden') continue;
      const now = Date.now();
      if (now - windowStallAt < WINDOW_STALL_GAP_MS) {
        windowStallsSkipped++;
        continue;
      }
      api.logStall(windowStallLine(e));
      windowStallAt = now;
      windowStallsSkipped = 0;
    }
  }).observe({ type: 'long-animation-frame' });
} catch {}
