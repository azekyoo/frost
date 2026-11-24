// Reading what git prints: quoted paths, porcelain status. Pure, unit-tested.

function unquotePath(p) {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const esc = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  const body = Buffer.from(p.slice(1, -1), 'utf8');
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== 92) {
      bytes.push(body[i]);
      continue;
    }
    const c = String.fromCharCode(body[i + 1]);
    if (/[0-7]/.test(c)) {
      bytes.push(parseInt(body.toString('latin1', i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(esc[c] ?? body[i + 1]);
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// porcelain XY -> one letter, as editors badge files: U new, A staged new,
// D deleted, M anything else changed
function treeStatus(stdout) {
  const status = {};
  const parts = stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    // a rename or copy is followed by the path it came from
    if (xy[0] === 'R' || xy[0] === 'C') i++;
    status[entry.slice(3)] =
      xy === '??' ? 'U' : xy.includes('D') ? 'D' : xy[0] === 'A' ? 'A' : 'M';
  }
  return status;
}

Object.assign(module.exports, {
  unquotePath,
  treeStatus
});
