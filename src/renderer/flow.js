'use strict';

// Frost Flow: glass over liquid.
//
// The liquid (#design-fx) fills the whole window, and every block (panes,
// the agent rail, the diff, the shell dock) is a sheet of tinted glass laid
// over it by designs/flow.css. This file only runs the liquid: drawn by
// flow-liquid.js in a worker, on a small canvas the compositor scales up, with
// the CSS version in flow.css as the fallback for a window that can't run one.
// The worker also sends back the liquid's colour, which becomes the accent, so
// everything Frost lights in its accent flows through the same colours.

(() => {
  const fx = document.getElementById('design-fx');
  if (!fx) return;

  let on = false;

  // ---- the liquid's clock and worker ----
  // The clock runs only while the liquid plays, so a pause picks up where it
  // stopped, as a paused CSS animation does.
  let worker = null;
  let canvas = null;
  let played = 0;
  let since = null;
  const absNow = () => performance.timeOrigin + performance.now();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  function startLiquid() {
    if (worker) return true;
    try {
      canvas = document.createElement('canvas');
      canvas.className = 'fl-canvas';
      const off = canvas.transferControlToOffscreen();
      worker = new Worker('flow-liquid.js');
      worker.onmessage = ({ data }) => {
        if (on && data.accent) document.body.style.setProperty('--fl-live', data.accent);
      };
      worker.onerror = () => stopLiquid(true);
      fx.appendChild(canvas);
      worker.postMessage({ canvas: off, size: [innerWidth, innerHeight] }, [off]);
      fx.dataset.canvas = '';
      played = 0;
      since = null;
      syncPlay();
      return true;
    } catch {
      stopLiquid(true);
      return false;
    }
  }

  // failed: fall back to the CSS liquid
  function stopLiquid(fallback) {
    worker?.terminate();
    worker = null;
    canvas?.remove();
    canvas = null;
    delete fx.dataset.canvas;
    document.body.style.removeProperty('--fl-live');
    if (fallback && on) addBlobs();
  }

  function syncPlay() {
    if (!worker) return;
    const want = on && document.body.classList.contains('win-focused') && !reduced.matches;
    if (reduced.matches) {
      played = 0;
      since = null;
      worker.postMessage({ pause: true, at: 0 });
    } else if (want && since === null) {
      since = absNow();
      worker.postMessage({ play: true, at: played, wall: since });
    } else if (!want && since !== null) {
      played += absNow() - since;
      since = null;
      worker.postMessage({ pause: true, at: played });
    }
  }

  function addBlobs() {
    if (fx.querySelector('.fl-blob')) return;
    for (let i = 0; i < 6; i++) {
      const blob = document.createElement('div');
      blob.className = 'fl-blob';
      fx.appendChild(blob);
    }
  }

  function onResize() {
    worker?.postMessage({ size: [innerWidth, innerHeight] });
  }

  function start() {
    on = true;
    if (!startLiquid()) addBlobs();
    window.addEventListener('resize', onResize);
    reduced.addEventListener('change', syncPlay);
  }

  function stop() {
    on = false;
    window.removeEventListener('resize', onResize);
    reduced.removeEventListener('change', syncPlay);
    stopLiquid(false);
    for (const blob of fx.querySelectorAll('.fl-blob')) blob.remove();
  }

  function sync() {
    const want = document.body.dataset.design === 'flow';
    if (want && !on) start();
    else if (!want && on) stop();
  }

  // the design switching, and the window gaining or losing focus
  new MutationObserver(() => {
    sync();
    syncPlay();
  }).observe(document.body, { attributes: true, attributeFilter: ['data-design', 'class'] });
  sync();
})();
