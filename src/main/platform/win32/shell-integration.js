

// --- IPC ---

// Session-local `claude` wrapper: announces launches to the app (start/end +
// cwd) and quietly adds the status-hooks settings file. Lives only inside
// terminals this app spawns — the user's profile and global config untouched.
const CLAUDE_WRAPPER =
  'function claude { ' +
  '$exe = (Get-Command claude -CommandType Application | Select-Object -First 1).Source; ' +
  'if (-not $exe) { Write-Error "claude not found"; return }; ' +
  'Set-Content -LiteralPath $env:FROST_LAUNCH -Value ("start|" + (Get-Location).Path) -Encoding UTF8; ' +
  // finally, because Ctrl+C stops the function too, and a plain next line
  // would never run
  'try { & $exe --settings $env:FROST_HOOKS @args } ' +
  'finally { Set-Content -LiteralPath $env:FROST_LAUNCH -Value ("end|" + (Get-Location).Path) -Encoding UTF8 } ' +
  '}';

// Reports the shell's cwd to the app on every prompt via OSC 9;9 (the sequence
// Windows Terminal uses). Wraps whatever `prompt` the user's profile installed
// — starship, oh-my-posh — instead of replacing it: -Command runs after the
// profile has loaded.
// Also emits OSC 133 command marks: D;<exit> closes the command that just ran,
// A marks where this prompt begins. Together they let Frost show how each
// command ended and jump between them. $? has to be read before anything else
// in the function, or it reports on our own statements instead.
// D goes out only when the history has grown: an empty Enter redraws the
// prompt with $? still holding the last command's result, and reporting it
// again would turn that empty line into a command of its own.
const PS_CWD_HOOK =
  '$global:__frostPrompt = $function:prompt; ' +
  'function global:prompt { ' +
  '$__ok = $?; $__ec = $LASTEXITCODE; ' +
  '$__code = if ($__ok) { 0 } elseif ($__ec) { $__ec } else { 1 }; ' +
  '$__h = try { (Get-History -Count 1).Id } catch { $null }; ' +
  '$__ran = $__h -ne $global:__frostHist; $global:__frostHist = $__h; ' +
  '$out = try { & $global:__frostPrompt } catch { "PS " + (Get-Location).Path + "> " }; ' +
  'try { $l = Get-Location; if ($l.Provider.Name -eq "FileSystem") { ' +
  '[Console]::Write([char]27 + "]9;9;" + $l.ProviderPath + [char]7) } } catch {}; ' +
  'try { ' +
  'if ($global:__frostSeen -and $__ran) { [Console]::Write([char]27 + "]133;D;" + $__code + [char]7) }; ' +
  '$global:__frostSeen = $true; ' +
  '[Console]::Write([char]27 + "]133;A" + [char]7) } catch {}; ' +
  '$out }';

function psStartup(withClaude) {
  return withClaude ? CLAUDE_WRAPPER + '; ' + PS_CWD_HOOK : PS_CWD_HOOK;
}

// Same two jobs for bash-family shells (Git Bash, MSYS), delivered as an rc
// file so the user's own ~/.bashrc still loads. `type -P` skips functions,
// otherwise the claude wrapper would resolve to itself and recurse.
function bashRc(withClaude) {
  const lines = [
    '# Frost session rc — exists only inside terminals Frost spawns.',
    '[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc',
    '[ -f ~/.bashrc ] && . ~/.bashrc'
  ];
  if (withClaude) {
    lines.push(
      'claude() {',
      '  local exe; exe=$(type -P claude) || exe=""',
      '  if [ -z "$exe" ]; then echo "claude not found" >&2; return 1; fi',
      '  local here; here=$(pwd -W 2>/dev/null || pwd)',
      '  printf "start|%s" "$here" > "$FROST_LAUNCH"',
      '  "$exe" --settings "$FROST_HOOKS" "$@"',
      '  printf "end|%s" "$here" > "$FROST_LAUNCH"',
      '}'
    );
  }
  lines.push(
    // pwd -W gives the Windows path under MSYS, so Frost gets a path it can stat
    // BEL-terminated: keeps the format string free of backslash escaping traps
    "__frost_cwd() { local p; p=$(pwd -W 2>/dev/null || pwd); printf '\\033]9;9;%s\\007' \"$p\"; }",
    // $? first, before anything else can overwrite it. D only for a prompt
    // that follows a command: an empty Enter leaves $? where the last command
    // put it, and the prompt's command number (\#) with it — only a command
    // that ran moves the number, so that is what tells the two apart. HISTCMD would also stand still for a rerun that
    // ignoredups kept out of the history. Bash before 4.4 can't expand \#, and
    // reports every prompt as before.
    '__frost_prompt() {',
    "  local ec=$? n='\\#' ran=1",
    '  if [ "${BASH_VERSINFO[0]}${BASH_VERSINFO[1]}" -ge 44 ] 2>/dev/null; then',
    '    n=${n@P}; [ "$n" = "$__frost_num" ] && ran=; __frost_num=$n',
    '  fi',
    "  if [ -n \"$__frost_seen\" ] && [ -n \"$ran\" ]; then printf '\\033]133;D;%s\\007' \"$ec\"; fi",
    '  __frost_seen=1',
    "  printf '\\033]133;A\\007'",
    '  __frost_cwd',
    '}',
    'PROMPT_COMMAND="__frost_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"',
    ''
  );
  return lines.join('\n');
}

// The move's own line, kept out of PSReadLine's history. The user's own
// handler, if they have one, still decides for every other line.
const PS_SPARE_HISTORY =
  'try { $global:__frostHistH = (Get-PSReadLineOption).AddToHistoryHandler; ' +
  'Set-PSReadLineOption -AddToHistoryHandler { param($l) ' +
  'if ($l -like "*#frost-spare") { return $false }; ' +
  'if ($global:__frostHistH) { return & $global:__frostHistH $l }; return $true } } catch {}';

Object.assign(module.exports, {
  CLAUDE_WRAPPER,
  PS_CWD_HOOK,
  psStartup,
  bashRc,
  PS_SPARE_HISTORY
});
