# Frost architecture

How the code is laid out, and what porting Frost to macOS or Linux would take. Frost only runs on
Windows today; this layout exists so that a port adds code next to the Windows code instead of
rewriting the middle of the app.

## Main process (`src/main/`)

```
main.js        startup order only: userData → stalls → features → single-instance lock → ready
env.js         paths and fixed values (config files, icons, MAIN_DIR / RENDERER_DIR, test overrides)
late.js        calling into a module that may still be loading (the features call each other in cycles)
stalls.js      names whatever holds the main process up, in stalls.log
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
  launch.js        `frost <dir>`, --run, --profile
  git.js           branch for tab titles, git helpers shared by agents/diff/peek
  pty/             shells (spawn, type-ahead, input), spare shells, moving a shell between windows
  tab-drag.js      the tab that follows the cursor, drop targets
  windows/         window creation, registry, zoom, saved geometry (window.json), framing, window IPC
  glass.js         the blurred wallpaper behind a glass window
  agents/          agent detection and status hooks, Claude Code sessions, the diff panel
  peek.js, paths.js, images.js, open.js   the file viewer, links in output, pasted images, editors
  notify.js, updates.js, fonts.js

platform/      everything that only works on one OS; features import `platform`, never `platform/win32`
  index.js       picks the implementation (only win32 exists)
  win32/
    shells.js            where.exe, WSL distros, detected profiles (pwsh, Windows PowerShell, cmd, Git Bash, WSL)
    shell-integration.js PowerShell prompt hook and claude wrapper, bash rc, PSReadLine history filter
    wallpaper.js         IDesktopWallpaper (COM via PowerShell), registry, TranscodedWallpaper copies and their watch
    window-chrome.js     glass frame options, DWM material, native caption-button overlay
    fonts.js             installed fonts from the registry
    processes.js         process start times (pid reuse check for Claude sessions)
    editor.js            editor executables (Code.exe, Cursor.exe…) beside their shims
    app.js               source build's taskbar id, home folder, portable-build check
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
settings, candy and `boot.js`. A folder is one former file cut at its section headings, loaded in the same
order, so nothing that runs at load time may use a name declared in a later script. The end-to-end tests
(`tools/*test.js`) drive the page through these globals by name.

Looks are CSS: `styles/*.css` (the former style.css cut at its section headings, linked in the same order, so the cascade is unchanged) and one file per design in `designs/`, scoped to `body[data-design=…]` and linked after `styles/`.

## Porting checklist

A port adds `platform/darwin/` or `platform/linux/` exporting the same names as `platform/win32/`, then
works through the rest of this list.

**Platform functions to provide**

| Function | Windows does | A port needs |
|---|---|---|
| `detectProfiles`, `whichExe` | where.exe, fixed install paths, WSL | `$SHELL`, /etc/shells, `which` |
| `psStartup`, `bashRc`, `PS_SPARE_HISTORY` | PowerShell + Git Bash hooks (OSC 9;9 cwd, OSC 133 marks) | bash/zsh hooks; `pwd -W` is MSYS-only (falls back to `pwd`) |
| `desktopWallpaperTiles`, `watchWallpaperFiles` | COM, registry, TranscodedWallpaper | desktop picture APIs, or turn glass off |
| `frameOptions`, `setMaterial`, `setCaptionButtons`, `refreshMaterialOnBlur` | DWM materials, titleBarOverlay | macOS vibrancy + traffic lights; Linux frame |
| `listFonts` | registry | system font list |
| `canCheckProc`, `processStartTimes` | Get-Process start time | `ps -o lstart` or equivalent |
| `EDITOR_CANDIDATES`, `resolveExecutable` | .exe beside the shim | the `code`/`cursor` binaries on PATH, app bundles |
| `identifySourceBuild`, `homeDir`, `isPortableBuild` | AppUserModelId, USERPROFILE, portable exe | no-op, `os.homedir()`, false |

**Windows assumptions still outside `platform/`** (found in the 2026-11 survey; left as they are because
changing them would change Windows behaviour)

- `features/paths.js` `targetPath` turns `/c/x` (Git Bash) into `c:/x`, which would mangle a real POSIX `/c/...`;
  it also filters Windows filename metacharacters and skips UNC paths.
- Paths are lowercased for lookups throughout (repo roots, the file-name index, wallpaper paths), which assumes a
  case-insensitive filesystem.
- Spare shells are PowerShell-only (the move into a folder is typed as `Set-Location`).
- `features/agents/agents.js` hook commands quote paths for cmd/PowerShell and strip the BOM that Windows
  PowerShell writes; `claude --settings` gets a Windows path.
- `Menu.setApplicationMenu(null)` in `main.js`: on macOS this also removes the app menu (Cmd+Q, Edit roles).
- Renderer: `panes/drop.js` `quotePath` wraps in double quotes (safe for Windows filenames, not for `$` or
  backticks in POSIX shells); `peek/file.js` builds `file:///` + a drive-letter path; path regexes look for
  `C:\`; key labels say Ctrl and menus say "Explorer"; xterm is told `windowsPty: conpty`.
- Packaging: NSIS and portable targets, `build/installer.nsh`, `icon.ico`.
