// xterm.js's WebGL renderer discards the alpha of a cell's background colour:
// RectangleRenderer hard-codes the rectangle's alpha to 1. With a fully
// transparent theme background — which Frost uses so the glass shows through —
// any cell carrying an attribute that lives in the bg field (italic and dim
// both do) gets a background rectangle painted opaque black. PSReadLine's
// inline prediction is dim + italic, so it renders inside a black box.
//
// The fix takes the alpha from the colour instead. The two true-colour branches
// build their value by shifting RGB up eight bits, leaving the alpha byte at 0,
// so those have to be given a solid alpha first or every 24-bit background
// would turn transparent instead.
//
// Runs from postinstall. Idempotent, and exits non-zero if the bundle no longer
// looks like this, so an upgrade fails visibly rather than silently reverting.
const fs = require('fs');
const path = require('path');

const FILE = path.join(
  __dirname,
  '..',
  'node_modules',
  '@xterm',
  'addon-webgl',
  'lib',
  'addon-webgl.js'
);

const EDITS = [
  ['h=(16777215&i)<<8', 'h=(16777215&i)<<8|255'],
  ['h=(16777215&s)<<8', 'h=(16777215&s)<<8|255'],
  ['g=1,this._addRectangle', 'g=(255&h)/255,this._addRectangle']
];

if (!fs.existsSync(FILE)) {
  // A production install without dev dependencies has no addon to patch.
  process.exit(0);
}

let src = fs.readFileSync(FILE, 'utf8');
let applied = 0;

for (const [from, to] of EDITS) {
  if (src.includes(to)) continue; // already patched
  if (src.split(from).length - 1 !== 1) {
    console.error(`patch-xterm-alpha: expected exactly one "${from}" in addon-webgl.js.`);
    console.error('The bundle changed shape — check whether the upstream bug is fixed:');
    console.error('https://github.com/xtermjs/xterm.js/blob/master/addons/addon-webgl/src/RectangleRenderer.ts');
    process.exit(1);
  }
  src = src.replace(from, to);
  applied++;
}

if (applied) {
  fs.writeFileSync(FILE, src);
  console.log(`patch-xterm-alpha: applied ${applied} edit(s) to @xterm/addon-webgl.`);
}
