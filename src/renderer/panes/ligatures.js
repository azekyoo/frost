// ---------- ligatures ----------
// The official addon is not usable here: it reads the font file off disk to
// learn which ligatures it has, through font-finder and opentype.js, and this
// renderer has no Node — deliberately, since it draws whatever a program cares
// to print. What the addon does with that knowledge is register a character
// joiner, which tells the renderer to draw a run of characters as one piece of
// text rather than cell by cell; the font's own shaping does the rest. So the
// joiner is registered directly, against the sequences programming fonts
// actually ligate, and a font that has no ligature for one of them simply draws
// it as the characters it already was.
//
// Off by default because Frost's default font is Cascadia Mono, which has none —
// switch to Cascadia Code, Fira Code, JetBrains Mono or Iosevka to see anything.
const LIGATURES =
  /(<!--|-->|<==>|<=>|===|!==|=\/=|\.\.\.|\|\|=|&&=|<<=|>>=|\/\*|\*\/|\/\/|=>|->|<-|>=|<=|!=|==|\+\+|--|\|\||&&|::|\.\.|\|>|<\||>>|<<|\?\?|:=)/g;

// Whether this font actually has the ligatures, asked of the font rather than
// assumed from its name. Two glyphs drawn as one differ from the same two drawn
// side by side; a font with no ligature for the pair draws them identically. The
// answer decides whether the letter-spacing correction is worth dropping, so a
// font without ligatures pays nothing for the setting being on.
const ligatureFonts = new Map(); // font family -> boolean

function fontHasLigatures(family) {
  if (!family) return false;
  if (ligatureFonts.has(family)) return ligatureFonts.get(family);
  let answer = false;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 80;
    canvas.height = 40;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.font = `28px ${family}`;
    const advance = ctx.measureText('=').width;
    const pixels = () => [...new Uint8Array(ctx.getImageData(0, 0, 80, 40).data)].join(',');

    ctx.clearRect(0, 0, 80, 40);
    ctx.fillText('=>', 4, 30);
    const together = pixels();

    // The same two characters, placed by hand where the font would put them.
    // Identical pixels mean the font drew two characters either way.
    ctx.clearRect(0, 0, 80, 40);
    ctx.fillText('=', 4, 30);
    ctx.fillText('>', 4 + advance, 30);
    answer = together !== pixels();
  } catch {
    answer = false;
  }
  ligatureFonts.set(family, answer);
  return answer;
}

function applyLigatures(node, wanted) {
  // The joiner groups the characters into one run; the class is what lets the
  // browser shape that run, by dropping the letter-spacing that would otherwise
  // suppress the substitution. Neither does anything without the other, and
  // neither is worth doing for a font that has nothing to substitute.
  const family = node.term?.options?.fontFamily || state.theme?.font?.family;
  const on = Boolean(wanted) && fontHasLigatures(family);
  document.body.classList.toggle('ligatures', on);
  if (Boolean(on) === Boolean(node.ligatureId !== undefined)) return;
  if (!on) {
    try {
      node.term.deregisterCharacterJoiner(node.ligatureId);
    } catch {}
    node.ligatureId = undefined;
    return;
  }
  try {
    node.ligatureId = node.term.registerCharacterJoiner((text) => {
      const ranges = [];
      LIGATURES.lastIndex = 0;
      let m;
      while ((m = LIGATURES.exec(text))) ranges.push([m.index, m.index + m[0].length]);
      return ranges;
    });
  } catch {
    node.ligatureId = undefined;
  }
}

