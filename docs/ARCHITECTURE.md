# Frost architecture

How the code is laid out, and what porting Frost to another OS takes. Frost runs on Windows and
macOS (Apple Silicon). The layout exists so that an OS adds code next to the others instead of
rewriting the middle of the app; a Linux port would be a third sibling.

## Main process (`src/main/`)

```
main.js        startup order only: userData → stalls → features → single-instance lock → ready
env.js         paths and fixed values (config files, agent-status folder, icons, MAIN_DIR / RENDERER_DIR, test overrides)
late.js        calling into a module that may still be loading (the features call each other in cycles)
stalls.js      names whatever holds the main process up, in stalls.log; for a hung window, its script
               stack, each process's CPU/memory and the last ten minutes of both
preload.js     the window.api bridge the renderer talks through

core/          pure logic, no Electron, no files, no processes; unit-tested (npm run test:core)
  geometry.js    zoom steps, display keys, re-proportioning saved window bounds
  agents.js      agent status rules, "does this command start claude", transcript JSONL
  git.js         git's quoted paths and porcelain status
  version.js     release version comparison
  launch.js      what a second Frost process hands over

features/      one area each; owns its state and its IPC channels; Electron is fine, OS-specific code is not
  config.js        theme.json / keybindings / agents.json: defaults, reading, first-run files
  theme-ipc.js     theme and keys to and from windows
  profiles.js      shell profiles, start folder
  launch.js        `frost <dir>`, --run, --profile (and macOS open-file events: Dock, Open With)
  git.js           branch for tab titles, git helpers and base snapshots shared by agents/diff/peek
  pty/             shells (spawn, type-ahead, input), spare shells, moving a shell between windows
  tab-drag.js      the tab that follows the cursor, drop targets
  windows/         window creation, registry, zoom, saved geometry (window.json), framing, window IPC
  glass.js         the blurred wallpaper behind a glass window
  agents/          agents.js detect/register/end + status, hooks.js the injected Claude Code hooks,
                   edits.js which files an agent edited, sessions.js resumable sessions, diff.js the panel
  peek.js, paths.js, images.js, open.js   the file viewer, links in output, pasted images, editors
  notify.js, updates.js, fonts.js

platform/      everything that only works on one OS; features import `platform`, never a folder below it
  index.js       picks the implementation: darwin/ on macOS, win32/ everywhere else
  win32/
    shells.js            where.exe, WSL distros, detected profiles (pwsh, Windows PowerShell, cmd, Git Bash, WSL)
    shell-integration.js PowerShell prompt hook and claude wrapper, bash rc (also used on macOS; ends the
                         prompt with OSC 133;B so multi-row prompts like Git Bash's are read right), PSReadLine
                         history filter
    wallpaper.js         IDesktopWallpaper (COM via PowerShell), registry, TranscodedWallpaper copies and their watch
    window-chrome.js     glass frame options, DWM material, native caption-button overlay
    fonts.js             installed fonts from the registry
    processes.js         process start times (pid reuse check for Claude sessions)
    editor.js            editor executables (Code.exe, Cursor.exe…) beside their shims
    app.js               source build's taskbar id, home folder, portable-build check
  darwin/        the same names as win32/
    login-path.js        a packaged app opened from Finder takes the login shell's PATH (runs first)
    shells.js            login shell first, then zsh, bash, fish, pwsh (`which` + Homebrew folders); no WSL
    shell-integration.js zsh hooks through a ZDOTDIR of Frost's own that loads the user's files first, and
                         win32's bash rc plus A inside the prompt; both mark from inside the prompt, so redraws
                         (Ctrl+L) still mark
    wallpaper.js         each screen's desktop picture through AppKit, HEIC turned into JPEG
    window-chrome.js     traffic lights over Frost's titlebar, acrylic mapped to vibrancy
    fonts.js             system_profiler
    processes.js         `ps -o lstart` start times (pid reuse check)
    editor.js            editors on PATH or in /Applications
    app.js               the Cmd app menu, Install 'frost' Command…, home folder
```

Conventions:

- A module ends with `Object.assign(module.exports, { … })`, never `module.exports = { … }`, so a module
  in a require cycle still sees the finished object.
- A function from a module that requires yours back comes through `late()`; plain destructuring only
  where there is no cycle. A `let` another module needs is exposed through a getter/setter, never exported.
