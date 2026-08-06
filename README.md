<p align="center">
  <img src="assets/icon-256.png" width="96" alt="Frost icon" />
</p>

<h1 align="center">Frost</h1>

<p align="center">
  A fully customizable acrylic terminal for Windows — with a built-in AI agent mode.<br/>
  Electron · xterm.js · ConPTY · PowerShell 7
</p>

---

![Agent mode — live status, terminal, and diff watch](assets/screenshot-agent.png)

## Why

Windows terminals let you pick a theme. Frost lets you own the whole surface:
real acrylic/glass backdrops you control down to blur radius and tint alpha,
hot-reloading config files, raw CSS injection — and a first-class mode for
running and supervising Claude Code agents with live status and diff watching.

## Features

- **Shell profiles** — PowerShell 7, Windows PowerShell, cmd, Git Bash and every
  WSL distro are detected on first run and written into `theme.json`. Add your
  own (shell, args, cwd, env) by editing that list. The `▾` button next to `+`
  lists them, `Ctrl+Shift+1…9` opens the Nth, and splitting a pane keeps the
  shell you were already in
- **Tab titles that say something** — each tab shows `directory · branch`, live.
  The shell reports its cwd on every prompt (OSC 9;9, injected by wrapping
  whatever prompt your profile already installed — starship and oh-my-posh keep
  working), and the branch is read straight out of `.git/HEAD`, so no `git`
  process runs per prompt. A program that sets its own title (claude, ssh, vim)
  still wins. Splits and `Ctrl+Shift+D` inherit the current directory
- **Picks up where you left off** — window size, position and maximized state
  come back, along with your tabs and split layout, each pane reopened in the
  directory it was in. Written continuously, so a crash doesn't lose it. Toggle
  in settings; agent tabs stay out of it and keep their own resume list
- **Backdrop materials**
  - `acrylic` / `mica` / `tabbed` — native Windows backdrops
  - `acrylic-always` — native acrylic that **never dims on unfocus** (Frost
    re-applies the backdrop on blur)
  - `glass` — Frost's own backdrop: truly transparent window, wallpaper blurred
    in-app. Blur 0–100px, tint from fully clear to opaque, zero Windows frost
- **Hot-reload everything** — save `config/theme.json` or `config/theme.css`
  and the running window updates instantly. `theme.css` is raw CSS injected
  last: restyle anything
- **Agent mode** — a special tab for AI coding agents (Claude Code first),
  heavily inspired by the excellent [herdr](https://herdr.dev/):
  - run `claude` in any Frost terminal → it auto-registers as an agent with
    live status: working / **blocked (needs you)** / done / idle
  - diff watch panel: live green/red diff of the agent's repo — **Session**
    (everything since the agent started, survives commits) or **Uncommitted**
  - sessions persist: after a restart, one click re-opens the repo and runs
    `claude --continue`
  - optional worktree isolation per agent for parallel work on one repo
  - status comes from Claude Code hooks injected per-session via `--settings` —
    your global Claude config is never touched. Kill switch in settings
- **Terminal quality**: GPU renderer with builtin box-drawing glyphs,
  full-color emoji, Unicode 11 widths, auto-contrast for unreadable colors
  (Windows Terminal parity), tabs, split panes, font picker listing your
  installed monospace fonts

## Run

```
npm install
npm start
```

Requires Node 18+, Windows 11 for the acrylic/mica materials
(`glass` works anywhere), and [PowerShell 7](https://github.com/PowerShell/PowerShell)
(falls back to Windows PowerShell). Agent mode expects
[Claude Code](https://claude.com/claude-code) on PATH.

> **Smart App Control**: unsigned dev binaries (Electron) are blocked when SAC
> is enforcing. Dev on a SAC machine requires turning it off.

## Shortcuts

`Ctrl+Shift+P` opens the command palette, which lists every command next to the
key it currently answers to — that, not this table, is the authoritative list.

| Keys | Action |
|------|--------|
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+Shift+T` | New tab (default profile) |
| `Ctrl+Shift+1` … `9` | New tab with the Nth shell profile |
| `Ctrl+1` … `8` / `Ctrl+9` | Go to tab N / last tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl+Shift+A` | New agent tab |
| `Ctrl+Shift+D` | Duplicate tab (same shell, same directory) |
| `Ctrl+Shift+W` | Close pane (last pane closes tab) |
| `Alt+Shift+=` / `Alt+Shift+-` | Split right / down (inherits directory) |
| `Alt+←` `→` `↑` `↓` | Move focus to the pane in that direction |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom in / out / reset |
| `Ctrl+F` | Search buffer |
| `Ctrl+Shift+K` | Clear buffer |
| `Ctrl+,` | Settings panel |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copy / paste |
| Right-click | Copy selection, else paste |

Every one of them is remappable in `config/keybindings.json`:

```json
{
  "bindings": [
    { "keys": "ctrl+t", "command": "tab.new" },
    { "keys": "ctrl+shift+k", "command": null },
    { "keys": "alt+2", "command": "tab.go", "args": { "index": 2 } }
  ]
}
```

Reusing a built-in's `keys` replaces it, `"command": null` unbinds it, and the
file hot-reloads on save. Keys are matched on physical position, so a binding
lands on the same key on every keyboard layout.

## Configuration

![Settings — glass backdrop, tint, fonts, agent options](assets/screenshot-options.png)

Created with defaults on first run, all hot-reloading:

- `config/theme.json` — material, colors, blur, tint, fonts, cursor, padding,
  corner radii, start directory, ANSI palette, agent auto-detect, and
  `profiles` / `defaultProfile`:

  ```json
  {
    "id": "ubuntu",
    "name": "Ubuntu",
    "shell": "C:\\Windows\\System32\\wsl.exe",
    "args": ["-d", "Ubuntu", "--cd", "~"],
    "cwd": "",
    "env": {},
    "agentWrapper": "none"
  }
  ```

  `agentWrapper` says which dialect the session-local `claude` wrapper is
  written in: `powershell`, `bash`, or `none` (no agent auto-detect in that
  shell — agent tabs then use the first profile that supports it)
- `config/theme.css` — raw CSS, injected last, overrides anything
- `config/keybindings.json` — key overrides (see [Shortcuts](#shortcuts))
- `config/agents.json` — saved repos ("spaces") for agent mode
- `config/sessions.json` — resumable agent sessions (managed automatically)
- `config/window.json` — window geometry and tab layout (managed automatically)

The settings panel (`Ctrl+,`) edits `theme.json` for you.

## License

MIT
