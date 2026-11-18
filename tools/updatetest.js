// Update-install resilience test (Windows only, plain node — not electron).
//
//   node tools/updatetest.js <old Frost-Setup.exe> <new Frost-Setup.exe> [--allusers]
//
// Both installers must be built under a separate product name so nothing here
// touches the Frost you actually use (its folder, registry keys, settings):
//
//   npx electron-builder --win nsis --x64 --publish never \
//     -c.productName=FrostTest -c.extraMetadata.productName=FrostTest \
//     -c.appId=dev.azekyoo.frost.test \
//     -c.nsis.shortcutName=FrostTest -c.nsis.uninstallDisplayName=FrostTest \
//     -c.nsis.createDesktopShortcut=false \
//     -c.extraMetadata.version=2.10.1-test.1 -c.directories.output=<dir>/old
//   (and again with -test.2 into <dir>/new)
//
// What it checks, against build/installer.nsh:
//   1. a manual install never leaves a RunOnce retry behind
//   2. an update (/S --updated) installs and removes its own RunOnce entry
//   3. an update killed after the old version is gone leaves Frost broken but
//      the RunOnce entry in place, pointing at the same folder
//   4. running that entry the way Windows does at sign-in finishes the update,
//      clears the entry, and the app starts
// It uninstalls FrostTest at the end, pass or fail.
//
// --allusers runs the same against an install in Program Files. There an
// update starts unelevated, registers the retry, then relaunches itself
// elevated (UAC) for the copy, so the retry is written by one process and
// cleared by another. The test opens one elevated helper up front (one UAC
// prompt) for the work a normal process cannot do — manual installs,
// uninstalls, killing the elevated installer — and each of the three update
// runs asks for UAC once more, as it would for a real user: 4 prompts.

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PRODUCT = 'FrostTest';
const EXE = `${PRODUCT}.exe`;
const RUNONCE = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce';
const RESUME_VALUE = `${PRODUCT} update`;
const ALL = process.argv.includes('--allusers');
const INSTDIR = ALL
  ? path.join(process.env.ProgramW6432 || process.env.ProgramFiles, PRODUCT)
  : path.join(process.env.LOCALAPPDATA, 'Programs', PRODUCT);
const USERDATA = path.join(process.env.APPDATA, PRODUCT);
const MODE_FLAG = ALL ? '/allusers' : '/currentuser';

const [oldSetup, newSetup] = process.argv
  .slice(2)
  .filter((a) => !a.startsWith('--'))
  .map((p) => path.resolve(p));
if (process.platform !== 'win32' || !oldSetup || !newSetup) {
  console.error('usage (Windows): node tools/updatetest.js <old setup.exe> <new setup.exe> [--allusers]');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

// Output of a PowerShell one-liner; '' when it finds nothing (Get-Process with
// no match exits 1 even under SilentlyContinue)
function ps(cmd) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (e) {
    return String(e.stdout || '').trim();
  }
}

