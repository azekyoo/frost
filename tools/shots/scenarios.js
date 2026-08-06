'use strict';

// What each screenshot shows.
//
// `setup` runs inside the real renderer over the debugging protocol, so these
// drive the actual app: commands go through a real pty and the output is real
// program output. Nothing here is mocked, which is the point — a faked
// screenshot drifts from the app the moment the app changes.
//
// renderer.js is a classic script, so its top-level bindings (state, api,
// runCommand, ...) are reachable by name from an evaluated expression.

const RUN = `
// A pane reports its cwd on every prompt, so a pane with a cwd is a pane whose
// shell is ready for input. Waiting on that beats sleeping a guessed interval.
const ready = async (timeout = 20000) => {
  const until = Date.now() + timeout;
  for (;;) {
    const pane = state.activeTab && state.activeTab.activePane;
    if (pane && pane.ptyId && pane.cwd) return pane;
    if (Date.now() > until) throw new Error('pane never reached a prompt');
    await new Promise((r) => setTimeout(r, 100));
  }
};
const type = async (text, settle = 700) => {
  const pane = await ready();
  api.ptyInput(pane.ptyId, text + '\\r');
  await new Promise((r) => setTimeout(r, settle));
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
`;

module.exports = [
  {
    name: 'screenshot-hero',
    wallpaper: 'alpine',
    // two shells side by side, real git and real program output
    setup: `(async () => {
      ${RUN}
      await type('git log --oneline --graph -5');
      await type('node src/index.js');
      await type('node src/index.js errands');
      runCommand('pane.splitRight');
      await ready();
      await type('git status --short --branch');
      await type('git diff --stat');
      await type('cat package.json');
      runCommand('pane.focusLeft');
      await type('node src/index.js frost');
      await type('ls');
      await pause(400);
    })()`
  },
  {
    name: 'screenshot-palette',
    wallpaper: 'night',
    setup: `(async () => {
      ${RUN}
      await type('git log --oneline -6');
      await type('node src/index.js');
      await type('node src/index.js books');
      await type('git diff --stat');
      openPalette();
      el.paletteInput.value = 'pane';
      renderPalette();
      await pause(300);
    })()`
  },
  {
    name: 'screenshot-profiles',
    wallpaper: 'coast',
    setup: `(async () => {
      ${RUN}
      await type('node src/index.js');
      await type('node src/index.js travel');
      // a second tab so the strip shows two titles, both "dir · branch"
      await newTab();
      await ready();
      await type('git log --oneline --graph -4');
      await type('node src/index.js food');
      openProfileMenu(document.getElementById('btn-newtab-menu'));
      await pause(300);
    })()`
  },
  {
    name: 'screenshot-options',
    wallpaper: 'desert',
    setup: `(async () => {
      ${RUN}
      await type('git log --oneline -4');
      await type('node src/index.js pin "grocery list"');
      await type('node src/index.js errands');
      toggleSettings();
      await pause(400);
    })()`
  }
];