- New pure logic goes to `core/` with a test; anything OS-specific goes behind `platform/`.

## Renderer (`src/renderer/`)

Classic scripts sharing one global scope, loaded in order by `index.html`: `core.js`, `tooltip.js`,
`panes/*`, `tabs/*`, `profiles.js`, `agents/*`, `diff.js`, `peek/*`, then blocks, loading, commands, palette,
settings, candy, stalls (long frames in the window, written to the main process's stalls.log) and `boot.js`. A folder is one former file cut at its section headings, loaded in the same
order, so nothing that runs at load time may use a name declared in a later script. The end-to-end tests
(`tools/*test.js`) drive the page through these globals by name.

Looks are CSS: `styles/*.css` (the former style.css cut at its section headings, linked in the same order, so
the cascade is unchanged) and one file per design in `designs/`, scoped to `body[data-design=…]` and linked
after `styles/`.

The renderer's OS switches are in `core.js`: `IS_MAC` (also a `.mac` class on the body), `osText(win, mac)`
for wording, `modKey(ev)` for the app modifier (Ctrl, or Cmd on a Mac) and `keyText()` for key labels.
`styles/mac.css` holds the Mac-only chrome, `index.html` carries Mac wording in `data-mac` attributes, and
`commands.js` has its own `MAC_DEFAULT_BINDINGS` table, so the Windows table is never touched.

## Porting checklist

macOS was done this way: `platform/darwin/` exports the same names as `platform/win32/`. A Linux port adds
`platform/linux/` the same way (most of `darwin/`'s zsh and bash work carries over), then works through
the rest of this list. What is still open on the Mac is tracked in issue #18.

**Platform functions to provide**

| Function | Windows does | macOS does |
|---|---|---|
| `detectProfiles`, `whichExe` | where.exe, fixed install paths, WSL | login shell, `which`, Homebrew folders |
| `psStartup`, `bashRc`, `PS_SPARE_HISTORY` | PowerShell + Git Bash hooks (OSC 9;9 cwd, OSC 133 marks) | zsh (own ZDOTDIR) and bash hooks, marks inside the prompt |
| `desktopWallpaperTiles`, `watchWallpaperFiles` | COM, registry, TranscodedWallpaper | AppKit per screen, HEIC to JPEG |
| `frameOptions`, `setMaterial`, `setCaptionButtons`, `refreshMaterialOnBlur` | DWM materials, titleBarOverlay | vibrancy, traffic lights |
| `listFonts` | registry | system_profiler |
| `canCheckProc`, `processStartTimes` | Get-Process start time | `ps -o lstart` |
| `EDITOR_CANDIDATES`, `resolveExecutable` | .exe beside the shim | binaries on PATH, app bundles in /Applications |
| `identifySourceBuild`, `homeDir`, `isPortableBuild` | AppUserModelId, USERPROFILE, portable exe | no-op, `os.homedir()`, false |

**Windows assumptions handled for macOS, each with the Windows path unchanged**

- `features/paths.js` `targetPath` reads `/c/x` (Git Bash) as `C:/x` only off macOS, where `/c/...` can be a
  real folder.
- `main.js` sets a small Cmd app menu on macOS (quit, hide, Edit roles); Windows still sets none.
- Renderer: `panes/drop.js` single-quotes dropped paths on macOS; `peek/file.js` builds `file://` + a POSIX
  path there; key labels and wording go through `keyText` / `osText`; xterm is told `windowsPty: conpty`
  only on Windows.
- Updates: Mac builds are ad-hoc signed and can't replace themselves, so `features/updates.js` stops at
  "available" there and points to the release page.
- Packaging: the `mac` section of the build config (arm64 `.dmg` + `.zip`, ad-hoc signed, `build/icon.icns`,
  `build/mac/frost`); the release workflow builds it on a macOS runner after the Windows job.

**Still Windows-shaped** (fine on macOS as it is, worth a look for Linux)

- Paths are lowercased for lookups throughout (repo roots, the file-name index, wallpaper paths), which assumes a
  case-insensitive filesystem. Windows and macOS default to one; Linux doesn't.
- Spare shells are PowerShell-only (the move into a folder is typed as `Set-Location`), so a Mac has none.
- `features/agents/agents.js` hook commands quote paths for cmd/PowerShell and strip the BOM that Windows
  PowerShell writes.
- `features/paths.js` filters Windows filename metacharacters and skips UNC paths on every OS.
