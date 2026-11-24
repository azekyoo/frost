// Unit tests for src/main/core: the main process's pure logic. They pin down
// what the code does today, so a refactor or a port that changes it shows up
// here instead of as a window opening in the wrong place.
// Run: npm run test:core
const test = require('node:test');
const assert = require('node:assert/strict');

const { zoomSteps, displayKeyOf, scaleBoundsTo, ZOOM_MIN, ZOOM_MAX } = require('../src/main/core/geometry');
const { effectiveStatus, runsClaude, jsonLines } = require('../src/main/core/agents');
const { unquotePath, treeStatus } = require('../src/main/core/git');
const { cmpVersion } = require('../src/main/core/version');
const { cleanLaunch } = require('../src/main/core/launch');

test('zoom steps land on whole or half device pixels', () => {
  assert.deepEqual(zoomSteps(1), [1, 1.5, 2, 2.5, 3]);
  assert.deepEqual(zoomSteps(2), [0.5, 0.75, 1, 1.25, 1.5, 2]);
  assert.deepEqual(zoomSteps(1.5), [1 / 1.5, 1, 2 / 1.5, 2.5 / 1.5, 2, 4 / 1.5]);
  for (const sf of [1, 1.25, 1.5, 1.75, 2, 2.5, 3]) {
    const steps = zoomSteps(sf);
    assert.ok(steps.length > 0);
    for (const z of steps) assert.ok(z >= ZOOM_MIN - 1e-6 && z <= ZOOM_MAX + 1e-6);
  }
  // no scale factor reported: treated as 1
  assert.deepEqual(zoomSteps(0), zoomSteps(1));
});

test('a display is keyed by resolution and scale, not by id', () => {
  assert.equal(displayKeyOf({ id: 7, size: { width: 2560, height: 1440 }, scaleFactor: 1.5 }), '2560x1440@1.5');
});

test('saved bounds are re-proportioned onto a screen of another size', () => {
  const laptop = { x: 0, y: 0, width: 1600, height: 900 };
  const big = { x: 1600, y: 0, width: 3200, height: 1800 };
  assert.deepEqual(scaleBoundsTo({ x: 400, y: 225, width: 800, height: 450 }, laptop, big), {
    width: 1600,
    height: 900,
    x: 2400,
    y: 450
  });
  // never below the minimum window size, never off the target screen
  const tiny = scaleBoundsTo({ x: 1500, y: 850, width: 100, height: 50 }, laptop, laptop);
  assert.deepEqual(tiny, { width: 480, height: 300, x: 1120, y: 600 });
  // nothing to scale from
  assert.equal(scaleBoundsTo({ x: 0, y: 0, width: 1, height: 1 }, null, big), null);
  assert.equal(scaleBoundsTo(null, laptop, big), null);
  assert.equal(scaleBoundsTo({ x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 9 }, big), null);
});

test('agent status: hooks win over the output heuristic', () => {
  const now = Date.now();
  assert.equal(effectiveStatus({ exited: true, hook: 'working', lastData: now }), 'exited');
  assert.equal(effectiveStatus({ hook: 'blocked', hookT: now, lastInput: now - 10, lastData: now }), 'blocked');
  // typed after it blocked: working again
  assert.equal(effectiveStatus({ hook: 'blocked', hookT: now - 10, lastInput: now, lastData: now }), 'working');
  assert.equal(effectiveStatus({ hook: 'working', lastData: now }), 'working');
  // a session that died without a Stop hook goes idle after a minute of silence
  assert.equal(effectiveStatus({ hook: 'working', lastData: now - 61000 }), 'idle');
  assert.equal(effectiveStatus({ hook: 'done', lastData: now }), 'done');
});

test('agent status without hooks needs sustained, recent output', () => {
  const now = Date.now();
  assert.equal(effectiveStatus({ lastData: now, busySince: now - 1000 }), 'working');
  // a single repaint is not work
  assert.equal(effectiveStatus({ lastData: now, busySince: now }), 'idle');
  assert.equal(effectiveStatus({ lastData: now }), 'idle');
  // flowing, but not lately
  assert.equal(effectiveStatus({ lastData: now - 3000, busySince: now - 5000 }), 'idle');
});

test('only a command that starts claude holds typed keys for its prompt', () => {
  for (const run of ['claude', 'claude --resume abc', '  claude.exe -c', 'CLAUDE.cmd', 'claude\t--x']) {
    assert.equal(runsClaude(run), true, run);
  }
  for (const run of ['git status', 'claudex', 'npx claude', 'echo claude', '']) {
    assert.equal(runsClaude(run), false, run);
  }
});

test('JSONL transcript slices: whole lines parsed, cut ends skipped', () => {
  const text = 'ype":"cut"}\n{"a":1}\n\n{"b":[2]}\n{"broken":\nnot json\n{"c":3';
  assert.deepEqual(jsonLines(text), [{ a: 1 }, { b: [2] }]);
});

test('git quoted paths are unquoted, octal escapes as UTF-8', () => {
  assert.equal(unquotePath('plain/file.txt'), 'plain/file.txt');
  assert.equal(unquotePath('"with space.txt"'), 'with space.txt');
  assert.equal(unquotePath('"tab\\there"'), 'tab\there');
  assert.equal(unquotePath('"q\\"uote"'), 'q"uote');
  assert.equal(unquotePath('"back\\\\slash"'), 'back\\slash');
  assert.equal(unquotePath('"\\351\\237\\263.txt"'), '音.txt');
  // only fully quoted strings are touched
  assert.equal(unquotePath('"half'), '"half');
});

test('porcelain status becomes one badge letter per path', () => {
  const out = ['?? new.txt', 'A  staged.js', ' M changed.css', 'D  gone.md', 'R  renamed.js', 'old-name.js', 'MM both.ts', ''].join('\0');
  assert.deepEqual(treeStatus(out), {
    'new.txt': 'U',
    'staged.js': 'A',
    'changed.css': 'M',
    'gone.md': 'D',
    'renamed.js': 'M',
    'both.ts': 'M'
  });
  assert.deepEqual(treeStatus(''), {});
});

test('versions compare by major, minor, patch', () => {
  assert.ok(cmpVersion('2.11.0', '2.10.9') > 0);
  assert.ok(cmpVersion('2.9.0', '2.10.0') < 0);
  assert.equal(cmpVersion('2.11.0', '2.11.0'), 0);
  assert.equal(cmpVersion('2.11.0-beta.1', '2.11.0'), 0);
  assert.ok(cmpVersion('3', '2.99.99') > 0);
});

test('a second launch hands over only a folder, a command or a profile', () => {
  assert.equal(cleanLaunch(null), null);
  assert.equal(cleanLaunch('C:\\x'), null);
  assert.equal(cleanLaunch({ profileId: 'pwsh' }), null);
  assert.deepEqual(cleanLaunch({ dir: 'C:\\code', run: '  ', profileId: 'pwsh', extra: 1 }), {
    dir: 'C:\\code',
    run: null,
    profileId: 'pwsh'
  });
  assert.deepEqual(cleanLaunch({ run: 'claude --resume x', dir: 5 }), { dir: null, run: 'claude --resume x', profileId: null });
});
