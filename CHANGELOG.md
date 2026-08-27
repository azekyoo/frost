# Changelog

Notable changes per release. Dates are release dates; versions follow
[semver](https://semver.org), where 0.x minor bumps are free to change defaults.

## Unreleased

### Added

- **Pasting several lines asks first.** Text with line breaks in it is typed at
  the shell as if it had been typed by hand, and a line that ends in a newline
  runs on arrival — that is what makes a clipboard copied from a web page, a chat
  window or someone else's terminal worth a second look. Frost now holds a
  multi-line paste and says how many lines it is and what the first one says,
  before any of it reaches the shell. Bracketed paste does not make this
  unnecessary: it is the program's to enable, and a shell that has not — or has
  handed the terminal to something that reads raw input — runs the lines anyway.
  The test for this feature demonstrated exactly that against a real PowerShell.
  `paste.warnMultiline` in `theme.json`, and a checkbox beside copy-on-select.

- **Ligatures, for fonts that have them.** `=>`, `!=`, `->` and the rest are
  drawn as the single glyphs their designers cut, rather than as the characters
  they are typed from. The official xterm addon could not be used: it reads the
  font file off disk to learn which ligatures exist, through font-finder and
  opentype.js, and this renderer has no Node — deliberately, since it draws
  whatever a program cares to print, and that is not a place to hand out file
  access. What that addon does with the knowledge is register a character
  joiner, so the joiner is registered directly against the sequences programming
  fonts ligate; a font without one of them simply draws the characters it always
  did. Joining is only half of it, which is why the first attempt did visibly
  nothing: xterm's DOM renderer puts a sub-pixel letter-spacing correction on
  every span so that n characters measure exactly n cells, and Chromium turns
  ligature substitution off for any text whose letter-spacing is not zero,
  however small. That correction is dropped while ligatures are on — a hundredth
  of a pixel per character, around one across a full row, against a feature that
  is otherwise dead. On by default, because it costs nothing when there is
  nothing to do: the renderer asks the font whether it draws `=>` as one glyph —
  two glyphs shaped together differ pixel for pixel from the same two placed side
  by side — and leaves everything alone when the answer is no. So Cascadia Mono
  renders exactly as it did, and switching to a font that has ligatures shows
  them without a setting to find. Off by default, and honest about why: Frost's own default font is Cascadia
  **Mono**, whose entire difference from Cascadia **Code** is having no
  ligatures, so the setting says which fonts are worth switching to.


- **Scrollback is yours to set.** Every pane kept 10,000 lines and there was no
  way to say otherwise — a long install or a chatty server pushes older output
  out permanently, and what is pushed out is gone rather than hidden: it cannot
  be scrolled to and `Ctrl+F` cannot find it. `scrollback` in `theme.json` and a
  slider in settings now set it, between 1,000 and 200,000 because it is memory
  rather than a preference, and it reaches the panes already open rather than
  waiting for new ones.

- **One command's output, on the clipboard, without selecting it.** Frost has
  known where every command starts and ends since the prompt hooks were added —
  it draws the scrollbar ticks from exactly that — but nothing used it beyond
  jumping. `Ctrl+Shift+O` now copies the output of one command: the lines between
  its prompt and the next one, so the command line itself, the prompt and
  anything that ran afterwards are left out. That is the selection that is most
  tedious to make by hand, because the output is usually taller than the screen
  and dragging past both ends without overshooting is the whole difficulty.
  Wrapped rows come back as the single lines they were printed as, so a copied
  path or JSON blob can be pasted back rather than arriving broken where the
  window happened to end. Scrolled back it takes the command being looked at
  rather than the last one run — the two are the same rule read from the top of
  the screen, which is also why a session still short enough to fit on one screen
  does not read as "scrolled to the very first command". **Select the last
  command's output** and **Select everything in this pane** are in the palette;
  the second was missing entirely, since a terminal has no Ctrl+A of its own.

- **Panes zoom, and resize from the keyboard.** A split layout could be made but
  not worked: the only way to change a pane's size was to drag a 6px divider, and
  there was no way to give one pane the whole tab for a minute. `Alt+Shift+Z`
  lays the focused pane over its tab and puts it back — over, not instead of, so
  the tree, the sizes and every other shell are untouched and unzooming restores
  the layout exactly rather than rebuilding it. The tab is marked while it lasts,
  because a zoomed tab is indistinguishable from a tab that never had splits.
  `Alt+Shift+←` `→` `↑` `↓` move the boundary the pane sits against by a step of
  the split it belongs to, so it feels the same however deep the pane is; a pane
  already against the wall moves its other edge instead, which is what "the edge
  moves right" has to mean there. Splitting, closing a pane, moving focus out or
  handing the tab to another window all let go of the zoom first — each of them
  otherwise changes a layout nobody can see.

- **The buffer search can be narrowed.** `Ctrl+F` passed the addon a term and
  nothing else, so every search was case-insensitive, substring, literal — and
  the three options that would fix that were already implemented, just never
  asked for. The bar now carries **Aa**, **ab** and **.\***, also on `Alt+C` /
  `Alt+W` / `Alt+R` so they are reachable without leaving the box, and they are
  one set for the whole app rather than per pane: a search is a habit, and having
  to set match case again in the next pane is the same annoyance as not having it.
  A regular expression is checked before it is run, because a pattern is a broken
  pattern most of the way through typing it — the box says *Bad pattern* instead
  of reporting no results, which would read as an answer. Flipping an option also
  clears the addon's match cache: it keys that cache on the term, so with the term
  unchanged the count went on answering the old question — turning on match case
  moved the selection but still counted every casing.

- **The tab being dragged follows the cursor across the desktop.** It was drawn
  in the window it came from, and a page cannot paint outside its own window — so
  the moment it crossed the window edge it vanished, which is exactly where
  dragging a tab out starts to matter: the gesture worked, but you were aiming
  blind. It is now a window of its own — frameless, transparent, click-through,
  never focused, above everything — so it stays under the cursor over the desktop
  and over other Frost windows, and it still carries the outline that says what
  letting go would do. One such window is kept for the whole session rather than
  made per drag, because creating one costs a visible frame; it is destroyed with
  the last real window, since a window nobody can see would otherwise keep Frost
  from ever quitting.

- **A tab can be dropped on another window, and the drag is visible.** Two
  things the first cut got wrong. The tab jumped to its new place the instant the
  pointer crossed another tab, with nothing following the cursor — so a reorder
  that had already happened looked like one that had not, and there was no way to
  see what letting go would do. A copy of the tab now follows the cursor,
  outlined for what the drop means, over a dimmed placeholder where it would
  land; a copy rather than the tab itself because the strip scrolls sideways and
  clips vertically, which would cut the tab off exactly when the gesture stops
  being a reorder. And a tab dragged out could not be put back: dropping it on
  another Frost window now hands it to that window, which is what every other
  tabbed application does. Only main can work out which window is under the
  pointer — the window being dropped onto is a different renderer and never sees
  the drag, since the pointer stays captured by the window the gesture started
  in — so it converts the point through the dragging window's zoom and content
  origin and answers from the window list. It is asked on a timer while dragging,
  which is what keeps the label right when the pointer is held still, and again
  at the drop, which is what actually decides. Dropping on the window you started
  from still means a window of its own, however far from the strip you are.

- **Tabs move, reorder and take a name.** The strip was fixed: tabs opened in
  the order they were created and stayed in it, said `directory · branch` and
  nothing else, and could not leave the window they were born in — while
  `Ctrl+Shift+N` had been opening extra windows all along. Dragging a tab
  sideways now reorders it; dragging it off the strip opens it in a window of its
  own. The shells are not restarted for that: main keeps them running and
  re-points their output at the new window, so a build still building keeps
  building, and the scrollback is serialised across so the text on screen
  survives too — output arriving in the moment between the two windows is held
  and replayed rather than dropped. Double-click a tab to name it, which is what
  tells two tabs in the same repo apart; the name persists in the session,
  travels with a moved tab, and emptying it hands the tab back to its live
  title. Right-click gives rename, duplicate, move to a new window and close,
  and the last two are commands in the palette. The agent view stays put — it is
  one per app by design.

- **Frost updates itself.** Every release so far had to be noticed on GitHub and
  reinstalled by hand, which means the version people run is whichever one they
  happened to download. An installed build now asks the releases feed for a newer
  version at startup and every six hours, downloads it in the background, and
  installs it the next time you quit — never mid-session, because a terminal
  holds running work and open scrollback that a restart of its own choosing would
  throw away. The settings panel gained an **Updates** section: the version you
  are running beside the latest one, **Check now**, and **Restart and install**
  once something is downloaded, for anyone who does not want to wait for a quit.
  `update` in `theme.json` — `{ "check": true, "download": true }` — turns either
  half off, and **Check for updates** is in the command palette. The check is
  verified against the `sha512` in the release's `latest.yml`, which is the only
  thing standing in for a code signature these builds do not have. A portable exe
  was never installed, so there is nothing for an installer to replace: it
  reports that instead of checking, and so does a run from source.

### Changed

- **The renderer is ten files rather than one.** `renderer.js` had reached four
  thousand lines and was the whole interface — panes, tabs, agents, diffs,
  settings, the palette — which made every change a search through everything
  else. It is split along the seams that were already there in its section
  comments: core, panes, tabs, profiles, agents, diff, commands, palette,
  settings, boot. Still plain scripts sharing one scope, not modules: the
  terminal, its panes and its tabs are one live object graph, nothing stands
  between the source and the window, and the checks in `tools/` drive a real
  window by evaluating these names inside it. Nothing about what runs changed —
  the same 74 checks pass across the five suites, plus the window and restore
  ones.

### Fixed

- **The search count no longer states a total it does not have.** The addon
  stops collecting matches at a thousand and reports that number as the total, so
  a buffer with ten thousand of them read `1/1000` — a total that is really a
  floor — and past the limit it stops tracking which match is current and reports
  the index as -1, which rendered as the position `0`. Both now read
  `1000+ matches`, which is what is actually known.

- **The command palette's scrollbar looks like the rest of Frost.** It was the
  browser's own, white and wide, because the styling had been written three
  times for three panels and the palette was not one of them. One rule now covers
  every panel that scrolls; the terminal keeps its own, since that scrollbar
  carries the command ticks.

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
