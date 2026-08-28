// The browser's own tooltip is an OS widget: white box, system font, its own
// idea of where the corner goes. Next to the palette and the settings sheet it
// reads as another program's UI, so every `title` in the window is taken over
// here and drawn as one of ours instead.

const TIP_DELAY = 420;
const TIP_GAP = 8;

const tipState = { node: null, target: null, timer: null, watch: null };

function tipNode() {
  if (tipState.node) return tipState.node;
  const node = document.createElement('div');
  node.id = 'tooltip';
  document.body.appendChild(node);
  tipState.node = node;
  return node;
}

// The attribute is removed, not just read: leaving it in place means the OS
// tooltip still appears a second later, on top of ours.
function claimTitle(node) {
  const title = node.getAttribute('title');
  if (title === null) return node.frostTip || '';
  node.removeAttribute('title');
  node.frostTip = title;
  return title;
}

function hideTip() {
  clearTimeout(tipState.timer);
  clearInterval(tipState.watch);
  tipState.timer = null;
  tipState.watch = null;
  tipState.target = null;
  tipState.node?.classList.remove('show');
}

function placeTip(target) {
  const node = tipState.node;
  const r = target.getBoundingClientRect();
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  let x = r.left + r.width / 2 - w / 2;
  let y = r.bottom + TIP_GAP;
  // flip above when the element sits near the bottom edge
  if (y + h > window.innerHeight - 4) y = r.top - h - TIP_GAP;
  x = Math.max(6, Math.min(x, window.innerWidth - w - 6));
  y = Math.max(6, y);
  node.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

function showTip(target, text) {
  const node = tipNode();
  node.className = target.dataset.tipMono !== undefined ? 'mono' : '';
  const [first, ...rest] = text.split('\n');
  node.replaceChildren(
    Object.assign(document.createElement('div'), { className: 'tip-main', textContent: first }),
    ...rest.map((line) =>
      Object.assign(document.createElement('div'), { className: 'tip-sub', textContent: line })
    )
  );
  placeTip(target);
  node.classList.add('show');
  // The tab strip re-renders under the pointer often enough that a tooltip can
  // outlive the thing it describes; nothing fires a mouseout in that case.
  tipState.watch = setInterval(() => {
    if (!target.isConnected || !target.matches(':hover')) hideTip();
  }, 250);
}

document.addEventListener('mouseover', (ev) => {
  const target = ev.target instanceof Element ? ev.target.closest('[title], [data-has-tip]') : null;
  if (!target) {
    if (tipState.target) hideTip();
    return;
  }
  if (target === tipState.target) return;
  const text = claimTitle(target).trim();
  if (!text) return;
  target.dataset.hasTip = ''; // so the element is still found once title is gone
  hideTip();
  tipState.target = target;
  tipState.timer = setTimeout(() => showTip(target, text), TIP_DELAY);
});

for (const ev of ['mousedown', 'wheel', 'keydown']) {
  document.addEventListener(ev, hideTip, { capture: true, passive: true });
}
window.addEventListener('blur', hideTip);
