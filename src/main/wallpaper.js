// What the desktop shows on each monitor, for the 'glass' material. Windows
// keeps that behind IDesktopWallpaper, a COM interface Node cannot call, so a
// short PowerShell script compiles a binding to it and prints JSON. It costs a
// second or two per call, which is why main paints the single-image guess first
// and only lets this correct it.

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

module.exports = { queryDesktopWallpaper };
