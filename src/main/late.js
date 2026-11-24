// The feature modules call one another in cycles (a window's close tidies up
// shells; a moved tab opens a window), so a function from another module is not
// looked up when this file is required — that module may still be loading — but
// each time it is called. Each wrapper carries the real function's name, which
// is what stalls.log quotes when one is slow.
function late(mod, names) {
  const out = {};
  for (const name of names) {
    out[name] = (...args) => mod[name](...args);
    Object.defineProperty(out[name], 'name', { value: name });
  }
  return out;
}

module.exports = { late };
