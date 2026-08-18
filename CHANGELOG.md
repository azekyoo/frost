# Changelog

Notable changes per release. Dates are release dates; versions follow
[semver](https://semver.org), where 0.x minor bumps are free to change defaults.

## 0.4.0 — 2026-08-17

The release about being readable on a screen other than the one Frost was
written on. Three defaults changed: the renderer, the palette, and the size a
window opens at. Existing `config/theme.json` files keep their own values —
delete a key to pick up the new default.

### Added

- **Whole-UI zoom, remembered per monitor.** `Ctrl+=` / `Ctrl+-` / `Ctrl+0` now
  scale tabs, rails, panels and terminal together, not just the terminal font.
  The chosen zoom is stored against the display's resolution and scale factor
  (`config/zoom.json`), so dragging a window between screens picks up each
  screen's own setting. Zoom steps are derived from the display's scale factor
  so every step lands on a whole or half device pixel ratio, which is also the
  ratio at which glyphs rasterise cleanly.
- **Line height in settings.** It decides whether block and box-drawing art
  joins up, and was previously only editable by hand in `theme.json`.
- **Smooth scrolling**, three rows per wheel notch and ten with Shift held.
  Configurable through `theme.json`'s `scroll` key; `smoothMs: 0` restores the
  old row-at-a-time jump.

### Changed

- **The diff viewer in agent mode was rebuilt.** The patch is parsed rather than
  colored as text, which gets you: line numbers on both sides, added / deleted /
  renamed / binary files labelled and counted, word-level highlighting of the
  run that actually changed within a line, sticky file headers, and folds and
  scroll position that survive the re-render the watcher fires on every save.
  Clicking a line number opens that file at that line. Files over 600 lines stop
  there with a button for the rest.
- **The GPU renderer is off by default.** Every pane is transparent, so its
  texture atlas blends grayscale antialiasing against an unknown backdrop; the
  DOM renderer hands text to the browser and gets it hinted and gamma-corrected
  the way the rest of Windows is. Still one tick away in settings for anyone
  pushing enough output to want it. Note that xterm only synthesises box-drawing
  glyphs in the GPU path — at line height 1.0 the font's own glyphs join up.
- **New default palette.** Campbell assumes an opaque black background, and its
  red, blue and magenta are unreadable through a window showing the wallpaper.
  The replacement is saturated and bright enough not to need help, so
  auto-contrast (`minContrast`) now defaults to off instead of 4.5 — which had
  been quietly dragging error text to pastel pink.
- **Window geometry is remembered per display**, carrying the work area it was
  measured against, and is re-proportioned rather than restored verbatim onto a
  screen of a different size. A first window takes a share of the display it
  opens on instead of a fixed 1100×700.
- **Bigger tabs**: 150px minimum width and 34px tall, in a 44px titlebar. A tab
  is a click target before it is a label.

### Fixed

- Windows no longer shrink by a quarter on every restart. Bounds given to the
  `BrowserWindow` constructor are resolved against the primary display's scale
  factor rather than that of the screen the window opens on, so a 1600px window
  restored onto a 150% monitor from a 200% primary came back at 1152px, then
  864, then 648.
- The glyph atlas is dropped and redrawn when the device pixel ratio changes —
  on zoom, or on crossing to a monitor with another scale factor. Nothing was
  watching for it, so glyphs were being sampled at a size they were never drawn
  for.
- The glass wallpaper stays aligned with the desktop when the page is zoomed.
- A run from source sets its own AppUserModelId, so the taskbar shows Frost's
  icon rather than Electron's. Packaged builds still set none, deliberately.
- Changing any theme setting no longer resets the native window buttons to the
  wrong height.

## 0.3.3 — 2026-08-07

- Stopped setting an AppUserModelId: it made Windows resolve the taskbar
  button's icon through the id instead of from the window, which showed the
  Electron logo on an installed build. The icon also ships as a real file beside
  the exe now.

## 0.3.2 — 2026-08-07

- Every window is restored on launch, not just the first.
- A resumed session no longer opens twice.
- Worktree rows have room, and the space row buttons line up.

## 0.3.1 — 2026-08-07

- Glass text stays readable over any wallpaper: a readability scrim across the
  whole window, kept separate from the user's tint.
- Frost asks about restarting in its own dialog whenever the chosen backdrop
  cannot apply, instead of half-applying it.
- The tab strip scrolls rather than squeezing tabs into slivers, and the close
  button is pinned to the tab edge.

## 0.3.0 — 2026-08-07

- Agent mode gained worktrees: they are listed in the rail, and can be merged or
  discarded from there.
- Several windows are supported.
- Commands are marked with where they ran and how they ended.
- Notifications when an agent needs you, or a long command finishes.
- The agent rail and diff panel can be resized.

## 0.2.0 — 2026-08-06

- Ctrl+click opens file paths in your editor and URLs in your browser.
- README screenshots are rendered from the real app.

## 0.1.0 — 2026-08-06

First release. Acrylic terminal for Windows with agent mode: shell profiles
(pwsh, cmd, Git Bash, WSL), tabs and split panes, command palette and remappable
keybindings, buffer search, Windows Terminal clipboard behavior, restored window
geometry and tab layout, packaged as an installer and a portable exe.
