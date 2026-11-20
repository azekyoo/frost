// Window and display arithmetic: zoom steps, display keys, re-proportioning
// saved bounds. Pure: no Electron, no files, so it is unit-tested (test/core).

// Zoom steps are derived from the display's scale factor rather than fixed,
// because the terminal renderer rasterises a glyph cell to whole device pixels:
// at an effective ratio of 1.5 the rounding error lands differently in every
// column and the text looks gritty. Every step below multiplies out to a whole
// or half device pixel ratio, so zooming also sharpens rather than blurs.
const ZOOM_DPRS = [1, 1.5, 2, 2.5, 3, 4];
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

function zoomSteps(scaleFactor) {
  const steps = ZOOM_DPRS.map((dpr) => dpr / (scaleFactor || 1)).filter(
    (z) => z >= ZOOM_MIN - 1e-6 && z <= ZOOM_MAX + 1e-6
  );
  // A scale factor outside the table (an odd 1.75, say) could filter down to
  // nothing; 1:1 always has to remain reachable.
  return steps.length ? steps : [1];
}

// Resolution + scale rather than display.id: ids are reassigned when a monitor
// is unplugged and plugged back in, which would forget the setting every time.
function displayKeyOf(d) {
  return `${d.size.width}x${d.size.height}@${d.scaleFactor}`;
}

// A window size is only meaningful next to the screen it was chosen on: two
// thirds of a laptop panel is a third of a 4K one, and restoring the rectangle
// verbatim onto a different monitor produces a window nobody asked for. The
// saved geometry therefore carries the work area it was measured against, and
// is re-proportioned when it comes back to a screen of another size.
function scaleBoundsTo(b, from, to) {
  if (!b || !from || !from.width || !from.height) return null;
  const fw = Math.min(1, b.width / from.width);
  const fh = Math.min(1, b.height / from.height);
  const width = Math.max(480, Math.round(to.width * fw));
  const height = Math.max(300, Math.round(to.height * fh));
  const fx = Math.min(Math.max((b.x - from.x) / from.width, 0), 1);
  const fy = Math.min(Math.max((b.y - from.y) / from.height, 0), 1);
  return {
    width,
    height,
    x: Math.max(to.x, Math.min(Math.round(to.x + fx * to.width), to.x + to.width - width)),
    y: Math.max(to.y, Math.min(Math.round(to.y + fy * to.height), to.y + to.height - height))
  };
}

Object.assign(module.exports, {
  ZOOM_DPRS,
  ZOOM_MIN,
  ZOOM_MAX,
  zoomSteps,
  displayKeyOf,
  scaleBoundsTo
});
