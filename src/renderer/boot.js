// The wallpaper behind a glass window, the output arriving from every shell,
// and the sequence that starts all of it. Loaded last: this is the file that
// makes the window a terminal.

// ---------- glass background ----------

function updateGlassPos({ bounds, display, maximized }) {
  if (bounds) glassState.bounds = bounds;
  if (display) glassState.display = display;
  const b = glassState.bounds;
  const d = glassState.display;
  if (!b || !d) return;
  // Screen geometry arrives in unzoomed device-independent pixels; a zoomed page
  // measures itself in smaller CSS pixels, so the wallpaper has to be divided
  // down or it drifts out of alignment with the desktop behind the window.
  const z = uiZoom || 1;
  // #glass-bg is inset -80px, so shift the wallpaper by +80 to stay screen-aligned
  el.glassBg.style.backgroundSize = `${d.width / z}px ${d.height / z}px`;
  el.glassBg.style.backgroundPosition = `${(d.x - b.x) / z + 80}px ${(d.y - b.y) / z + 80}px`;
}

async function initGlass() {
  const info = await api.glassInfo();
  if (!info.wallpaper) {
    toast('Glass mode: could not read wallpaper — tint only');
    return;
  }
  el.glassBg.style.backgroundImage = `url("${info.wallpaper}")`;
  updateGlassPos(info);
  api.onWinBounds(updateGlassPos);
}

// A drop that misses a pane has to do nothing. Chromium's default is to
// navigate the window to the dropped file, which would take every shell in the
// window with it; will-navigate in main already refuses that, and this keeps it
// from being asked in the first place.
window.addEventListener('dragover', (ev) => ev.preventDefault());
window.addEventListener('drop', (ev) => ev.preventDefault());

api.onZoom(({ factor }) => {
  uiZoom = factor || 1;
  // The resize gutters are a hit target for the mouse, not part of the UI, so
  // they stay the same physical width whatever the page is zoomed to.
  document.documentElement.style.setProperty('--ui-zoom', String(uiZoom));
  // the wallpaper has no observer to refit it, and the glyph atlas is stale the
  // instant the zoom lands — the pixel ratio it was drawn for no longer applies
  updateGlassPos({});
  resharpen();
});

// ---------- pty events ----------

api.onPtyData(({ id, data }) => {
  panesByPty.get(id)?.term.write(data);
});

api.onPtyExit(({ id }) => {
  const agent = agentsByPty.get(id);
  if (agent) {
    agentsByPty.delete(id);
    globalAgents.delete(agent.id);
    for (const tab of agentTabs()) {
      if (tab.selected === agent.id) tab.selected = null;
      if (tab.diffKey === 'agent:' + agent.id) tab.diffKey = null;
    }
    renderAgentLists();
    refreshWorktrees();
  }
  const node = panesByPty.get(id);
  if (!node) return;
  // panes hosted in an agent-tab center stay as frozen output; others close
  const inAgentCenter = agentTabs().some((t) => t.centerLeaves.has(node));
  if (inAgentCenter) return;
  panesByPty.delete(id);
  removePane(node, { killPty: false });
});

api.onThemeChanged(async ({ theme, css, error }) => {
  if (error) {
    toast(error, { error: true });
    return;
  }
  // profiles live in theme.json, so an edit there can add/remove shells
  profiles = await api.profilesList();
  applyTheme(theme, css);
  populateProfileSelect();
});

// ---------- boot ----------

document.getElementById('btn-min').addEventListener('click', () => api.winMinimize());
document.getElementById('btn-max').addEventListener('click', () => api.winMaximize());
document.getElementById('btn-close').addEventListener('click', () => api.winClose());

(async () => {
  const { theme, css, frameless, home, openDir } = await api.themeGet();
  state.home = home || null;
  glassState.active = Boolean(frameless);
  if (frameless) {
    document.body.classList.add('frameless');
    await initGlass();
  }
  profiles = await api.profilesList();
  bootFontSize = theme.font?.size || 14; // what Ctrl+0 returns to
  buildKeymap(await api.keysGet());
  applyTheme(theme, css);
  populateProfileSelect();
  populateFontList();

  // Wait for the terminal font before opening the first terminal — opening with
  // a fallback font bakes wrong glyph metrics into the renderer atlas (garbled
  // emoji and status lines until a manual reset). Only that one face, and not
  // for long: document.fonts.ready waits for every font the document will ever
  // load, which on this page meant the first shell was not even asked for until
  // a second after the window appeared. The atlas is refreshed again below once
  // everything has settled, which is what makes a short wait safe.
  try {
    const face = document.fonts.load(`${theme.font?.size || 14}px ${theme.font?.family || 'monospace'}`);
    await Promise.race([face, new Promise((r) => setTimeout(r, 400))]);
  } catch {}

  // A window opened to receive a tab dragged out of another one: it exists for
  // that tab, so neither a saved layout nor a start directory applies.
  const moved = await api.tabPending();
  if (moved) {
    await adoptTab(moved);
  } else if (openDir) {
    // launched as `frost <dir>` or from "Open Frost here": that directory is the
    // whole point of the launch, so it wins over the saved layout
    await newTab({ cwd: openDir });
  } else {
    const session = theme.restoreSession === false ? null : await api.sessionGet();
    const restored = session?.tabs?.length ? await restoreTabs(session) : false;
    if (!restored) await newTab();
  }

  api.onOpenDir((dir) => newTab({ cwd: dir }));

  // Belt and braces: one atlas rebuild after boot in case a font swapped late
  setTimeout(() => {
    for (const node of panesByPty.values()) {
      try {
        node.webgl?.clearTextureAtlas();
        node.term.refresh(0, node.term.rows - 1);
      } catch {}
    }
  }, 1500);

  // Write renderer diagnostics to config/diag.json (debugging aid)
  setTimeout(() => {
    try {
      const node = state.activeTab ? firstLeaf(state.activeTab.root) : null;
      const report = {
        when: new Date().toISOString(),
        unicodeActive: node ? node.term.unicode.activeVersion : null,
        unicodeRegistered: node ? node.term.unicode.versions : null,
        unicodeError: window.__unicodeError || null,
        renderer: node ? (node.webgl ? 'webgl' : 'dom') : null,
        cols: node?.term.cols,
        rows: node?.term.rows,
        themeUnicodeVersion: state.theme?.unicodeVersion || null,
        wideTest: null
      };

      // probe: write "🚦 X" into a hidden terminal, inspect cell layout
      const probe = new Terminal({ allowProposedApi: true });
      try {
        probe.loadAddon(new Unicode11Addon.Unicode11Addon());
        probe.unicode.activeVersion = state.theme?.unicodeVersion || '11';
      } catch (e) {
        report.probeUnicodeError = String(e);
      }
      const div = document.createElement('div');
      div.style.cssText = 'position:absolute;left:-9999px;top:0;width:400px;height:120px;';
      document.body.appendChild(div);
      probe.open(div);
      probe.write('\u{1F6A6} X', () => {
        const line = probe.buffer.active.getLine(0);
        const cells = [];
        for (let i = 0; i < 6; i++) {
          const c = line.getCell(i);
          cells.push({ i, ch: c ? c.getChars() : null, w: c ? c.getWidth() : null });
        }
        report.wideTest = cells;
        api.diagReport(report);
        probe.dispose();
        div.remove();
      });
    } catch (e) {
      api.diagReport({ diagError: String(e) });
    }
  }, 2500);
})();
