// The PowerShell and bash hooks are plain shell code that runs the same on
// macOS (bash's `pwd -W` fails there and falls back to `pwd`), so they are
// shared with Windows rather than copied.
const win = require('../win32/shell-integration');

// ---------- zsh ----------
// zsh has no --rcfile, so Frost points ZDOTDIR at a folder of its own whose
// startup files load the user's real ones first and then add Frost's two jobs:
// the prompt marks / cwd report, and the `claude` wrapper. The user's files are
// never touched. FROST_USER_ZDOTDIR is where theirs live (their own ZDOTDIR,
// or home); while one of their files runs ZDOTDIR points back at it, since
// their scripts may use it, and after .zshrc it stays there for good.
//
// Each file: { name: contents }, written by features/pty/shells.js.

// Sources the user's copy of one startup file with their ZDOTDIR in force, then
// goes back to Frost's folder so zsh finds the next one there.
const chain = (name) =>
  [
    `__frost_zdotdir=$ZDOTDIR`,
    `ZDOTDIR=$FROST_USER_ZDOTDIR`,
    `[[ -f $ZDOTDIR/${name} ]] && builtin source $ZDOTDIR/${name}`,
    // their file may have moved ZDOTDIR on purpose: follow it for later files
    `FROST_USER_ZDOTDIR=$ZDOTDIR`,
    `ZDOTDIR=$__frost_zdotdir`,
    ''
  ].join('\n');

// The claude wrapper: announces start and end (with the cwd) to the file Frost
// watches and adds the status-hooks settings. `whence -p` skips functions, or
// it would find itself. `always` runs the end line even when Ctrl+C stops the
// function, and `>|` writes even under `setopt noclobber`.
const ZSH_CLAUDE = [
  'function claude {',
  '  local exe; exe=$(whence -p claude) || exe=""',
  '  if [[ -z $exe ]]; then print -u2 "claude not found"; return 1; fi',
  '  local here=$PWD',
  "  printf 'start|%s' \"$here\" >| \"$FROST_LAUNCH\"",
  "  { \"$exe\" --settings \"$FROST_HOOKS\" \"$@\" } always { printf 'end|%s' \"$here\" >| \"$FROST_LAUNCH\" }",
  '}',
  ''
].join('\n');

// OSC 133;D;<exit> closes the command that ran, 133;A marks where the prompt
// begins, OSC 9;9 reports the cwd — the same marks the PowerShell and bash hooks
// draw. D only after a command actually ran (preexec saw one): an empty Enter
// would otherwise report the last exit again as a command of its own. precmd
// goes first in the list so $? is still the command's, not another hook's.
// A and B (where the prompt ends) are part of the prompt itself rather than
// printed from precmd: zsh redraws the prompt without running precmd — Ctrl+L,
// a theme refreshing itself — and the redrawn prompt is the one typed at.
const ZSH_HOOKS = [
  'typeset -g __frost_seen= __frost_ran=',
  'function __frost_preexec { __frost_ran=1 }',
  'function __frost_precmd {',
  '  local ec=$?',
  "  [[ -n $__frost_seen && -n $__frost_ran ]] && printf '\\033]133;D;%s\\007' $ec",
  '  __frost_seen=1 __frost_ran=',
  "  printf '\\033]9;9;%s\\007' \"$PWD\"",
  '}',
  // B lets Frost cut what was typed from the prompt whatever theme draws it.
  // Run last, after the theme's own precmd has rebuilt the prompt; inside
  // %{ %} so neither mark takes up any width.
  'function __frost_prompt_end {',
  "  [[ $PS1 == *$'\\e]133;A'* ]] || PS1=$'%{\\e]133;A\\a%}'$PS1",
  "  [[ $PS1 == *$'\\e]133;B'* ]] || PS1+=$'%{\\e]133;B\\a%}'",
  '}',
  'typeset -ga precmd_functions preexec_functions',
  'precmd_functions=(__frost_precmd ${precmd_functions:#__frost_precmd} __frost_prompt_end)',
  'preexec_functions+=(__frost_preexec)',
  ''
].join('\n');

function zshFiles(withClaude) {
  const head = '# Frost session file — exists only for terminals Frost spawns.\n';
  return {
    '.zshenv': head + chain('.zshenv'),
    '.zprofile': head + chain('.zprofile'),
    '.zshrc':
      head +
      // /etc/zshrc set the history file from ZDOTDIR while it was Frost's
      // folder: put it back where the user's history is
      '[[ $HISTFILE == $ZDOTDIR/.zsh_history ]] && HISTFILE=$FROST_USER_ZDOTDIR/.zsh_history\n' +
      chain('.zshrc') +
      (withClaude ? ZSH_CLAUDE : '') +
      ZSH_HOOKS +
      // not a login shell: no .zlogin follows to hand ZDOTDIR back
      '[[ -o login ]] || ZDOTDIR=$FROST_USER_ZDOTDIR\n',
    // last file zsh reads: from here on ZDOTDIR is the user's, so anything that
    // starts a nested zsh gets their setup, not this
    '.zlogin': head + chain('.zlogin') + 'ZDOTDIR=$FROST_USER_ZDOTDIR\n'
  };
}

// The shared bash rc, plus the marks the zsh hook puts in its prompt: B where
// the prompt ends (macOS's own bash prompt, "host:dir user$ ", isn't one Frost
// can recognise by its shape), and A again where it starts, because readline's
// Ctrl+L redraws the prompt without PROMPT_COMMAND. On an ordinary prompt the
// second A replaces the first. \[ \] keeps them from taking up any width.
const bashRc = (withClaude) =>
  win.bashRc(withClaude) + "PS1='\\[\\033]133;A\\007\\]'\"$PS1\"'\\[\\033]133;B\\007\\]'\n";

Object.assign(module.exports, {
  CLAUDE_WRAPPER: win.CLAUDE_WRAPPER,
  PS_CWD_HOOK: win.PS_CWD_HOOK,
  psStartup: win.psStartup,
  bashRc,
  PS_SPARE_HISTORY: win.PS_SPARE_HISTORY,
  zshFiles
});
