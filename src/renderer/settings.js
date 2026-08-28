// The settings panel, and the update section inside it.

// ---------- settings UI ----------

const s = {
  material: document.getElementById('s-material'),
  colorMode: document.getElementById('s-colormode'),
  glassBlur: document.getElementById('s-glass-blur'),
  readability: document.getElementById('s-readability'),
  readabilityVal: document.getElementById('s-readability-val'),
  glassBlurVal: document.getElementById('s-glass-blur-val'),
  contrast: document.getElementById('s-contrast'),
  gpu: document.getElementById('s-gpu'),
  defaultProfile: document.getElementById('s-profile'),
  restoreSession: document.getElementById('s-restore'),
  notifyBlocked: document.getElementById('s-notify-blocked'),
  notifyDone: document.getElementById('s-notify-done'),
  notifySeconds: document.getElementById('s-notify-seconds'),
  notifySecondsVal: document.getElementById('s-notify-seconds-val'),
  autoDetect: document.getElementById('s-autodetect'),
  copyOnSelect: document.getElementById('s-copyonselect'),
  pasteWarn: document.getElementById('s-paste-warn'),
  pasteWarnAgent: document.getElementById('s-paste-warn-agent'),
  ligatures: document.getElementById('s-ligatures'),
  startDir: document.getElementById('s-startdir'),
  editor: document.getElementById('s-editor'),
  tintColor: document.getElementById('s-tint-color'),
  tintAlpha: document.getElementById('s-tint-alpha'),
  tintAlphaVal: document.getElementById('s-tint-alpha-val'),
  accent: document.getElementById('s-accent'),
  fontFamily: document.getElementById('s-font-family'),
  fontSize: document.getElementById('s-font-size'),
  fontSizeVal: document.getElementById('s-font-size-val'),
  fontWeight: document.getElementById('s-font-weight'),
  fontWeightVal: document.getElementById('s-font-weight-val'),
  fg: document.getElementById('s-fg'),
  lineHeight: document.getElementById('s-line-height'),
  lineHeightVal: document.getElementById('s-line-height-val'),
  padding: document.getElementById('s-padding'),
  paddingVal: document.getElementById('s-padding-val'),
  radius: document.getElementById('s-radius'),
  radiusVal: document.getElementById('s-radius-val'),
  scrollback: document.getElementById('s-scrollback'),
  scrollbackVal: document.getElementById('s-scrollback-val'),
  cursorStyle: document.getElementById('s-cursor-style'),
  cursorBlink: document.getElementById('s-cursor-blink'),
  updateCheck: document.getElementById('s-update-check'),
  updateDownload: document.getElementById('s-update-download')
};

function toggleSettings() {
  el.settings.classList.toggle('open');
  const diag = document.getElementById('diag');
  if (el.settings.classList.contains('open') && diag) {
    const node = state.activeTab ? firstLeaf(state.activeTab.root) : null;
    diag.textContent = node
      ? `diag — renderer: ${node.webgl ? 'webgl' : 'dom'} · unicode: ${node.term.unicode.activeVersion} · ${node.term.cols}x${node.term.rows} · cwd: ${node.cwd || '(none reported)'} · branch: ${node.branch || '-'} · title: ${node.oscTitle || '-'}`
      : 'diag — no terminal';
  }
}

document.getElementById('btn-settings').addEventListener('click', toggleSettings);
document.getElementById('btn-settings-close').addEventListener('click', toggleSettings);
const btnNewTab = document.getElementById('btn-newtab');
btnNewTab.addEventListener('click', () => newTab());
btnNewTab.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  openProfileMenu(btnNewTab);
});
const btnNewTabMenu = document.getElementById('btn-newtab-menu');
btnNewTabMenu.addEventListener('click', () => openProfileMenu(btnNewTabMenu));
document.getElementById('btn-agents').addEventListener('click', () => newAgentTab());

function populateProfileSelect() {
  s.defaultProfile.replaceChildren(
    ...profiles.map((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      return o;
    })
  );
  if (state.theme?.defaultProfile) s.defaultProfile.value = state.theme.defaultProfile;
}
async function populateFontList() {
  const families = await api.fontsList();
  const ctx = document.createElement('canvas').getContext('2d');
  const isMono = (f) => {
    ctx.font = `16px "${f}"`;
    return Math.abs(ctx.measureText('iiiiii').width - ctx.measureText('WWWWWW').width) < 0.5;
  };
  const monos = families.filter(isMono);
  const current = s.fontFamily.value;
  s.fontFamily.replaceChildren(
    ...monos.map((f) => {
      const o = document.createElement('option');
      o.value = f;
      o.textContent = f;
      return o;
    })
  );
  if (current && !monos.includes(current)) {
    const o = document.createElement('option');
    o.value = current;
    o.textContent = current;
    s.fontFamily.prepend(o);
  }
  if (current) s.fontFamily.value = current;
}

