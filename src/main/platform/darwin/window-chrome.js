// How a Frost window is framed on macOS. There are no DWM materials: the
// closest thing is vibrancy, the blurred backdrop Finder's sidebar uses. The
// window buttons are the traffic lights at the top left, kept vertically
// centred in Frost's own titlebar.
const { TITLEBAR_H } = require('../../env');

// macOS draws the traffic lights about 14px tall, 20px apart.
const LIGHTS_H = 14;
const LIGHTS_X = 14;
const lightsAt = (h) => ({ x: LIGHTS_X, y: Math.round((h - LIGHTS_H) / 2) });

function frameOptions(opts, { glass, material, theme }) {
  // Every material keeps the native traffic lights over Frost's own titlebar.
  opts.titleBarStyle = 'hidden';
  opts.trafficLightPosition = lightsAt(TITLEBAR_H);
  if (glass) {
    // Solid: the renderer paints the blurred wallpaper itself, as on Windows.
    opts.backgroundColor = theme.terminal?.background || '#101014';
    return;
  }
  if (material === 'none') {
    opts.backgroundColor = theme.terminal?.background || '#101014';
  } else {
    // every other material maps to vibrancy; 'active' keeps it blurred while
    // the window is in the background, so acrylic and acrylic-always match
    opts.vibrancy = 'under-window';
    opts.visualEffectState = 'active';
  }
}

function setMaterial(w, material) {
  w.setVibrancy(material === 'none' ? null : 'under-window');
}

// Called with the titlebar's zoomed height: move the traffic lights with it.
// The colours Windows needs for its buttons mean nothing here.
function setCaptionButtons(w, overlay) {
  if (overlay?.height) w.setWindowButtonPosition(lightsAt(overlay.height));
}

// Vibrancy doesn't dim when the window loses focus (visualEffectState above).
function refreshMaterialOnBlur() {}

Object.assign(module.exports, {
  frameOptions,
  setMaterial,
  setCaptionButtons,
  refreshMaterialOnBlur
});
