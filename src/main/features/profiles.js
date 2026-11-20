const { ipcMain } = require('electron');
const fs = require('fs');

const { detectProfiles, homeDir } = require('../platform');
const { readTheme } = require('./config');

function getProfiles() {
  const t = readTheme();
  return Array.isArray(t?.profiles) && t.profiles.length ? t.profiles : detectProfiles();
}

function findProfile(id) {
  const list = getProfiles();
  const def = readTheme()?.defaultProfile;
  return list.find((p) => p.id === id) || list.find((p) => p.id === def) || list[0];
}

function startDir() {
  const d = readTheme()?.startDir;
  if (d && fs.existsSync(d)) return d;
  return homeDir() || process.cwd();
}

// The folder a shell of this profile starts in, asked for or not.
function shellCwd(profile, cwd) {
  return (
    (cwd && fs.existsSync(cwd) && cwd) ||
    (profile.cwd && fs.existsSync(profile.cwd) && profile.cwd) ||
    startDir()
  );
}

ipcMain.handle('profiles:list', () =>
  getProfiles().map(({ id, name, agentWrapper }) => ({ id, name, agentWrapper: agentWrapper || 'none' }))
);

Object.assign(module.exports, {
  getProfiles,
  findProfile,
  startDir,
  shellCwd
});