function regValue(key, name) {
  try {
    const out = execFileSync('reg.exe', ['query', key, '/v', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = out.split(/\r?\n/).find((l) => l.includes('REG_'));
    return line ? line.replace(/^.*?REG_\w+\s+/, '') : null;
  } catch {
    return null;
  }
}

function deleteRegValue(key, name) {
  try {
    execFileSync('reg.exe', ['delete', key, '/v', name, '/f'], { stdio: 'ignore' });
  } catch {}
}

// the uninstall entry the installer writes (HKLM for all users), by display name
function installedVersion() {
  const hive = ALL ? 'HKLM' : 'HKCU';
  return (
    ps(
      `(Get-ChildItem ${hive}:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall | Get-ItemProperty | ` +
        `? { $_.DisplayName -eq '${PRODUCT}' } | Select -First 1).DisplayVersion`
    ) || null
  );
}

function appComplete() {
  return ['v8_context_snapshot.bin', 'snapshot_blob.bin', 'resources\\app.asar', EXE].every((f) =>
    fs.existsSync(path.join(INSTDIR, f))
  );
}

// A whole command line, quotes as written (the RunOnce value is one too)
function start(cmdline) {
  return spawn(cmdline, [], { shell: true, windowsVerbatimArguments: true, stdio: 'ignore' });
}

function run(cmdline) {
  return new Promise((resolve) => start(cmdline).on('exit', resolve));
}

function killTree(pid) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {}
}

// --- elevated helper (--allusers) ---------------------------------------
// An elevated PowerShell that runs requests dropped into a folder: <n>.req
// holds a script block, <n>.done appears when it has run.
const HELPER_DIR = path.join(os.tmpdir(), `updatetest-${process.pid}`);
let reqN = 0;

async function startHelper() {
  fs.mkdirSync(HELPER_DIR, { recursive: true });
  const script = path.join(HELPER_DIR, 'helper.ps1');
  fs.writeFileSync(
    script,
    `$d = '${HELPER_DIR}'
New-Item "$d\\ready" -ItemType File -Force | Out-Null
while ($true) {
  foreach ($r in Get-ChildItem $d -Filter *.req | Sort-Object { [int]$_.BaseName }) {
    $body = Get-Content $r.FullName -Raw
    Remove-Item $r.FullName
    if ($body -eq 'exit') { exit }
    try { & ([scriptblock]::Create($body)) | Out-Null } catch {}
    New-Item "$d\\$($r.BaseName).done" -ItemType File -Force | Out-Null
  }
  Start-Sleep -Milliseconds 20
}
`
  );
  console.log('UAC: allow the test helper (1 of 4)');
  ps(`Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','"${script}"'`);
  for (let i = 0; i < 600 && !fs.existsSync(path.join(HELPER_DIR, 'ready')); i++) await sleep(500);
  if (!fs.existsSync(path.join(HELPER_DIR, 'ready'))) throw new Error('elevated helper did not start');
}

// Runs a PowerShell script block elevated; resolves once it has finished.
async function elevated(body, { wait = true } = {}) {
  const n = ++reqN;
  fs.writeFileSync(path.join(HELPER_DIR, `${n}.req`), body);
  if (!wait) return;
  const done = path.join(HELPER_DIR, `${n}.done`);
  while (!fs.existsSync(done)) await sleep(100);
}

function stopHelper() {
  if (!fs.existsSync(HELPER_DIR)) return;
  try {
    fs.writeFileSync(path.join(HELPER_DIR, `${++reqN}.req`), 'exit');
  } catch {}
}

// A manual install, as a person would run it (elevated already for all users)
async function manualInstall(setup) {
  if (ALL) await elevated(`Start-Process '${setup}' -ArgumentList '/S','/allusers' -Wait`);
  else await run(`"${setup}" /S`);
}

// --- app ------------------------------------------------------------------

// Starts the app and reports whether it is still alive with a window after a
// few seconds; an install missing its V8 snapshot exits at once.
async function appStarts() {
  const exe = path.join(INSTDIR, EXE);
  if (!fs.existsSync(exe)) return false;
  const p = spawn(exe, [], { detached: true, stdio: 'ignore' });
  p.unref();
  await sleep(7000);
  const title = ps(
    `(Get-Process ${PRODUCT} -ErrorAction SilentlyContinue | ? { $_.MainWindowHandle -ne 0 -and $_.Path -like '${INSTDIR}*' } | Select -First 1).MainWindowTitle`
  );
  stopApp();
  await sleep(1500);
  return title !== '';
}

function stopApp() {
  ps(
    `Get-Process ${PRODUCT} -ErrorAction SilentlyContinue | ? { $_.Path -like '${INSTDIR}*' } | Stop-Process -Force -ErrorAction SilentlyContinue`
  );
}

async function cleanup() {
  stopApp();
  deleteRegValue(RUNONCE, RESUME_VALUE);
  const uninstaller = path.join(INSTDIR, `Uninstall ${PRODUCT}.exe`);
  if (fs.existsSync(uninstaller)) {
    if (ALL) await elevated(`Start-Process '${uninstaller}' -ArgumentList '/S','/allusers' -Wait`);
    else await run(`"${uninstaller}" /S /currentuser`);
  }
  // NSIS uninstallers copy themselves to %TEMP% (Un_A.exe) and return at once;
  // the copy keeps working, and holding the folder, for a few seconds more
  for (let i = 0; i < 120; i++) {
    const busy = ps(
      `(Get-CimInstance Win32_Process -Filter "Name like 'Un_%'" | ? { $_.CommandLine -like '*${INSTDIR}*' }).ProcessId`
    );
    if (!busy) break;
    await sleep(500);
  }
  // a killed install can leave files the uninstaller does not know about
  if (ALL) await elevated(`Remove-Item '${INSTDIR}' -Recurse -Force -ErrorAction SilentlyContinue`);
  else fs.rmSync(INSTDIR, { recursive: true, force: true });
  fs.rmSync(USERDATA, { recursive: true, force: true });
}

async function main() {
  if (ALL) await startHelper();
  await cleanup();

  // 1. manual install
  await manualInstall(oldSetup);
  check(appComplete(), 'manual install: files in place', INSTDIR);
  check(regValue(RUNONCE, RESUME_VALUE) === null, 'manual install: no RunOnce retry left');
  const oldVersion = installedVersion();

  // 2. finished update
  if (ALL) console.log('UAC: allow the update (2 of 4)');
  await run(`"${newSetup}" /S --updated`);
  const newVersion = installedVersion();
  check(newVersion && newVersion !== oldVersion, 'update: new version installed', `${oldVersion} -> ${newVersion}`);
  check(appComplete(), 'update: files in place');
  check(regValue(RUNONCE, RESUME_VALUE) === null, 'update: RunOnce retry removed at the end');
  check(await appStarts(), 'update: app starts');

  // 3. update killed midway: back to the old version, then kill the new
  // installer the moment the old version's uninstall entry is gone, which is
  // after the old files are removed and before the new ones are all copied.
  await cleanup();
  await manualInstall(oldSetup);
  if (ALL) {
    // The elevated copy is out of this process's reach: the helper watches and
    // kills every installer process running from the new setup's path.
    await elevated(
      `$t0 = Get-Date
       while (((Get-Date) - $t0).TotalSeconds -lt 300) {
         $k = Get-ChildItem HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall | Get-ItemProperty | ? { $_.DisplayName -eq '${PRODUCT}' }
         $p = Get-CimInstance Win32_Process | ? { $_.ExecutablePath -eq '${newSetup}' }
         if (-not $k -and $p) { $p | % { Stop-Process -Id $_.ProcessId -Force }; break }
         Start-Sleep -Milliseconds 20
       }`,
      { wait: false }
    );
    console.log('UAC: allow the update that gets killed (3 of 4)');
  }
  const p = start(`"${newSetup}" /S --updated`);
  let sawRetry = false;
  let killed = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 300000) {
    if (regValue(RUNONCE, RESUME_VALUE)) sawRetry = true;
    if (sawRetry && !installedVersion()) {
      if (!ALL) killTree(p.pid);
      killed = true;
      break;
    }
    if (p.exitCode !== null) break;
    await sleep(25);
  }
  // all users: wait for the helper's kill to bring the outer installer down too
  for (let i = 0; i < 200 && p.exitCode === null; i++) await sleep(100);
  if (p.exitCode === null) killTree(p.pid);
  await sleep(1500);
  check(killed, 'killed update: installer stopped after the old version was removed');
  check(!appComplete(), 'killed update: install left broken (the original failure)');
  const retry = regValue(RUNONCE, RESUME_VALUE);
  check(!!retry, 'killed update: RunOnce retry still registered', retry || 'missing');
  check(
    !!retry && retry.includes(`/D=${INSTDIR}`) && retry.includes('--updated') && retry.includes(MODE_FLAG),
    'killed update: retry targets the same folder and install mode'
  );

  // 4. what Windows does at the next sign-in: delete the value, then run it
  // unelevated
  if (retry) {
    deleteRegValue(RUNONCE, RESUME_VALUE);
    if (ALL) console.log('UAC: allow the retry (4 of 4)');
    await run(retry);
    check(appComplete(), 'retry: files in place');
    check(installedVersion() === newVersion, 'retry: new version installed', installedVersion() || 'none');
    check(regValue(RUNONCE, RESUME_VALUE) === null, 'retry: RunOnce retry removed');
    check(await appStarts(), 'retry: app starts');
  }
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(async () => {
    try {
      await cleanup();
      check(!fs.existsSync(INSTDIR) && regValue(RUNONCE, RESUME_VALUE) === null, 'cleanup: FrostTest removed');
    } catch (e) {
      console.error(e);
      failures++;
    }
    stopHelper();
    console.log(failures ? `\n${failures} failed` : '\nall passed');
    process.exit(failures ? 1 : 0);
  });
