// What the desktop shows on each monitor, for the 'glass' material. Windows
// keeps that behind IDesktopWallpaper, a COM interface Node cannot call, so a
// short PowerShell script compiles a binding to it and prints JSON. It costs a
// second or two per call, which is why main paints the single-image guess first
// and only lets this correct it.

const { screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SCRIPT = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
namespace FrostWallpaper {
  [StructLayout(LayoutKind.Sequential)]
  public struct Rect { public int Left, Top, Right, Bottom; }

  [ComImport, Guid("B92B56A9-8B55-4E14-9A89-0199BBB6F93B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IDesktopWallpaper {
    void SetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID, [MarshalAs(UnmanagedType.LPWStr)] string wallpaper);
    [return: MarshalAs(UnmanagedType.LPWStr)] string GetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID);
    [return: MarshalAs(UnmanagedType.LPWStr)] string GetMonitorDevicePathAt(uint monitorIndex);
    uint GetMonitorDevicePathCount();
    Rect GetMonitorRECT([MarshalAs(UnmanagedType.LPWStr)] string monitorID);
    void SetBackgroundColor(uint color);
    uint GetBackgroundColor();
    void SetPosition(int position);
    int GetPosition();
  }

  [ComImport, Guid("C2CF3110-460E-4fc1-B9D0-8A1C0C9CC4BD")]
  public class DesktopWallpaper {}

  public static class Query {
    static string Str(string s) {
      return "\\"" + (s ?? "").Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"") + "\\"";
    }
    public static string Run() {
      var w = (IDesktopWallpaper)new DesktopWallpaper();
      var sb = new StringBuilder();
      sb.Append("{\\"position\\":").Append(w.GetPosition());
      sb.Append(",\\"color\\":").Append(w.GetBackgroundColor());
      sb.Append(",\\"monitors\\":[");
      uint n = w.GetMonitorDevicePathCount();
      bool first = true;
      for (uint i = 0; i < n; i++) {
        string id = w.GetMonitorDevicePathAt(i);
        Rect r;
        // monitors Windows remembers but is not driving have no rectangle
        try { r = w.GetMonitorRECT(id); } catch { continue; }
        if (r.Right <= r.Left) continue;
        string p = "";
        try { p = w.GetWallpaper(id); } catch {}
        if (!first) sb.Append(",");
        first = false;
        sb.Append("{\\"index\\":").Append(i);
        sb.Append(",\\"path\\":").Append(Str(p));
        sb.Append(",\\"x\\":").Append(r.Left).Append(",\\"y\\":").Append(r.Top);
        sb.Append(",\\"width\\":").Append(r.Right - r.Left).Append(",\\"height\\":").Append(r.Bottom - r.Top);
        sb.Append("}");
      }
      return sb.Append("]}").ToString();
    }
  }
}
'@
[FrostWallpaper.Query]::Run()
`;

// DESKTOP_WALLPAPER_POSITION. Center and tile are drawn as fill: both need the
// image at its native pixel size, and for a photo the size of a screen, fill is
// what they look like anyway.
const POSITIONS = { 2: 'stretch', 3: 'fit', 5: 'span' };

// { mode, color, monitors: [{ index, path, x, y, width, height }] } with the
// rectangles in physical screen pixels, or null when Windows would not say.
function queryDesktopWallpaper() {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(SCRIPT, 'utf16le').toString('base64')
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 },
      (err, out) => {
        if (err) return resolve(null);
        try {
          const r = JSON.parse(out.trim());
          const c = r.color >>> 0; // COLORREF: 0x00BBGGRR
          resolve({
            mode: POSITIONS[r.position] || 'fill',
            color: `rgb(${c & 0xff}, ${(c >> 8) & 0xff}, ${(c >> 16) & 0xff})`,
            monitors: r.monitors
          });
        } catch {
          resolve(null);
        }
      }
    );
  });
}

// Wallpaper for the 'glass' material — the app blurs it itself, DWM stays out.
// Windows keeps its own copy of whatever the desktop shows. The paths it reports
// can lag behind that copy: a slideshow or Spotlight changes the picture without
// rewriting them, and the original may since have been moved or deleted (both
// the registry and IDesktopWallpaper were seen naming a picture the desktop had
// stopped showing). The copy is re-encoded, which costs nothing once blurred.
const THEMES_DIR = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Themes');
const TRANSCODED_WALLPAPER = path.join(THEMES_DIR, 'TranscodedWallpaper');
// with a different picture per monitor, Windows keeps a copy per monitor too
const transcodedFor = (index) => path.join(THEMES_DIR, `Transcoded_${String(index).padStart(3, '0')}`);

function registryWallpaper() {
  return new Promise((resolve) =>
    execFile(
      'reg',
      ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'WallPaper'],
      { encoding: 'utf8', windowsHide: true },
      (_err, out) => {
        const m = /WallPaper\s+REG_SZ\s+(.+)/.exec(out || '');
        resolve(m ? m[1].trim() : '');
      }
    )
  );
}

const fileExists = (f) =>
  fs.promises.access(f).then(
    () => true,
    () => false
  );

// Windows measures monitors in physical pixels, Electron in DIPs. Snapping the
// converted rectangle to the display it lands on keeps rounding at mixed scale
// factors from opening a seam between two monitors' tiles.
function dipDisplayRect(r) {
  const dip = screen.screenToDipRect(null, r);
  let best = null;
  let bestArea = 0;
  for (const { bounds: b } of screen.getAllDisplays()) {
    const w = Math.min(b.x + b.width, dip.x + dip.width) - Math.max(b.x, dip.x);
    const h = Math.min(b.y + b.height, dip.y + dip.height) - Math.max(b.y, dip.y);
    if (w > 0 && h > 0 && w * h > bestArea) {
      best = b;
      bestArea = w * h;
    }
  }
  return best || dip;
}

function unionRect(rects) {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

// One tile per monitor of `displays`: where it is, the picture it shows (null for a solid
// colour) and how Windows fits that picture. `quick` skips asking Windows, for a
// first paint that must not wait on PowerShell: one picture on every display,
// filled, which is right for most desktops.
async function desktopWallpaperTiles(displays, quick) {
  const single = (await fileExists(TRANSCODED_WALLPAPER)) ? TRANSCODED_WALLPAPER : null;
  const desk = quick ? null : await queryDesktopWallpaper();
  if (!desk?.monitors?.length) {
    const reg = await registryWallpaper();
    const file = reg ? single || reg : null; // no path: a solid colour
    return { mode: 'fill', color: null, tiles: file ? displays.map((rect) => ({ rect, file })) : [] };
  }
  const { mode, color, monitors } = desk;
  if (mode === 'span') {
    return { mode, color, tiles: [{ rect: unionRect(displays), file: single || monitors[0].path || null }] };
  }
  const perMonitor = new Set(monitors.map((m) => m.path.toLowerCase())).size > 1;
  const tiles = [];
  for (const m of monitors) {
    let file = null;
    if (m.path) {
      if (perMonitor && (await fileExists(transcodedFor(m.index)))) file = transcodedFor(m.index);
      else if (!perMonitor && single) file = single;
      else if (await fileExists(m.path)) file = m.path;
    }
    tiles.push({ rect: dipDisplayRect(m), file });
  }
  return { mode, color, tiles };
}

// Windows sends no WM_SETTINGCHANGE when Settings changes the picture, but it
// always rewrites its copies, so watching those files catches every change.
function watchWallpaperFiles(onChange) {
  return fs.watch(THEMES_DIR, (_ev, name) => {
    if (!name || /^Transcoded(Wallpaper|_\d+)$/.test(name)) onChange();
  });
}

Object.assign(module.exports, {
  THEMES_DIR,
  TRANSCODED_WALLPAPER,
  transcodedFor,
  registryWallpaper,
  queryDesktopWallpaper,
  desktopWallpaperTiles,
  watchWallpaperFiles
});
