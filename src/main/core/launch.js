// Launch requests handed over by a second Frost process. Pure, unit-tested.

// What reaches a running Frost from a second launch. That launch parsed its own
// argv, against its own working directory, and passed the result along; the
// argv the running instance sees can be reordered or carry Chromium switches.
function cleanLaunch(data) {
  if (!data || typeof data !== 'object') return null;
  const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
  const launch = { dir: str(data.dir), run: str(data.run), profileId: str(data.profileId) };
  return launch.dir || launch.run ? launch : null;
}

Object.assign(module.exports, {
  cleanLaunch
});
