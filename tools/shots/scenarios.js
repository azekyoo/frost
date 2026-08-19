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
// Returns whether the condition was met, rather than throwing: an agent
// scenario should still produce a screenshot of whatever state it did reach.
const waitFor = async (fn, timeout = 30000, step = 250) => {
  const until = Date.now() + timeout;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, step));
  }
};
`;

module.exports = [
  {
    name: 'screenshot-hero',
    photo: 'peaks-sunrise',
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
    photo: 'moonrise-peak',
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
    photo: 'aurora',
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
    // The flagship shot, and the one that can't be faked: agent mode is only
    // itself with a real Claude Code session in the middle of it, reporting real
    // status and producing a real diff. So this runs `claude` for real and asks
    // it for a small edit in the demo repo.
    name: 'screenshot-agent',
    photo: 'ocean-dusk',
    wallpaper: 'pine',
    spaces: true,
    theme: { autoDetectAgents: true },
    setup: `(async () => {
      ${RUN}
      await newAgentTab();
      const leaf = [...state.activeTab.centerLeaves][0];
      await waitFor(() => leaf.cwd, 20000);

      // Auto-detect registers the agent when the session-local wrapper sees
      // claude launch, so simply running it is the whole handshake.
      api.ptyInput(leaf.ptyId, 'claude\\r');
      await waitFor(() => globalAgents.size > 0, 90000);
      await pause(7000); // let claude finish drawing its banner and prompt

      // Resting on a status isn't enough — the agent rests between turns too.
      // Wait for it to hold a resting status for a few seconds instead.
      const settled = async (timeout) => {
        const until = Date.now() + timeout;
        let since = 0;
        for (;;) {
          const agent = [...globalAgents.values()][0];
          const resting = agent && ['done', 'blocked', 'idle'].includes(agent.status);
          if (!resting) since = 0;
          else if (!since) since = Date.now();
          else if (Date.now() - since > 5000) return true;
          if (Date.now() > until) return false;
          await pause(400);
        }
      };
      const ask = async (prompt, timeout = 180000) => {
        api.ptyInput(leaf.ptyId, prompt + '\\r');
        await pause(3500); // let the submit land before watching for a rest
        return settled(timeout);
      };

      // Whatever is on the visible rows of the agent's terminal, which the
      // renderer checks for Claude's banner before writing any image.
      const onScreen = () => {
        const buf = leaf.term.buffer.active;
        let out = '';
        for (let i = 0; i < leaf.term.rows; i++) {
          const line = buf.getLine(buf.viewportY + i);
          if (line) out += line.translateToString(true) + '\\n';
        }
        return out;
      };
      const bannerVisible = () =>
        /Welcome back|Claude Team|Tips for getting started|release-notes for more/i.test(onScreen());

      await ask('Read README.md and src/search.js, then tell me in two lines what this project does.');
      await pause(1500);
      await ask('Document the pin and unpin commands in README.md under a new "Commands" heading.');
      await pause(2500);

      // The banner sits in the scrollback until enough output pushes it off the
      // top. Keep giving the agent real work until it's gone.
      const fillers = [
        'List the files in src/ with a one-line description of each.',
        'What does the pinned-first sort order do to search results?'
      ];
      for (const filler of fillers) {
        if (!bannerVisible()) break;
        await ask(filler);
        await pause(1500);
      }

      leaf.term.scrollToBottom();
      await pause(600);
      return onScreen();
    })()`
  },
  {
    name: 'screenshot-options',
    photo: 'desert-arch',
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
