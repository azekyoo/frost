const { nativeImage, nativeTheme } = require('electron');

const { ICON_FILE, TITLEBAR_H } = require('../../env');
const { liveWindows } = require('./registry');

// The native minimise/maximise/close glyphs. Candy Swirl's titlebar is bright
// liquid, where the terminal's light foreground would vanish over yellow, so
// there they are dark ink like the rest of its titlebar.
function captionInk(theme) {
  return theme.design === 'candy' ? '#1a1726' : theme.terminal?.foreground || '#ffffff';
}

function appIcon() {
  try {
    const image = nativeImage.createFromPath(ICON_FILE);
    return image.isEmpty() ? undefined : image;
  } catch {
    return undefined;
  }
}

function applyWindowTheme(theme) {
  if (!theme) return;
  // The acrylic/mica base layer follows the app's color mode:
  // light mode = whitish frost, dark mode = dark smoke.
  nativeTheme.themeSource = theme.colorMode || 'dark';
  const material = theme.material || 'acrylic';
  for (const w of liveWindows()) {
    // A frameless window is the glass one and paints its own backdrop; 'glass'
    // is not a DWM material, so there is nothing to hand Windows either way.
    if (w.isFramelessMode || material === 'glass') continue;
    try {
      w.setBackgroundMaterial(material === 'acrylic-always' ? 'acrylic' : material);
    } catch {}
    try {
      w.setTitleBarOverlay({
        color: '#00000000',
        symbolColor: captionInk(theme),
        // must track the zoom, or changing any theme setting shrinks the native
        // buttons back to their unzoomed height while the titlebar stays tall
        height: Math.round(TITLEBAR_H * (w.webContents.getZoomFactor() || 1))
      });
    } catch {}
  }
}

Object.assign(module.exports, {
  captionInk,
  appIcon,
  applyWindowTheme
});
