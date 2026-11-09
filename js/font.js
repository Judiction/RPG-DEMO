// Tiny 3x5 bitmap font for crisp in-world text (name tags, damage numbers, neon signs).
// Rendered text is cached as small canvases.

const G = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111',
  0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110', 4: '101101111001001',
  5: '111100110001110', 6: '011100111101111', 7: '111001010010010', 8: '111101111101111', 9: '111101111001110',
  '.': '000000000000010', ',': '000000000010100', '!': '010010010000010', '?': '110001010000010', '-': '000000111000000',
  '+': '000010111010000', ':': '000010000010000', '/': '001001010100100', $: '011110010011110', "'": '010010000000000',
  '*': '010111010101000', '%': '101001010100101', '(': '010100100100010', ')': '010001001001010', '#': '101111101111101',
  '&': '010101010101011', '<': '001010100010001', '>': '100010001010100', '=': '000111000111000', '_': '000000000000111',
  '[': '110100100100110', ']': '011001001001011', ' ': '000000000000000',
};

export const strip = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();

const cache = new Map();

// Returns a canvas with the text drawn in `color`, with an optional dark outline.
export function textSprite(text, color = '#fff', outline = '#0b0710') {
  const key = text + '|' + color + '|' + outline;
  let c = cache.get(key);
  if (c) return c;
  const s = strip(text);
  const pad = outline ? 1 : 0;
  const w = Math.max(1, s.length * 4 - 1) + pad * 2, h = 5 + pad * 2;
  c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const draw = (col, ox, oy) => {
    ctx.fillStyle = col;
    for (let i = 0; i < s.length; i++) {
      const g = G[s[i]] || G['?'];
      for (let p = 0; p < 15; p++) if (g[p] === '1') ctx.fillRect(pad + i * 4 + (p % 3) + ox, pad + ((p / 3) | 0) + oy, 1, 1);
    }
  };
  if (outline) for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [1, -1], [-1, 1]]) draw(outline, ox, oy);
  draw(color, 0, 0);
  if (cache.size > 800) cache.delete(cache.keys().next().value);
  cache.set(key, c);
  return c;
}

export function drawText(ctx, text, x, y, color, align = 'center', outline = '#0b0710') {
  const c = textSprite(text, color, outline);
  const dx = align === 'center' ? Math.round(x - c.width / 2) : align === 'right' ? Math.round(x - c.width) : Math.round(x);
  ctx.drawImage(c, dx, Math.round(y));
  return c.width;
}
