'use strict';

// Frost Flow: the liquid in the gaps.
//
// Frost's blocks are see-through glass, so a layer of colour behind them would
// show through every pane. Instead the liquid (#design-fx, drawn by
// designs/flow.css) carries a mask: the whole window with every block's
// rounded shape cut out of it, leaving the titlebar, the margin and the gaps.
// The mask is an SVG redrawn whenever a block moves or resizes, and only while
// the Flow design is picked.
//
// The liquid itself is drawn by flow-liquid.js in a worker, on a small canvas
// the compositor scales up; the CSS version in flow.css is the fallback for a
// window that can't run one. The worker also sends back the liquid's colour,
// which becomes the accent, so everything Frost lights in its accent flows
// through the same colours as the liquid.

(() => {
  const BLOCKS = '.pane, .agents-rail, .agents-diff, .agents-dock, .agents-center';
  const fx = document.getElementById('design-fx');
  const content = document.getElementById('content');
  if (!fx || !content) return;

  let on = false;
  let frame = 0;
  let lastMask = '';
  const watched = new Set();

  const resizes = new ResizeObserver(schedule);

  // Tabs switching, panes splitting or closing, zoom, the dock sliding: any of
  // them changes which blocks are where, and all of them happen on the layout
  // elements themselves. What changes inside a block (terminals printing, the
  // rail's times ticking, the diff refreshing) never moves one, so it's ignored.
  const LAYOUT = '#content, .tab-content, .split, .divider, .pane, .agents-layout, .agents-side, ' +
    '.agents-center, .agents-rail, .agents-diff, .agents-dock, .agents-gutter, .agents-dock-gutter, .dock-inner';
  const mutations = new MutationObserver((records) => {
    if (records.some((r) => r.target.matches?.(LAYOUT))) schedule();
  });

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
    schedule();
  }

  function schedule() {
    if (!on || frame) return;
    frame = requestAnimationFrame(update);
  }

  function rounded(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}` +
      `A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}` +
      `V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
  }

  function radius() {
    return parseFloat(getComputedStyle(document.body).getPropertyValue('--radius')) || 8;
  }

  function update() {
    frame = 0;
    if (!on) return;
    const W = window.innerWidth;
    const H = window.innerHeight;
    // The whole window, titlebar and edges included: the tabs sit right on the
    // liquid, and the lit one is a pane of glass over it (flow.css).
    let d = `M0 0H${W}V${H}H0Z`;

    const blocks = content.querySelectorAll(BLOCKS);
    const seen = new Set();
    for (const el of blocks) {
      seen.add(el);
      if (!watched.has(el)) {
        watched.add(el);
        resizes.observe(el);
      }
      const b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) continue; // a tab in the background
      // The session centre is only a box round its pane, which is rounded: cut
      // the pane, or the box's square corners leave glass in the liquid. Empty,
      // it stands in for the pane to come, at the pane's radius.
      const center = el.classList.contains('agents-center');
      if (center && el.querySelector('.pane')) continue;
      // the dock clips its shell to its own shape, so the dock is the cut
      if (el.parentElement?.closest('.agents-dock')) continue;
      const r = center ? radius() : parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
      d += rounded(b.left, b.top, b.width, b.height, r);
    }
    for (const el of watched) {
      if (!seen.has(el)) {
        watched.delete(el);
        resizes.unobserve(el);
      }
    }

    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}' viewBox='0 0 ${W} ${H}' preserveAspectRatio='none'>` +
      `<path fill-rule='evenodd' fill='#000' d='${d}'/></svg>`;
    const mask = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
    if (mask === lastMask) return;
    lastMask = mask;
    fx.style.maskImage = mask;
    fx.dataset.masked = '';
  }

  function start() {
    on = true;
    if (!startLiquid()) addBlobs();
    resizes.observe(content);
    mutations.observe(content, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'hidden', 'style'],
    });
    window.addEventListener('resize', onResize);
    reduced.addEventListener('change', syncPlay);
    schedule();
  }

  function stop() {
    on = false;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    mutations.disconnect();
    resizes.disconnect();
    watched.clear();
    window.removeEventListener('resize', onResize);
    reduced.removeEventListener('change', syncPlay);
    stopLiquid(false);
    for (const blob of fx.querySelectorAll('.fl-blob')) blob.remove();
    fx.style.maskImage = '';
    delete fx.dataset.masked;
    lastMask = '';
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
