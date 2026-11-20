// How a Frost window is framed on Windows. Two kinds, fixed when the window is
// created: 'glass', a frameless solid window that paints its own blurred
// wallpaper and buttons, and the DWM materials (acrylic, mica, tabbed, none),
// where Windows draws the backdrop and the minimise/maximise/close buttons as
// an overlay on Frost's own titlebar.
const { TITLEBAR_H } = require('../../env');

// The BrowserWindow constructor options for the frame and backdrop.
function frameOptions(opts, { glass, material, alwaysOn, theme, symbolColor }) {
  if (glass) {
    // Frameless but solid: the renderer paints its own blurred wallpaper and
    // window buttons, and that wallpaper is opaque, so the window never needed
    // to be transparent — the only thing transparency bought was a corner
    // radius we could pick ourselves. It cost far more than that. A transparent
    // window is layered, gets no WS_THICKFRAME, and Windows therefore refuses
    // it Aero Snap, snap layouts, a sizing border, a drop shadow and the
    // minimise animation. Solid buys all of that back, and DWM rounds the
    // corners itself.
    opts.transparent = false;
    opts.frame = false;
    opts.roundedCorners = true;
    opts.backgroundColor = theme.terminal?.background || '#101014';
  } else {
    opts.backgroundMaterial = alwaysOn ? 'acrylic' : material;
    opts.titleBarStyle = 'hidden';
    opts.titleBarOverlay = {
      color: '#00000000',
      symbolColor,
      height: TITLEBAR_H
    };
  }
}

// Swap the DWM backdrop of an open window; 'acrylic-always' is acrylic that
// refreshMaterialOnBlur keeps lit.
function setMaterial(w, material) {
  w.setBackgroundMaterial(material === 'acrylic-always' ? 'acrylic' : material);
}

// Recolour or resize the native caption buttons. They are drawn by Windows, so
// they only follow the zoomed titlebar the renderer draws if told to.
function setCaptionButtons(w, overlay) {
  w.setTitleBarOverlay(overlay);
}

// Windows dims/disables the acrylic backdrop when the window deactivates.
// Re-applying the material right after blur makes DWM repaint it in its
// active look — keeps the blur constant when unfocused.
function refreshMaterialOnBlur(w) {
  w.setBackgroundMaterial('none');
  w.setBackgroundMaterial('acrylic');
}

Object.assign(module.exports, {
  frameOptions,
  setMaterial,
  setCaptionButtons,
  refreshMaterialOnBlur
});
