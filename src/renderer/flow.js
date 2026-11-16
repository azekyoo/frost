'use strict';

// Frost Flow: the liquid in the gaps.
//
// Frost's blocks are see-through glass, so a layer of colour behind them would
// show through every pane. Instead the liquid (#design-fx, drawn by
// designs/flow.css) carries a mask: the content area with every block's
// rounded shape cut out of it, leaving only the margin and the gaps between.
// The mask is an SVG redrawn whenever a block moves or resizes, and only while
// the Flow design is picked.

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
  // them changes which blocks are where. The terminals themselves churn their
  // own DOM constantly and never move a block, so their changes are ignored.
  const mutations = new MutationObserver((records) => {
    if (records.every((r) => r.target.closest?.('.xterm'))) return;
    schedule();
  });

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
    const c = content.getBoundingClientRect();
    let d = `M${c.left} ${c.top}H${c.right}V${c.bottom}H${c.left}Z`;

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
    if (!fx.querySelector('.fl-blob')) {
      for (let i = 0; i < 6; i++) {
        const blob = document.createElement('div');
        blob.className = 'fl-blob';
        fx.appendChild(blob);
      }
    }
    resizes.observe(content);
    mutations.observe(content, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'hidden', 'style'],
    });
    window.addEventListener('resize', schedule);
    schedule();
  }

  function stop() {
    on = false;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    mutations.disconnect();
    resizes.disconnect();
    watched.clear();
    window.removeEventListener('resize', schedule);
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

  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['data-design'] });
  sync();
})();