document.getElementById('s-startdir-browse').addEventListener('click', async () => {
  const dir = await api.pickDir();
  if (dir) {
    s.startDir.value = dir;
    onSettingChange();
  }
});
document.getElementById('btn-open-theme').addEventListener('click', () => api.themeOpenFile('json'));
document.getElementById('btn-open-css').addEventListener('click', () => api.themeOpenFile('css'));
document.getElementById('btn-open-keys').addEventListener('click', () => api.themeOpenFile('keys'));

function parseTint(tint) {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\)/.exec(tint || '');
  if (!m) return { hex: '#0a0c14', alpha: 0.55 };
  const hex =
    '#' + [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, '0')).join('');
  return { hex, alpha: m[4] !== undefined ? +m[4] : 1 };
}

function hexToRgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

let syncing = false;

function syncSettingsUI() {
  const t = state.theme;
  if (!t) return;
  syncing = true;
  const tint = parseTint(t.tint);
  s.material.value = t.material || 'acrylic';
  s.colorMode.value = t.colorMode || 'dark';
  s.glassBlur.value = t.glassBlur ?? 40;
  s.glassBlurVal.textContent = (t.glassBlur ?? 40) + 'px';
  const readability = Math.round((t.glassReadability ?? 0.3) * 100);
  s.readability.value = readability;
  s.readabilityVal.textContent = readability + '%';
  s.contrast.value = String(t.minContrast ?? 1);
  if (profiles.length) s.defaultProfile.value = t.defaultProfile || profiles[0].id;
  s.gpu.checked = t.gpuRenderer === true;
  s.restoreSession.checked = t.restoreSession !== false;
  const notify = t.notify || {};
  s.notifyBlocked.checked = notify.agentBlocked !== false;
  s.notifyDone.checked = notify.agentDone !== false;
  const secs = notify.commandSeconds ?? 20;
  s.notifySeconds.value = secs;
  s.notifySecondsVal.textContent = secs ? secs + 's' : 'Off';
  s.autoDetect.checked = t.autoDetectAgents !== false;
  s.copyOnSelect.checked = t.copyOnSelect !== false;
  s.pasteWarn.checked = t.paste?.warnMultiline !== false;
  s.pasteWarnAgent.checked = t.paste?.warnInAgent === true;
  s.ligatures.checked = t.font?.ligatures !== false;
  s.startDir.value = t.startDir || '';
  s.editor.value = t.editor || '';
  s.tintColor.value = tint.hex;
  s.tintAlpha.value = Math.round(tint.alpha * 100);
  s.tintAlphaVal.textContent = Math.round(tint.alpha * 100) + '%';
  s.accent.value = t.accent || '#7aa2f7';
  const fam = (t.font?.family || '').split(',')[0].replace(/"/g, '').trim();
  if (fam && ![...s.fontFamily.options].some((o) => o.value === fam)) {
    const o = document.createElement('option');
    o.value = fam;
    o.textContent = fam;
    s.fontFamily.prepend(o);
  }
  s.fontFamily.value = fam;
  s.fontSize.value = t.font?.size || 16;
  s.fontSizeVal.textContent = (t.font?.size || 16) + 'px';
  s.fontWeight.value = t.font?.weight ?? 350;
  s.fontWeightVal.textContent = String(t.font?.weight ?? 350);
  s.fg.value = t.terminal?.foreground || '#ffffff';
  s.lineHeight.value = t.font?.lineHeight ?? 1.15;
  s.lineHeightVal.textContent = String(t.font?.lineHeight ?? 1.15);
  s.padding.value = t.padding ?? 14;
  s.paddingVal.textContent = (t.padding ?? 14) + 'px';
  s.radius.value = t.cornerRadius ?? 8;
  s.radiusVal.textContent = (t.cornerRadius ?? 8) + 'px';
  const scrollback = scrollbackFor(t);
  s.scrollback.value = scrollback;
  s.scrollbackVal.textContent = scrollback.toLocaleString() + ' lines';
  s.cursorStyle.value = t.cursor?.style || 'bar';
  s.cursorBlink.checked = t.cursor?.blink !== false;
  s.updateCheck.checked = t.update?.check !== false;
  s.updateDownload.checked = t.update?.download !== false;
  s.updateDownload.disabled = !s.updateCheck.checked;
  syncing = false;
}

const saveTheme = debounce(() => {
  if (state.theme) api.themeSave(state.theme);
}, 200);

function onSettingChange() {
  if (syncing || !state.theme) return;
  const t = state.theme;
  const [r, g, b] = hexToRgb(s.tintColor.value);
  const alpha = (+s.tintAlpha.value / 100).toFixed(2);
  t.material = s.material.value;
  t.colorMode = s.colorMode.value;
  t.glassBlur = +s.glassBlur.value;
  t.glassReadability = +s.readability.value / 100;
  t.minContrast = parseFloat(s.contrast.value);
  if (s.defaultProfile.value) t.defaultProfile = s.defaultProfile.value;
  t.gpuRenderer = s.gpu.checked;
  t.restoreSession = s.restoreSession.checked;
  t.notify = {
    agentBlocked: s.notifyBlocked.checked,
    agentDone: s.notifyDone.checked,
    commandSeconds: +s.notifySeconds.value
  };
  t.autoDetectAgents = s.autoDetect.checked;
  t.copyOnSelect = s.copyOnSelect.checked;
  t.paste = {
    ...(t.paste || {}),
    warnMultiline: s.pasteWarn.checked,
    warnInAgent: s.pasteWarnAgent.checked
  };
  t.startDir = s.startDir.value.trim();
  t.editor = s.editor.value.trim();
  t.tint = `rgba(${r}, ${g}, ${b}, ${alpha})`;
  t.accent = s.accent.value;
  t.font = t.font || {};
  if (s.fontFamily.value) t.font.family = `"${s.fontFamily.value}", Consolas, monospace`;
  t.font.size = +s.fontSize.value;
  t.font.ligatures = s.ligatures.checked;
  t.font.weight = +s.fontWeight.value;
  t.font.lineHeight = +s.lineHeight.value;
  t.terminal = t.terminal || {};
  t.terminal.foreground = s.fg.value;
  t.padding = +s.padding.value;
  t.cornerRadius = +s.radius.value;
  t.scrollback = scrollbackFor({ scrollback: +s.scrollback.value });
  t.cursor = t.cursor || {};
  t.cursor.style = s.cursorStyle.value;
  t.cursor.blink = s.cursorBlink.checked;
  // Background downloads are a sub-setting of checking at all: with checks off
  // nothing is ever found to download, so the toggle would claim to do something
  t.update = { check: s.updateCheck.checked, download: s.updateDownload.checked };
  s.updateDownload.disabled = !s.updateCheck.checked;
  applyTheme(t, undefined);
  saveTheme();
  saveSession(); // toggling restore off clears the stored layout
}

for (const input of Object.values(s)) {
  if (input && input.tagName) {
    input.addEventListener('input', onSettingChange);
    input.addEventListener('change', onSettingChange);
  }
}

// ---------- updates ----------
// Main does the checking; this reads its one state object out loud. The action
// button is the same button throughout — Download, then Restart and install —
// because at any moment there is exactly one thing to do next, and a row of
// buttons where three are dead is harder to read than one that changes.

const RELEASES_URL = 'https://github.com/azekyoo/frost/releases';

const upd = {
  current: document.getElementById('s-update-current'),
  latest: document.getElementById('s-update-latest'),
  status: document.getElementById('s-update-status'),
  box: document.querySelector('.update-box'),
  check: document.getElementById('btn-update-check'),
  act: document.getElementById('btn-update-act'),
  releases: document.getElementById('btn-update-releases')
};

let updateState = null;

function renderUpdate(st) {
  if (!st || !upd.current) return;
  const known = st.latest && st.stage !== 'checking';
  upd.current.textContent = st.version || '—';
  upd.latest.textContent = known ? st.latest : st.stage === 'checking' ? 'checking…' : '—';
  upd.box.style.setProperty('--update-progress', (st.stage === 'downloading' ? st.percent : 0) + '%');

  const text = {
    idle: 'Not checked yet this run.',
    checking: 'Asking GitHub for the latest release…',
    current: 'Frost is up to date.',
    available: st.autoDownload
      ? `Frost ${st.latest} is available.`
      : `Frost ${st.latest} is available — automatic downloads are off.`,
    downloading: `Downloading Frost ${st.latest || ''} — ${st.percent}%`,
    ready: `Frost ${st.latest} is ready. It installs when you quit, or now if you like.`,
    error: st.message || 'The check failed.',
    unsupported: st.message
  }[st.stage];
  upd.status.textContent = text || '';
  upd.status.className = 'update-status ' + st.stage;

  upd.check.disabled = st.stage === 'checking' || st.stage === 'downloading' || st.stage === 'unsupported';
  const action =
    st.stage === 'ready'
      ? { label: 'Restart and install', run: () => api.updateInstall() }
      : st.stage === 'available' && !st.autoDownload
        ? { label: `Download ${st.latest}`, run: () => api.updateDownload() }
        : null;
  upd.act.hidden = !action;
  if (action) {
    upd.act.textContent = action.label;
    upd.act.onclick = action.run;
  }
}

upd.check?.addEventListener('click', async () => {
  renderUpdate({ ...(updateState || {}), stage: 'checking' });
  updateState = await api.updateCheck();
  renderUpdate(updateState);
});
upd.releases?.addEventListener('click', () => api.openExternal(RELEASES_URL));

api.onUpdateState((st) => {
  const before = updateState?.stage;
  updateState = st;
  renderUpdate(st);
  // One line, once per transition, and only for the two that are news. A check
  // that finds nothing is the normal case and says so in the panel, not on screen.
  if (st.stage === 'ready' && before !== 'ready')
    toast(`Frost ${st.latest} downloaded — it installs when you quit.`, { ms: 8000 });
  else if (st.stage === 'available' && before !== 'available' && !st.autoDownload)
    toast(`Frost ${st.latest} is available — download it in settings.`, { ms: 8000 });
});

api.updateGet().then((st) => {
  updateState = st;
  renderUpdate(st);
});
