# Changelog

Notable changes per release. Dates are release dates; versions follow
[semver](https://semver.org), where 0.x minor bumps are free to change defaults.

## 0.4.4 — 2026-08-20

### Changed

- **Terminal text is bigger, whiter and thinner by default.** Three defaults,
  one cause. A transparent window is composited, and Chromium antialiases text
  in a composited layer in grayscale rather than with ClearType — so glass never
  renders text the way an opaque terminal does, and defaults tuned against one
  look wrong in the other. Size goes to 16px from 14: Windows Terminal counts in
  points and defaults to 12pt, which *is* 16px, so a terminal claiming 14 was
  simply smaller than the one it gets compared against. The foreground goes to
  white from `#e4ebff` — at 92% brightness with a blue cast it read as grey next
  to an opaque terminal's white. And weight goes to 350, *below* normal: over a
  photograph those soft antialiased edges read as extra mass, so 400 looks fat
  through glass where it looks ordinary on black. Bold is untouched at 700. An
  existing `theme.json` carries explicit values and is unaffected; delete the
  `font` block to take the new defaults.
- **The screenshots sit on real desktops.** The README's wallpapers were
  generated landscapes — a hedge against licensing a photograph in a public
  repo, and they read as what they were. Glass is a claim about how the app sits
  on your desktop, and a photograph makes that claim credible. Five, credited in
  `assets/wallpapers/CREDITS.md`. The generated scenes stay: they need no asset,
  so the renderer still works in a checkout without them.

### Added

- **Font weight and text colour in the settings panel.** Both were reachable
  only by editing `theme.json`, which made them undiscoverable — and they are
  the first two you reach for, because how heavy text looks through glass depends
  on the wallpaper behind it. Tuning that by editing JSON is the wrong loop. The
  weight slider spans 200 to 700, the bounds of Cascadia's variable axis, so it
  cannot ask for a weight the font would have to synthesise. `font.weight` and
  `font.weightBold` work in `theme.json` too.

## 0.4.3 — 2026-08-19

### Fixed

- **Colours in a pane are true colour again.** ConPTY hands a child no `TERM`,
  and node-pty's `name` option is a no-op on Windows, so a program launched in a
  pane found no evidence that the terminal could do more than sixteen colours
  and picked its dullest palette. Claude Code's status bar was the visible
  symptom: its gradient meters collapsed into one flat green. Frost renders
  24-bit colour whatever the environment says, so it now says so —
  `TERM=xterm-256color` and `COLORTERM=truecolor`, set before a profile's `env`,
  which stays yours to override.

### Changed

- **Default row height is 1.15, down from 1.25.** With `customGlyphs` on, xterm
  draws block and box-drawing characters to the whole cell rather than to the
  font's own metrics — that is what makes borders join across rows, and it means
  the row height stretches them. At 1.25 every meter, bar and shaded block stood
  a quarter taller than the digits beside it. 1.15 keeps rows legible and
  borders continuous while block art lands near its drawn height. The fallbacks
  disagreed as well: the default theme and the settings panel said 1.25 where
  the two places that configure the terminal said 1.2, so a `theme.json` with a
  `font` block but no `lineHeight` rendered unlike one with no `font` block at
  all. All four now agree. An existing `theme.json` already carries an explicit
  value and is unaffected; delete the `lineHeight` line to take the new default.

## 0.4.2 — 2026-08-19

### Changed

- **Glass windows snap.** Glass ran a transparent window so the renderer could
  blur the wallpaper itself. A transparent window is layered, never gets
  `WS_THICKFRAME`, and Windows quietly withholds everything that hangs off it:
  Aero Snap, Snap Layouts, the sizing border, the drop shadow, the minimise
  animation. Dragging glass to a screen edge did nothing while every other
  material snapped. The wallpaper Frost paints is opaque, so the window never
  needed to be transparent — the only thing it bought was a corner radius of
  our own choosing. The window is solid now and Windows snaps, rounds and
  shadows it like any other. `windowRadius` is gone with it: the outline is
  DWM's, and a setting that turns nothing is worse than no setting. Windows 10
  has no window rounding to inherit, so glass is square-cornered there, as
  acrylic already was.

### Fixed

- **Shell tabs survive a PowerShell update.** First-run detection wrote the path
  `where.exe` reports first, which for a Store-installed PowerShell points inside
  its versioned package directory. The next auto-update deletes that directory,
  and every shell tab then died with "File not found" — leaving only the agent
  tab, which needs no pty, and no obvious cause. Detection now prefers a path
  that exists, and a spawn whose recorded shell has moved looks it up again
  rather than failing the tab, which repairs configs already written.
- **The close button is clickable again.** The invisible resize gutters were
  stacked above the titlebar, and between the corner square and the top and
  right edges they covered 54% of it — clicks there silently did nothing. The
  caption buttons now sit above the gutters, the priority Windows gives them
  over its own sizing border.
- **No dark ring around the glass.** The window's edge line was a border, and a
  border sits outside the padding box, which is exactly where `overflow: hidden`
  clips the blurred backdrop — so the wallpaper stopped a pixel short and the
  ring showed whatever was behind the page. Against the desktop that was
  invisible; against a solid window it was a black frame. It is an overlay now,
  drawn over the backdrop rather than beside it.

## 0.4.1 — 2026-08-18

### Fixed

- **The window edge can be grabbed again.** Glass mode runs a transparent
  frameless window, and Windows gives those no sizing border worth the name — a
  hairline at the very edge, with none of the padded border it puts outside a
  normal window. Frost now carries its own grab zones: 12px along each edge, 24px
  at the corners, driven from the main process off the cursor's screen position
  so a fast drag that leaves the window keeps resizing. They sit inside the
  terminal's own padding, so no text is covered, and they scale against the UI
  zoom to stay the same physical size at every zoom step and display scale. A
  double-click on the top edge still maximizes. Set `FROST_SHOW_RESIZE=1` to
  tint them while tuning.

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
