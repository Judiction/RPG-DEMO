// All pixel art is drawn here in code: tiles, buildings, characters, enemies, arm weapons and props.
// Sprites are painted once into small canvases and cached.

import { LOOK_OPTIONS, FACTIONS, TILE, BRANDS } from './data.js';
import { T } from './world.js';
import { textSprite } from './font.js';

const OUTLINE = '#0b0710';
export const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

// ------------------------------------------------------------------ color helpers
export function hexToRgb(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbToHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
export function shade(hex, amt) {
  const [r, g, b] = hexToRgb(hex);
  if (amt < 0) { const k = 1 + amt; return rgbToHex(r * k, g * k, b * k); }
  return rgbToHex(r + (255 - r) * amt, g + (255 - g) * amt, b + (255 - b) * amt);
}
export function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}
export function rgba(hex, a) { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }

function outline(c, col = OUTLINE) {
  const ctx = c.getContext('2d');
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data, w = c.width, h = c.height;
  const src = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) src[i] = d[i * 4 + 3] > 0 ? 1 : 0;
  const [r, g, b] = hexToRgb(col);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (src[i]) continue;
    if ((x > 0 && src[i - 1]) || (x < w - 1 && src[i + 1]) || (y > 0 && src[i - w]) || (y < h - 1 && src[i + w])) {
      d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function flipX(c) {
  const o = mk(c.width, c.height);
  const ctx = o.getContext('2d');
  ctx.translate(c.width, 0); ctx.scale(-1, 1);
  ctx.drawImage(c, 0, 0);
  for (const k of ['ax', 'ay', 'shY', 'shX', 'top']) if (k in c) o[k] = c[k];
  return o;
}

// White silhouette, used for the hit flash.
const flashCache = new WeakMap();
export function flashOf(c) {
  let f = flashCache.get(c);
  if (f) return f;
  f = mk(c.width, c.height);
  const ctx = f.getContext('2d');
  ctx.drawImage(c, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, f.width, f.height);
  flashCache.set(c, f);
  return f;
}

// ------------------------------------------------------------------ humanoid painter
// dir: 0 down, 1 left, 2 right, 3 up.  frame: 0 idle, 1..4 walk cycle.
function paintHumanoid(s, dir, frame) {
  const b = s.bulk || 1;
  const hw = Math.max(5, Math.round(6 * Math.pow(b, 0.6)));
  const hh = hw;
  const tw = Math.round(8 * b) + (b >= 1.5 ? 2 : 0);
  const th = Math.round(7 * b);
  const lh = Math.max(4, Math.round(6 * b));
  const lw = Math.max(2, Math.round(3 * b));
  const gap = b >= 1.4 ? 2 : 0;
  const W = (Math.max(tw + 8, hw + 10) + 1) & ~1;
  const H = 5 + hh + th + lh + 3;
  const c = mk(W, H);
  const g = c.getContext('2d');
  const P = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  const cx = W / 2;
  const feetY = H - 2;
  const bob = frame === 2 || frame === 4 ? -1 : 0;
  const side = dir === 1 || dir === 2;
  const fw = dir === 1 ? -1 : 1;           // facing x for side views
  const legTop = feetY - lh + 1;
  const torsoTop = legTop - th + bob;
  const headTop = torsoTop - hh + 1;
  const twS = side ? Math.max(4, tw - 2 - Math.round(b)) : tw;
  const tx0 = Math.round(cx - twS / 2);
  const skin = s.skin, skinD = shade(skin, -0.22);
  const legCol = s.chromeLegs ? '#aeb9c9' : s.pants;
  const legD = shade(legCol, -0.25);
  const shoe = s.shoes || '#1b1b24';

  // legs
  const drawLeg = (x, lift, dx) => {
    const h = lh - lift;
    P(x + dx, legTop, lw, h - 1, legCol);
    P(x + dx + lw - 1, legTop, 1, h - 1, legD);
    P(x + dx, legTop + h - 1, lw, 1, shoe);
    if (!side) P(x + dx, legTop + h - 1, 1, 1, '#d8d8e0');
    if (s.chromeLegs) {
      P(x + dx, legTop + Math.floor(h / 2), lw, 1, '#5d6778');
      if (s.kneeGlow) P(x + dx + (lw >> 1), legTop + Math.floor(h / 2), 1, 1, '#22e5ff');
    }
  };
  if (!side) {
    const lx = Math.round(cx - lw - gap / 2), rx = Math.round(cx + gap / 2);
    drawLeg(lx, frame === 1 ? 1 : 0, 0);
    drawLeg(rx, frame === 3 ? 1 : 0, 0);
  } else {
    const base = Math.round(cx - lw / 2);
    const swing = frame === 1 ? 2 : frame === 3 ? -2 : 0;
    drawLeg(base, 0, -swing * fw * 0.5 | 0);
    drawLeg(base, frame === 1 || frame === 3 ? 1 : 0, swing * fw * 0.5 | 0);
  }
  if (s.coat) {
    P(tx0, legTop, twS, Math.round(lh * 0.5), shade(s.top, -0.15));
  }

  // torso
  const top = s.top, topD = shade(top, -0.25), topL = shade(top, 0.15);
  P(tx0, torsoTop, twS, th, top);
  P(tx0 - (side ? 0 : 1), torsoTop + 1, twS + (side ? 0 : 2), Math.max(2, Math.round(th * 0.35)), top);  // shoulders
  P(tx0 + twS - 1, torsoTop + 1, 1, th - 1, topD);
  P(tx0, torsoTop + th - 1, twS, 1, s.belt || shade(s.pants, -0.3));
  if (!side && dir === 0) P(cx - 0.5 | 0, torsoTop + 1, 1, th - 2, topL);
  if (s.top2) {
    const vx = tx0 + 1, vw = twS - 2;
    P(vx, torsoTop + 1, vw, th - 2, s.top2);
    if (dir === 0) { P(vx + 1, torsoTop + th - 3, 2, 1, shade(s.top2, -0.3)); P(vx + vw - 3, torsoTop + th - 3, 2, 1, shade(s.top2, -0.3)); }
  }
  if (s.armor) {
    const m = '#9aa6b8', mL = '#d2dae6';
    P(tx0 + 1, torsoTop + 2, twS - 2, Math.max(2, Math.round(2 * b)), m);
    P(tx0 + 1, torsoTop + 2, twS - 2, 1, mL);
    if (s.armor >= 3 && !side) { P(tx0 - 2, torsoTop, 3, 3, m); P(tx0 + twS - 1, torsoTop, 3, 3, m); P(tx0 - 2, torsoTop, 3, 1, mL); P(tx0 + twS - 1, torsoTop, 3, 1, mL); }
    if (s.armor >= 3 && side) P(cx - 2, torsoTop, 4, 3, m);
    if (s.armor >= 5) P(tx0 + 1, torsoTop + th - 3, twS - 2, 2, shade(m, -0.15));
  }
  if (s.chains && dir === 0) { for (let i = 0; i < twS - 2; i++) P(tx0 + 1 + i, torsoTop + 2 + (Math.abs(i - (twS - 3) / 2) < 1.5 ? 1 : 0), 1, 1, '#ffd23f'); }
  if (s.nanite) {
    const spots = [[1, 2], [twS - 3, 3], [2, th - 3], [twS - 2, 1], [3, 4]];
    for (let i = 0; i < Math.min(5, s.nanite); i++) P(tx0 + spots[i][0], torsoTop + Math.min(th - 2, spots[i][1]), 1, 1, '#4dffa6');
  }
  if (s.emitter) P(cx - 1, torsoTop + th - 1, 2, 1, '#4fc3ff');
  if (s.band && !side) P(tx0 - 1, torsoTop + 2, 1, 2, s.band);
  if (s.backpack && dir === 3) P(tx0 + 1, torsoTop + 1, twS - 2, th - 3, s.backpack);

  // head
  const hx = Math.round(cx - hw / 2);
  const faceCol = s.mask === 'balaclava' ? '#26262b' : s.mask === 'skull' ? '#e8e4d8' : s.mask === 'faceplate' ? '#c9d3df' : skin;
  // hair behind head
  const hc = s.hairColor, hcD = shade(hc || '#000', -0.25);
  const style = s.mask === 'balaclava' || s.hat === 'helmet' ? 'none' : s.hair;
  if (style === 'afro') {
    P(hx - 2, headTop - 3, hw + 4, hh + 1, hc);
    g.clearRect(hx - 2, headTop - 3, 1, 1); g.clearRect(hx + hw + 1, headTop - 3, 1, 1);
    P(hx + hw, headTop - 2, 2, hh, hcD);
  } else if (style === 'long' || (style === 'braids' && dir !== 0)) {
    P(hx - 1, headTop, hw + 2, hh + 3, hc);
    P(hx + hw, headTop + 1, 1, hh + 2, hcD);
  }
  P(hx, headTop, hw, hh, faceCol);
  g.clearRect(hx, headTop + hh - 1, 1, 1); g.clearRect(hx + hw - 1, headTop + hh - 1, 1, 1);
  if (dir !== 3) P(hx + hw - 1, headTop + 1, 1, hh - 2, shade(faceCol, -0.2));
  if (side) P(dir === 1 ? hx - 1 : hx + hw, headTop + Math.round(hh * 0.6), 1, 1, faceCol);  // nose

  // face
  const eyeY = headTop + Math.round(hh * 0.55);
  const eyeC = s.mask === 'skull' ? '#000000' : '#1a1020';
  if (dir === 0) {
    if (s.visor) { P(hx, eyeY, hw, 2, s.visor); P(hx, eyeY, hw, 1, shade(s.visor, 0.4)); }
    else {
      P(hx + 1, eyeY, 1, 1, eyeC);
      P(hx + hw - 2, eyeY, 1, 1, s.eye || eyeC);
      if (s.mask === 'skull') { P(hx + 1, eyeY, 2, 2, '#000'); P(hx + hw - 3, eyeY, 2, 2, s.eye || '#000'); P(hx + 1, headTop + hh - 2, hw - 2, 1, '#6d675b'); }
    }
    if (s.mask === 'bandana') { P(hx, eyeY + 2, hw, hh - (eyeY + 2 - headTop), s.bandana); P(hx + 1, eyeY + 3, 1, 1, shade(s.bandana, -0.4)); }
    if (s.mask === 'balaclava') P(hx, eyeY - 1, hw, 3, skin), P(hx + 1, eyeY, 1, 1, eyeC), P(hx + hw - 2, eyeY, 1, 1, s.eye || eyeC);
  } else if (side) {
    const ex = dir === 1 ? hx + 1 : hx + hw - 2;
    if (s.visor) P(dir === 1 ? hx : hx + Math.floor(hw / 2), eyeY, Math.ceil(hw / 2), 2, s.visor);
    else P(ex, eyeY, 1, 1, s.eye || eyeC);
    if (s.mask === 'bandana') P(dir === 1 ? hx : hx + 1, eyeY + 2, hw - 1, hh - (eyeY + 2 - headTop), s.bandana);
    if (s.mask === 'balaclava') { P(dir === 1 ? hx : hx + 2, eyeY - 1, hw - 2, 3, skin); P(ex, eyeY, 1, 1, eyeC); }
  }

  // hair on top
  if (style === 'buzz' || style === 'braids' || style === 'long' || style === 'bun') {
    P(hx, headTop - 1, hw, 2, hc);
    P(hx + 1, headTop - 2, hw - 2, 1, hc);
    if (dir === 3) P(hx, headTop, hw, hh - 1, hc);
    else if (side) P(dir === 1 ? hx + Math.ceil(hw / 2) : hx, headTop, Math.floor(hw / 2), hh - 2, hc);
    if (style === 'braids' && dir === 0) { P(hx - 1, headTop, 1, hh + 3, hc); P(hx + hw, headTop, 1, hh + 3, hc); P(hx - 1, headTop + hh + 2, 1, 1, '#ffd23f'); P(hx + hw, headTop + hh + 2, 1, 1, '#ffd23f'); }
    if (style === 'long' && dir === 0) { P(hx - 1, headTop, 1, hh + 2, hc); P(hx + hw, headTop, 1, hh + 2, hcD); }
    if (style === 'bun') P(cx - 2, headTop - 4, 4, 3, hc);
  } else if (style === 'afro') {
    if (dir === 3) P(hx - 1, headTop - 2, hw + 2, hh + 1, hc);
    else if (side) P(dir === 1 ? hx + 2 : hx - 2, headTop - 3, hw, hh, hc), P(hx - 1, headTop - 3, hw + 2, 3, hc);
    else P(hx - 1, headTop - 3, hw + 2, 3, hc);
  } else if (style === 'mohawk') {
    if (side) P(hx, headTop - 3, hw, 3, hc);
    else P(cx - 1, headTop - 4, 2, dir === 3 ? hh + 3 : 5, hc);
    P(hx, headTop, hw, 1, shade(skin, -0.3));
    if (side) P(hx, headTop - 3, hw, 1, shade(hc, 0.3));
  } else if (style === 'cap') {
    const cap = s.capColor || shade(s.top, -0.1);
    P(hx - 1, headTop - 2, hw + 2, 3, cap);
    P(hx - 1, headTop - 2, hw + 2, 1, shade(cap, 0.25));
    if (dir === 0) P(hx - 1, headTop + 1, hw + 2, 1, shade(cap, -0.35));
    if (side) P(dir === 1 ? hx - 3 : hx + hw, headTop, 3, 1, shade(cap, -0.35));
  } else if (style === 'bald' && dir !== 3) P(hx + 1, headTop + 1, 1, 1, shade(skin, 0.35));

  if (s.hat === 'beret') { P(hx - 1, headTop - 2, hw + 1, 3, s.hatColor || '#2a2a2a'); P(hx + hw - 2, headTop - 3, 2, 1, s.hatColor || '#2a2a2a'); }
  if (s.hat === 'helmet') {
    const hm = s.hatColor || '#d8e4ee';
    P(hx - 1, headTop - 2, hw + 2, Math.round(hh * 0.6) + 2, hm);
    P(hx - 1, headTop - 2, hw + 2, 1, shade(hm, 0.3));
    if (dir === 0 && s.visor) P(hx, eyeY, hw, 2, s.visor);
    if (side && s.visor) P(dir === 1 ? hx - 1 : hx + 2, eyeY, hw - 1, 2, s.visor);
  }
  if (s.hat === 'crown') { for (let i = 0; i < hw; i++) P(hx + i, headTop - 2 - (i % 2 ? 0 : 2), 1, 3 + (i % 2 ? 0 : 2), '#ffd23f'); P(cx - 1 | 0, headTop - 4, 1, 1, '#ff3f8e'); }
  if (s.headphones && dir !== 3) { P(hx - 1, headTop - 2, hw + 2, 1, '#1b1b24'); P(hx - 2, eyeY - 1, 2, 3, '#1b1b24'); P(hx + hw, eyeY - 1, 2, 3, '#1b1b24'); P(hx - 2, eyeY, 1, 1, '#a66bff'); P(hx + hw + 1, eyeY, 1, 1, '#a66bff'); }

  outline(c);
  c.ax = cx; c.ay = feetY;
  c.shY = feetY - (torsoTop + 2);          // shoulder height above the feet
  c.shX = side ? 1 : Math.round(twS / 2);
  c.top = feetY - headTop + 4;              // sprite height above feet (for name tags)
  return c;
}

// ------------------------------------------------------------------ special (non-humanoid) enemies
function paintDrone(frame, police = false) {
  const c = mk(18, 16), g = c.getContext('2d');
  const P = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  const y = 3 + (frame % 2);
  P(4, y + 2, 10, 5, police ? '#22306a' : '#d8e4ee'); P(5, y + 1, 8, 1, police ? '#3a4a8a' : '#eef4fa'); P(4, y + 6, 10, 1, police ? '#141c44' : '#7a8ea3');
  if (police) { P(4, y + 1, 3, 1, frame % 2 ? '#ff3b3b' : '#3a5aff'); P(11, y + 1, 3, 1, frame % 2 ? '#3a5aff' : '#ff3b3b'); }
  P(8, y + 3, 2, 2, frame % 4 < 2 ? '#3ad0ff' : '#ff3b5c');
  P(1, y + 1, 4, 1, '#56606e'); P(13, y + 1, 4, 1, '#56606e');
  P(frame % 2 ? 0 : 2, y, 4, 1, '#c9d3df'); P(frame % 2 ? 12 : 14, y, 4, 1, '#c9d3df');
  P(6, y + 7, 1, 2, '#56606e'); P(11, y + 7, 1, 2, '#56606e');
  outline(c);
  c.ax = 9; c.ay = 15; c.shY = 6; c.shX = 0; c.top = 16;
  return c;
}

function paintDog(frame, s) {
  const c = mk(28, 20), g = c.getContext('2d');
  const P = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  const body = '#6a5a7a', chrome = '#aeb9c9';
  const bob = frame % 2 ? 0 : 1;
  const legs = frame === 1 ? [0, 2] : frame === 3 ? [2, 0] : [1, 1];
  P(6 + legs[0], 13, 3, 5, chrome); P(19 - legs[1], 13, 3, 5, chrome); P(9 - legs[1], 13, 3, 5, body); P(16 + legs[0], 13, 3, 5, body);
  P(5, 6 + bob, 17, 8, body); P(5, 6 + bob, 17, 2, shade(body, 0.2)); P(8, 9 + bob, 10, 3, chrome);
  P(19, 2 + bob, 8, 7, body); P(24, 5 + bob, 4, 4, shade(body, -0.2)); P(22, 4 + bob, 2, 1, '#ff3b5c');
  P(19, 1 + bob, 2, 2, body); P(26, 8 + bob, 2, 1, '#ffffff');
  P(2, 6 + bob, 4, 2, body);
  P(9, 7 + bob, 9, 1, s.accent || '#ffd23f');
  outline(c);
  c.ax = 14; c.ay = 18; c.shY = 9; c.shX = 0; c.top = 20;
  return c;
}

function paintMech(kind, frame) {
  const c = mk(40, 40), g = c.getContext('2d');
  const P = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  const step = frame === 1 ? 1 : frame === 3 ? -1 : 0;
  const bob = frame % 2 ? 0 : 1;
  if (kind === 'caveirao') {
    const m = '#2c3038', mL = '#4a505c';
    P(9, 29 + step, 7, 9 - step, '#1d2026'); P(24, 29 - step, 7, 9 + step, '#1d2026');
    P(7, 10 + bob, 26, 20, m); P(7, 10 + bob, 26, 2, mL); P(5, 13 + bob, 3, 12, mL); P(32, 13 + bob, 3, 12, mL);
    P(14, 14 + bob, 12, 10, '#e8e4d8'); P(15, 16 + bob, 4, 3, '#000'); P(21, 16 + bob, 4, 3, '#000'); P(19, 19 + bob, 2, 2, '#000');
    P(15, 22 + bob, 10, 1, '#000'); P(16, 21 + bob, 1, 3, '#000'); P(19, 21 + bob, 1, 3, '#000'); P(22, 21 + bob, 1, 3, '#000');
    P(17, 17 + bob, 1, 1, '#ff3b5c'); P(22, 17 + bob, 1, 1, '#ff3b5c');
    P(10, 6 + bob, 20, 5, m); P(12, 5 + bob, 16, 1, mL); P(16, 3 + bob, 8, 3, '#c9c05a');
  } else if (kind === 'mecha') {
    const m = '#d8e4ee', mD = '#8a9cb0';
    P(10, 28 + step, 6, 10 - step, mD); P(24, 28 - step, 6, 10 + step, mD);
    P(9, 12 + bob, 22, 17, m); P(9, 27 + bob, 22, 2, mD); P(31, 12 + bob, 1, 15, mD);
    P(16, 16 + bob, 8, 8, '#1a2a3a'); P(18, 18 + bob, 4, 4, frame % 2 ? '#3ad0ff' : '#9af0ff');
    P(3, 9 + bob, 7, 9, m); P(30, 9 + bob, 7, 9, m); P(1, 11 + bob, 3, 3, '#56606e'); P(36, 11 + bob, 3, 3, '#56606e');
    P(14, 5 + bob, 12, 8, m); P(15, 8 + bob, 10, 2, '#3ad0ff');
  } else if (kind === 'pmecha') {
    // police riot mech: dark blue armor, siren lights on the shoulders
    const m = '#22306a', mD = '#141c44';
    P(10, 28 + step, 6, 10 - step, mD); P(24, 28 - step, 6, 10 + step, mD);
    P(8, 11 + bob, 24, 18, m); P(8, 27 + bob, 24, 2, mD); P(8, 11 + bob, 24, 1, '#3a4a8a');
    P(14, 15 + bob, 12, 8, '#0c1020'); P(15, 17 + bob, 10, 2, '#5a8aff');
    P(2, 9 + bob, 7, 10, m); P(31, 9 + bob, 7, 10, m);
    P(3, 8 + bob, 4, 2, frame % 2 ? '#ff3b3b' : '#3a5aff'); P(33, 8 + bob, 4, 2, frame % 2 ? '#3a5aff' : '#ff3b3b');
    P(13, 4 + bob, 14, 8, m); P(14, 7 + bob, 12, 2, '#ff3b5c'); P(17, 20 + bob, 6, 2, '#ffd23f');
  } else {
    // paredão: walking wall of speakers
    const m = '#2a1840', e = '#a66bff';
    P(10, 31 + step, 6, 7 - step, '#1b1b24'); P(24, 31 - step, 6, 7 + step, '#1b1b24');
    P(5, 4 + bob, 30, 28, m); P(5, 4 + bob, 30, 1, e); P(5, 31 + bob, 30, 1, e); P(5, 4 + bob, 1, 28, e); P(34, 4 + bob, 1, 28, e);
    const pulse = frame % 2;
    for (const [sx, sy] of [[9, 8], [21, 8], [9, 19], [21, 19]]) {
      P(sx, sy + bob, 10, 10, '#120a1c'); P(sx + 1 - pulse, sy + 1 - pulse + bob, 8 + pulse * 2, 8 + pulse * 2, '#3a2a50');
      P(sx + 3, sy + 3 + bob, 4, 4, '#0a0610'); P(sx + 4, sy + 4 + bob, 2, 2, '#ffd23f');
    }
  }
  outline(c);
  c.ax = 20; c.ay = 38; c.shY = 18; c.shX = 12; c.top = 40;
  return c;
}

// ------------------------------------------------------------------ specs
export function playerSpec(look, mods = {}, gangColor = '#ff3f8e') {
  return {
    bulk: 1,
    skin: LOOK_OPTIONS.skin[look.skin] || LOOK_OPTIONS.skin[2],
    hair: LOOK_OPTIONS.hair[look.hair] || 'buzz',
    hairColor: LOOK_OPTIONS.hairColor[look.hairColor] || '#1a1414',
    top: LOOK_OPTIONS.jacket[look.jacket] || '#ff3f8e',
    pants: LOOK_OPTIONS.pants[look.pants] || '#23243a',
    eye: '#22e5ff',
    armor: mods.armor || 0,
    chromeLegs: (mods.legs || 0) > 0,
    kneeGlow: (mods.legs || 0) >= 3,
    nanite: mods.nanite || 0,
    visor: (mods.optic || 0) > 0 ? '#22e5ff' : null,
    emitter: (mods.shield || 0) > 0,
    band: gangColor,
    backpack: (mods.nanite || 0) > 0 ? '#2a6a4a' : null,
  };
}

export function enemySpec(faction, tier, id = 0, boss = false) {
  const F = FACTIONS[faction];
  const skin = F.skin[id % F.skin.length];
  if (boss) {
    if (faction === 0) return { bulk: 2.6, skin, hair: 'none', top: '#3d4428', top2: '#59613a', pants: '#2a2d1c', mask: 'skull', hat: 'beret', hatColor: '#7a1d1d', eye: '#ff3b5c', armor: 3, coat: true, belt: '#c9c05a' };
    if (faction === 1) return { bulk: 2.6, skin: '#c9d3df', hair: 'none', top: '#1e2230', top2: null, pants: '#1e2230', mask: 'faceplate', visor: '#3ad0ff', armor: 0, chromeLegs: true, kneeGlow: true, belt: '#3ad0ff', chains: false };
    return { bulk: 2.6, skin, hair: 'afro', hairColor: '#1a1414', top: '#a66bff', top2: null, pants: '#2a1840', hat: 'crown', headphones: true, chains: true, visor: '#ffd23f', armor: 0 };
  }
  const T = TIER_LOOK[faction][tier];
  if (T.special) return { special: T.special, accent: F.accent };
  return Object.assign({ skin, pants: F.uniform2, top: F.uniform, bulk: 1, hair: 'buzz', hairColor: '#1a1414' }, T, { bulk: [0, 0.85, 1, 1.25, 1.55, 2][tier] });
}

const TIER_LOOK = [
  [null,
    { top: '#6b6b4a', pants: '#3a3a2a', hair: 'cap', capColor: '#2a2a2a' },
    { top: '#59613a', top2: '#3d4428', mask: 'balaclava', hat: 'beret', hatColor: '#2a2a2a' },
    { top: '#59613a', top2: '#3d4428', mask: 'balaclava', eye: '#ff3b5c', armor: 2, chromeLegs: true },
    { top: '#3d4428', top2: '#59613a', mask: 'balaclava', eye: '#ff3b5c', armor: 4, chromeLegs: true, kneeGlow: true },
    { special: 'caveirao' }],
  [null,
    { special: 'drone' },
    { top: '#d8e4ee', pants: '#7a8ea3', hat: 'helmet', visor: '#3ad0ff' },
    { top: '#1e2230', pants: '#1e2230', hair: 'buzz', visor: '#3ad0ff', armor: 1, chromeLegs: true, belt: '#3ad0ff' },
    { top: '#d8e4ee', top2: '#8a9cb0', pants: '#7a8ea3', hat: 'helmet', visor: '#3ad0ff', armor: 5, chromeLegs: true, kneeGlow: true },
    { special: 'mecha' }],
  [null,
    { top: '#3a2457', pants: '#2a2a3a', hair: 'mohawk', hairColor: '#ffd23f' },
    { top: '#3a2457', pants: '#251639', hair: 'cap', capColor: '#a66bff', chains: true, visor: '#ffd23f' },
    { top: '#a66bff', pants: '#251639', hair: 'mohawk', hairColor: '#ff3fa4', armor: 2, chromeLegs: true, chains: true, eye: '#ffd23f' },
    { special: 'dog' },
    { special: 'paredao' }],
  [null,
    { top: '#22306a', pants: '#141c44', hair: 'cap', capColor: '#141c44', belt: '#ffd23f', band: '#ff3b3b' },
    { top: '#22306a', top2: '#3a4a8a', pants: '#141c44', hat: 'helmet', hatColor: '#1a2448', visor: '#5a8aff', belt: '#ffd23f' },
    { top: '#1a1e2e', top2: '#2a3048', pants: '#141824', hat: 'helmet', hatColor: '#2a3048', visor: '#ff3b5c', armor: 4, chromeLegs: true, belt: '#5a8aff' },
    { special: 'pdrone' },
    { special: 'pmecha' }],
];

export function allySpec(gangColor, id) {
  const skins = LOOK_OPTIONS.skin;
  return {
    bulk: 1, skin: skins[(id * 7) % skins.length], hair: ['buzz', 'cap', 'braids', 'afro'][id % 4], hairColor: '#1a1414',
    top: shade(gangColor, -0.35), pants: '#23243a', mask: 'bandana', bandana: gangColor, capColor: gangColor, band: gangColor,
  };
}

// Follower bots (crew earned by capturing districts): armored, with a visor in the gang color.
export function followerSpec(gangColor, id, tier = 1) {
  const skins = LOOK_OPTIONS.skin;
  return {
    bulk: 1, skin: skins[(id * 5 + 2) % skins.length], hair: ['buzz', 'mohawk', 'cap', 'bald'][id % 4], hairColor: '#1a1414',
    top: shade(gangColor, -0.5), top2: shade(gangColor, -0.2), pants: '#1d1d24', visor: gangColor, capColor: gangColor, band: gangColor,
    armor: Math.min(5, 1 + Math.floor(tier / 2)), chromeLegs: tier >= 3, kneeGlow: tier >= 4,
  };
}

// Civilians: everyday people of the city. Recruited ones wear the gang's color on an arm band (and maybe a bandana).
const CIV_TOPS = ['#e8e4d8', '#3a5a8c', '#c84a3a', '#3ddc84', '#ffd23f', '#2b2b3a', '#ff8a3d', '#8a5ac8', '#5a8a9a', '#f0b8c8', '#6a4a3a', '#22a5c0'];
const CIV_PANTS = ['#23243a', '#3a5a8c', '#6b4b2a', '#1d1d1d', '#5a2a4a', '#8a7a6a', '#2a4a3a'];
export function civilianSpec(seed, gangColor = null) {
  let s = (seed * 9301 + 49297) % 233280;
  const r = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const pick = (a) => a[(r() * a.length) | 0];
  const hair = pick(['buzz', 'afro', 'braids', 'long', 'cap', 'bald', 'bun', 'buzz', 'long']);
  const spec = {
    bulk: 0.9 + r() * 0.12, skin: pick(LOOK_OPTIONS.skin), hair, hairColor: pick(['#1a1414', '#4a2c1a', '#e3c16f', '#2a1a10', '#8a8a8a', '#d8d8d8', '#1a1414']),
    top: pick(CIV_TOPS), pants: pick(CIV_PANTS), capColor: pick(CIV_TOPS), shoes: pick(['#1b1b24', '#f2f2f2', '#8a3a2a']),
  };
  if (r() < 0.2) spec.top2 = pick(CIV_TOPS);
  if (r() < 0.15) spec.backpack = pick(['#3a3a46', '#8a3a2a', '#2a5a8a']);
  if (gangColor) { spec.band = gangColor; if (r() < 0.5) { spec.mask = 'bandana'; spec.bandana = gangColor; } }
  return spec;
}

// ------------------------------------------------------------------ sprite cache (characters)
const charCache = new Map();
export function charSprite(spec, dir, frame) {
  if (!spec._k) spec._k = JSON.stringify(spec);
  const key = spec._k + dir + ':' + frame;
  let c = charCache.get(key);
  if (c) return c;
  if (spec.special === 'drone' || spec.special === 'pdrone') c = paintDrone(frame, spec.special === 'pdrone');
  else if (spec.special === 'dog') { c = paintDog(frame, spec); if (dir === 1) c = flipX(c); }
  else if (spec.special) { c = paintMech(spec.special, frame); if (dir === 1) c = flipX(c); }
  else c = paintHumanoid(spec, dir, frame);
  if (charCache.size > 1500) charCache.delete(charCache.keys().next().value);
  charCache.set(key, c);
  return c;
}

// ------------------------------------------------------------------ arms (weapons)
// Arm sprites point to the right; pivot (shoulder) is at (0, c.height/2).
const armCache = new Map();
export function armSprite(kind, armColor = '#aeb9c9') {
  const key = kind + armColor;
  let c = armCache.get(key);
  if (c) return c;
  c = mk(22, 9);
  const g = c.getContext('2d');
  const P = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  const m = 4;     // mid row
  const forearm = (len) => { P(0, m - 1, len, 3, armColor); P(0, m + 1, len, 1, shade(armColor, -0.3)); P(len - 2, m - 1, 1, 3, shade(armColor, -0.4)); };
  switch (kind) {
    case 'fist': forearm(7); P(7, m - 2, 4, 5, '#c9d3df'); P(7, m - 2, 4, 1, '#ffffff'); P(10, m - 2, 1, 5, '#7d8798'); break;
    case 'pistol': forearm(6); P(6, m - 1, 6, 3, '#2b2b3a'); P(12, m - 1, 3, 1, '#2b2b3a'); P(14, m - 1, 1, 1, '#22e5ff'); P(7, m + 2, 2, 1, '#2b2b3a'); break;
    case 'blade': forearm(5); P(5, m - 1, 2, 3, '#56606e'); P(7, m - 1, 9, 2, '#e8f6ff'); P(16, m, 3, 1, '#e8f6ff'); P(7, m + 1, 10, 1, '#ff3fa4'); P(19, m + 1, 1, 1, '#ff3fa4'); break;
    case 'shotgun': forearm(5); P(5, m - 2, 7, 5, '#3a3240'); P(12, m - 2, 5, 2, '#1b1b24'); P(12, m + 1, 5, 2, '#1b1b24'); P(6, m, 5, 1, '#ff8a3d'); break;
    case 'whip': forearm(6); P(6, m - 2, 4, 5, '#c8a24a'); P(7, m - 1, 2, 3, '#ffd23f'); P(10, m, 3, 1, '#e8f6ff'); break;
    case 'hammer': forearm(5); P(5, m - 3, 9, 7, '#5a5f6e'); P(5, m - 3, 9, 1, '#8a90a0'); for (let i = 0; i < 4; i++) P(6 + i * 2, m + 2, 1, 1, '#ffd23f'); P(14, m - 2, 2, 5, '#3a3d48'); break;
    case 'smg': forearm(5); P(5, m - 1, 7, 3, '#2b2b3a'); P(12, m - 1, 4, 1, '#2b2b3a'); P(7, m + 2, 3, 2, '#3ddc84'); P(15, m - 1, 1, 1, '#3ddc84'); break;
    case 'rocket': forearm(4); P(4, m - 2, 11, 5, '#4a5a3a'); P(4, m - 2, 11, 1, '#6a7a5a'); P(15, m - 2, 2, 5, '#ff3b5c'); P(4, m + 2, 11, 1, '#2a3a1a'); break;
    case 'rail': forearm(4); P(4, m - 2, 16, 2, '#3a3d48'); P(4, m + 1, 16, 2, '#3a3d48'); for (let i = 0; i < 4; i++) P(6 + i * 4, m - 1, 2, 2, '#22e5ff'); P(20, m - 2, 1, 5, '#9af0ff'); break;
    case 'flamer': forearm(5); P(5, m - 2, 6, 5, '#6a3a2a'); P(5, m - 2, 6, 1, '#8a5a3a'); P(11, m - 1, 5, 2, '#3a3d48'); P(16, m - 1, 2, 2, '#ff8a3d'); P(6, m + 2, 3, 1, '#ffd23f'); break;
    case 'claw': forearm(6); P(6, m - 2, 2, 1, '#e8f6ff'); P(6, m, 3, 1, '#e8f6ff'); P(6, m + 2, 2, 1, '#e8f6ff'); break;
    default: forearm(6);
  }
  outline(c);
  armCache.set(key, c);
  return c;
}

export const ENEMY_ARM = { melee: 'claw', gun: 'pistol', shotgun: 'shotgun', burst: 'smg', slam: 'hammer', rocket: 'rocket', boss: 'rail' };

// ------------------------------------------------------------------ emissive helpers
// Many sprites have glowing parts (neon, lamps, screens). They are painted twice: on the sprite itself and on a
// matching "emissive" canvas (c.em) that the renderer draws again after the night darkness, so neon pops at night.
function pair(w, h) {
  const c = mk(w, h), e = mk(w, h);
  const g = c.getContext('2d'), ge = e.getContext('2d');
  const P = (x, y, ww, hh, col) => { g.fillStyle = col; g.fillRect(x, y, ww, hh); };
  const E = (x, y, ww, hh, col) => { g.fillStyle = col; g.fillRect(x, y, ww, hh); ge.fillStyle = col; ge.fillRect(x, y, ww, hh); };
  return { c, e, g, ge, P, E };
}
function finish(o, ax, ay, keepEm = true) {
  outline(o.c);
  o.c.ax = ax; o.c.ay = ay;
  if (keepEm) { o.c.em = o.e; o.e.ax = ax; o.e.ay = ay; }
  return o.c;
}

// ------------------------------------------------------------------ brand logos (7x7)
const LOGOS = {
  bottle: ['0011100', '0001000', '0011100', '0111110', '0110110', '0111110', '0011100'],
  bolt: ['0000110', '0001100', '0011000', '0111110', '0001100', '0011000', '0110000'],
  bowl: ['0010100', '0101010', '0000000', '1111111', '1111111', '0111110', '0011100'],
  tri: ['0001000', '0011100', '0010100', '0110110', '0100010', '1111111', '0000000'],
  coin: ['0111110', '1101011', '1100111', '1110011', '1101011', '0111110', '0001000'],
  speaker: ['1111111', '1011101', '1100011', '1101011', '1100011', '1011101', '1111111'],
  monitor: ['1111111', '1000001', '1010101', '1000001', '1111111', '0011100', '0111110'],
  cross: ['0011100', '0011100', '1111111', '1111111', '1111111', '0011100', '0011100'],
  heart: ['0110110', '1111111', '1111111', '1111111', '0111110', '0011100', '0001000'],
  star: ['0001000', '0011100', '1111111', '0111110', '0011100', '0110110', '0100010'],
  moon: ['0011100', '0111110', '1111000', '1110000', '1111000', '0111110', '0011100'],
  wifi: ['0111110', '1000001', '0011100', '0100010', '0001000', '0000000', '0001000'],
  cup: ['0101000', '0010100', '1111110', '1111101', '1111101', '1111110', '0111100'],
  gear: ['0101010', '1111111', '0110110', '1100011', '0110110', '1111111', '0101010'],
  eye: ['0000000', '0111110', '1100011', '1011101', '1100011', '0111110', '0000000'],
  mug: ['1111100', '1111110', '1011101', '1011101', '1011110', '1111100', '0111000'],
  wing: ['1000000', '1100000', '1111000', '1111110', '0111111', '0001111', '0000011'],
  flame: ['0001000', '0011000', '0011100', '0111110', '0110110', '0111110', '0011100'],
  ball: ['0011100', '0101010', '1110111', '1011101', '1110111', '0101010', '0011100'],
  drop: ['0001000', '0011100', '0011100', '0111110', '0111010', '0111110', '0011100'],
  box: ['1111111', '1000101', '1011101', '1010001', '1011101', '1000001', '1111111'],
  cone: ['0111110', '1111111', '0111110', '0011100', '0011100', '0001000', '0001000'],
  church: ['0001000', '0011100', '0001000', '0111110', '0101010', '0111110', '0110110'],
};
export function drawLogo(F, kind, x, y, c, c2, scale = 1) {
  const L = LOGOS[kind] || LOGOS.star;
  for (let r = 0; r < 7; r++) for (let q = 0; q < 7; q++) if (L[r][q] === '1') F(x + q * scale, y + r * scale, scale, scale, (r + q) % 5 === 0 && c2 ? c2 : c);
}

// Text helpers: crisp text on the sprite + outline-free copy on the emissive layer.
function neonText(g, ge, text, x, y, col) {
  const t = textSprite(text, col, '#120a1c');
  g.drawImage(t, x - 1, y - 1);
  if (ge) ge.drawImage(textSprite(text, col, null), x, y);
  return t.width - 2;
}

// ------------------------------------------------------------------ props
const propCache = new Map();
export function propSprite(type, v = 0, frame = 0) {
  const key = type + ':' + v + ':' + frame;
  let c = propCache.get(key);
  if (c) return c;
  c = paintProp(type, v, frame);
  propCache.set(key, c);
  return c;
}

function paintProp(type, v, frame) {
  let c, g;
  const P = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  if (type === 'palm') {
    c = mk(34, 46); g = c.getContext('2d');
    const lean = (v % 3) - 1;
    const x = 16, y = 44;
    for (let i = 0; i < 26; i++) {
      const xx = Math.round(x + lean * (i * i) / 120);
      P(xx, y - i, 3, 1, i % 4 === 0 ? '#6a4224' : '#8a5a32');
      P(xx + 2, y - i, 1, 1, '#5a3418');
    }
    const tx = Math.round(x + lean * 676 / 120) + 1, ty = y - 26;
    const leaf = (dx, dy, len, col) => {
      for (let i = 0; i < len; i++) {
        const px = Math.round(tx + dx * i), py = Math.round(ty + dy * i + (i * i) / (len * 1.4));
        P(px, py, 2, 2, col);
        if (i > 1 && i < len - 1) P(px, py + 1, 1, 1, shade(col, -0.35));
      }
    };
    const greens = ['#2f9e44', '#3fb950', '#258a3a'];
    leaf(-1, -0.4, 13, greens[0]); leaf(1, -0.4, 13, greens[1]); leaf(-0.9, 0.2, 11, greens[2]); leaf(0.9, 0.2, 11, greens[0]);
    leaf(-0.4, -0.9, 8, greens[1]); leaf(0.4, -0.9, 8, greens[2]); leaf(0, 0.3, 6, greens[1]);
    P(tx - 1, ty, 2, 2, '#7a4a20'); P(tx + 1, ty + 1, 2, 2, '#6a3a18');
    outline(c);
    c.ax = 17; c.ay = 44;
    return c;
  }
  if (type === 'banana') {
    c = mk(24, 26); g = c.getContext('2d');
    P(11, 12, 2, 13, '#7a8a3a');
    const leaf = (x, y, w, h, col) => { P(x, y, w, h, col); P(x + (w >> 1), y, 1, h, shade(col, 0.3)); };
    leaf(3, 6, 8, 4, '#3fbf4f'); leaf(13, 5, 8, 4, '#35a845'); leaf(7, 1, 10, 4, '#48cc58'); leaf(2, 10, 6, 3, '#2f9e44'); leaf(16, 10, 6, 3, '#2f9e44');
    if (v % 2) { P(13, 12, 3, 4, '#d8c040'); P(13, 12, 3, 1, '#f0d860'); }
    outline(c);
    c.ax = 12; c.ay = 25;
    return c;
  }
  if (type === 'lamp') {
    const o = pair(14, 36);
    o.P(6, 6, 2, 30, '#3a3646'); o.P(6, 6, 1, 30, '#4e4a5c');
    o.P(4, 4, 7, 3, '#2a2636'); o.E(5, 7, 5, 1, v ? '#9af0ff' : '#fff0c0');
    o.P(5, 34, 4, 2, '#2a2636');
    if (v) o.E(6, 12, 2, 1, '#22e5ff');
    return finish(o, 7, 35);
  }
  if (type === 'umbrella') {
    c = mk(22, 22); g = c.getContext('2d');
    const cols = [['#ff3f8e', '#f2f2f2'], ['#ffd23f', '#3ddc84'], ['#22e5ff', '#f2f2f2'], ['#ff8a3d', '#ffd23f']][v % 4];
    P(10, 8, 2, 13, '#d8d0c0');
    for (let i = 0; i < 9; i++) P(2 + i * 2, 4 + Math.abs(4 - i) * 0.5 | 0, 2, 5 - (Math.abs(4 - i) * 0.5 | 0), cols[i % 2]);
    P(10, 2, 2, 2, cols[0]);
    P(4, 19, 6, 2, '#f0e0b0'); P(13, 19, 5, 2, '#ff6a8e');
    outline(c);
    c.ax = 11; c.ay = 20;
    return c;
  }
  if (type === 'chair') {
    c = mk(12, 12); g = c.getContext('2d');
    const col = ['#ff3f8e', '#22e5ff', '#ffd23f', '#3ddc84'][v % 4];
    for (let i = 0; i < 4; i++) P(2, 2 + i * 2, 8, 1, i % 2 ? '#f2f2f2' : col);
    P(2, 9, 8, 2, col); P(2, 10, 1, 2, '#8a8494'); P(9, 10, 1, 2, '#8a8494');
    outline(c); c.ax = 6; c.ay = 11; return c;
  }
  if (type === 'lifeguard') {
    const o = pair(20, 40);
    o.P(4, 18, 2, 21, '#e8e4d8'); o.P(14, 18, 2, 21, '#e8e4d8'); o.P(4, 28, 12, 1, '#c8c0b0');
    o.P(2, 10, 16, 9, '#ff3b3b'); o.P(2, 10, 16, 1, '#ff8a8a'); o.P(5, 12, 10, 4, '#1a2a3a'); o.P(5, 12, 4, 1, '#9af0ff');
    o.P(1, 7, 18, 3, '#f2f2f2'); o.P(9, 0, 1, 7, '#8a8494'); o.E(10, 0, 5, 3, '#ff3b3b'); o.P(11, 1, 1, 1, '#ffffff');
    return finish(o, 10, 39);
  }
  if (type === 'bin') {
    c = mk(10, 14); g = c.getContext('2d');
    const col = v % 3 === 0 ? '#3a8a4a' : '#ff7a1a';
    P(1, 3, 8, 10, col); P(1, 3, 8, 1, shade(col, 0.3)); P(7, 4, 2, 9, shade(col, -0.3)); P(0, 1, 10, 3, '#2a2636'); P(3, 6, 4, 1, shade(col, -0.4));
    if (v % 4 === 1) { P(2, 0, 3, 2, '#5a5a6a'); P(6, 0, 2, 1, '#d8d0c0'); }
    outline(c); c.ax = 5; c.ay = 13; return c;
  }
  if (type === 'bench') {
    c = mk(20, 12); g = c.getContext('2d');
    P(1, 2, 18, 2, '#8a5a32'); P(1, 5, 18, 2, '#9a6a3a'); P(1, 2, 18, 1, '#b07a48');
    P(2, 7, 2, 4, '#3a3646'); P(16, 7, 2, 4, '#3a3646');
    outline(c); c.ax = 10; c.ay = 11; return c;
  }
  if (type === 'hydrant') {
    c = mk(8, 12); g = c.getContext('2d');
    const col = v % 2 ? '#ffd23f' : '#ff3b3b';
    P(2, 3, 4, 8, col); P(1, 5, 6, 2, col); P(2, 1, 4, 2, shade(col, -0.2)); P(3, 0, 2, 1, shade(col, -0.3)); P(2, 3, 1, 8, shade(col, 0.3)); P(1, 10, 6, 1, '#3a3646');
    outline(c); c.ax = 4; c.ay = 11; return c;
  }
  if (type === 'vending') {
    const o = pair(12, 22);
    const col = ['#ff3b5c', '#22e5ff', '#3ddc84', '#a66bff'][v % 4];
    o.P(1, 1, 10, 20, '#2a2636'); o.P(1, 1, 10, 1, '#4e4a5c');
    o.E(2, 2, 6, 11, shade(col, -0.2));
    for (let i = 0; i < 3; i++) { o.E(3, 3 + i * 3, 1, 2, '#ffffff'); o.E(5, 3 + i * 3, 1, 2, '#ffd23f'); o.E(7, 3 + i * 3, 1, 2, '#ffffff'); }
    o.E(9, 4, 1, 3, '#3ddc84'); o.P(3, 15, 6, 3, '#120a1c'); o.E(2, 13, 6, 1, col);
    return finish(o, 6, 21);
  }
  if (type === 'busstop') {
    const o = pair(30, 24);
    o.P(1, 2, 28, 3, '#3a3646'); o.P(1, 2, 28, 1, '#5a566a');
    o.P(2, 5, 1, 18, '#56606e'); o.P(27, 5, 1, 18, '#56606e');
    o.P(4, 6, 22, 9, 'rgba(154,240,255,0.25)');
    const B = BRANDS[v % BRANDS.length];
    o.E(18, 6, 9, 13, '#120a1c'); o.E(18, 6, 9, 1, B.c); o.E(18, 18, 9, 1, B.c);
    drawLogo(o.E, B.logo, 19, 9, B.c, B.c2);
    o.P(5, 16, 12, 2, '#8a5a32'); o.P(6, 18, 1, 4, '#3a3646'); o.P(15, 18, 1, 4, '#3a3646');
    o.E(3, 3, 6, 1, '#ffd23f');
    return finish(o, 15, 23);
  }
  if (type === 'banca') {
    const o = pair(20, 20);
    o.P(1, 4, 18, 15, '#2f7a4a'); o.P(1, 4, 18, 1, '#4a9a64'); o.P(0, 2, 20, 3, '#1f5a34');
    const cols = ['#ff3f8e', '#ffd23f', '#22e5ff', '#f2f2f2', '#ff8a3d'];
    for (let i = 0; i < 5; i++) { o.P(2 + i * 3, 7, 2, 4, cols[(i + v) % 5]); o.P(2 + i * 3, 12, 2, 4, cols[(i + v + 2) % 5]); }
    o.E(3, 2, 14, 1, '#ffd88a');
    return finish(o, 10, 19);
  }
  if (type === 'bags') {
    c = mk(16, 10); g = c.getContext('2d');
    P(1, 3, 7, 6, '#1d1d24'); P(6, 2, 7, 7, '#26262e'); P(10, 5, 5, 4, '#1d1d24'); P(3, 3, 2, 1, '#3a3a46'); P(8, 2, 2, 1, '#3a3a46');
    if (v % 3 === 0) P(12, 4, 2, 2, '#3a5a8c');
    outline(c); c.ax = 8; c.ay = 9; return c;
  }
  if (type === 'cart') {
    const o = pair(22, 24);
    const col = ['#ff3b3b', '#ffd23f', '#3ddc84'][v % 3];
    o.P(10, 6, 1, 8, '#d8d0c0');
    for (let i = 0; i < 7; i++) o.P(3 + i * 2, 2 + Math.abs(3 - i) * 0.4 | 0, 2, 4 - (Math.abs(3 - i) * 0.4 | 0), i % 2 ? '#f2f2f2' : col);
    o.P(2, 13, 18, 7, '#c8c0b0'); o.P(2, 13, 18, 1, '#e8e4d8'); o.P(3, 15, 16, 1, '#8a8494');
    o.E(4, 11, 8, 2, '#ff6a2b'); o.E(5, 11, 1, 1, '#ffd23f'); o.E(9, 11, 1, 1, '#ffd23f');
    o.P(4, 20, 3, 3, '#1b1b24'); o.P(15, 20, 3, 3, '#1b1b24'); o.E(14, 14, 4, 1, '#ffd88a');
    return finish(o, 11, 22);
  }
  if (type === 'cone') {
    c = mk(8, 10); g = c.getContext('2d');
    P(3, 1, 2, 2, '#ff7a1a'); P(2, 3, 4, 2, '#f2f2f2'); P(2, 5, 4, 2, '#ff7a1a'); P(1, 7, 6, 1, '#ff7a1a'); P(0, 8, 8, 2, '#3a3646');
    outline(c); c.ax = 4; c.ay = 9; return c;
  }
  if (type === 'plant') {
    c = mk(12, 16); g = c.getContext('2d');
    P(3, 10, 6, 5, '#b5653f'); P(3, 10, 6, 1, '#d98a5a');
    P(2, 3, 8, 7, '#2f9e44'); P(4, 1, 4, 3, '#3fbf4f'); P(1, 5, 2, 3, '#258a3a'); P(9, 5, 2, 3, '#258a3a');
    if (v % 3 === 0) { P(4, 4, 1, 1, '#ff7ac8'); P(7, 6, 1, 1, '#ffd23f'); }
    outline(c); c.ax = 6; c.ay = 15; return c;
  }
  if (type === 'planter') {
    c = mk(18, 14); g = c.getContext('2d');
    P(1, 7, 16, 6, '#8e8a99'); P(1, 7, 16, 1, '#b8b4c4'); P(2, 2, 14, 6, '#2f8a3c'); P(4, 1, 5, 2, '#3fa84c'); P(10, 1, 5, 2, '#3fa84c');
    if (v % 2) { P(5, 3, 1, 1, '#ff7ac8'); P(12, 4, 1, 1, '#ffd23f'); }
    outline(c); c.ax = 9; c.ay = 13; return c;
  }
  if (type === 'pole') {
    const o = pair(16, 40);
    o.P(7, 4, 2, 36, '#6a5a4e'); o.P(7, 4, 1, 36, '#8a7a6a');
    o.P(2, 8, 12, 2, '#4a3e36'); o.P(2, 8, 1, 3, '#d8d8e0'); o.P(13, 8, 1, 3, '#d8d8e0');
    if (v % 2) { o.P(9, 12, 4, 6, '#56606e'); o.P(9, 12, 4, 1, '#7a8494'); o.E(11, 15, 1, 1, '#3ddc84'); }
    for (let i = 0; i < 3; i++) o.P(3 + i * 4, 10 + (i % 2), 1, 2, '#1b1b24');
    return finish(o, 8, 39);
  }
  if (type === 'coco') {
    const o = pair(22, 22);
    o.P(10, 4, 1, 10, '#d8d0c0');
    for (let i = 0; i < 7; i++) o.P(3 + i * 2, 2 + Math.abs(3 - i) * 0.4 | 0, 2, 4 - (Math.abs(3 - i) * 0.4 | 0), i % 2 ? '#3ddc84' : '#ffd23f');
    o.P(2, 13, 18, 6, '#8a5a32'); o.P(2, 13, 18, 1, '#b07a48');
    for (let i = 0; i < 5; i++) o.P(3 + i * 3, 10, 3, 3, i % 2 ? '#4aa84a' : '#3a9a3a');
    o.E(13, 15, 5, 2, '#ffd88a');
    return finish(o, 11, 20);
  }
  if (type === 'tires') {
    c = mk(14, 12); g = c.getContext('2d');
    for (let i = 0; i < 3; i++) { P(2, 8 - i * 3, 10, 3, '#1d1d24'); P(4, 9 - i * 3, 6, 1, '#3a3a46'); }
    outline(c); c.ax = 7; c.ay = 11; return c;
  }
  if (type === 'crate') {
    c = mk(14, 14); g = c.getContext('2d');
    P(1, 2, 12, 11, '#9a6a3a'); P(1, 2, 12, 1, '#c08a50'); P(1, 7, 12, 1, '#6a4424'); P(6, 2, 1, 11, '#6a4424');
    if (v % 2) { P(2, 4, 3, 2, '#1b1b24'); P(8, 9, 4, 1, '#ff8a3d'); }
    outline(c); c.ax = 7; c.ay = 13; return c;
  }
  if (type === 'pallet') {
    c = mk(16, 8); g = c.getContext('2d');
    for (let i = 0; i < 4; i++) P(1 + i * 4, 1, 3, 4, '#b08050');
    P(1, 5, 14, 2, '#8a6038');
    outline(c); c.ax = 8; c.ay = 7; return c;
  }
  if (type === 'dumpster') {
    c = mk(24, 16); g = c.getContext('2d');
    const col = v % 2 ? '#2f7a4a' : '#3a5a8c';
    P(1, 4, 22, 10, col); P(1, 4, 22, 1, shade(col, 0.3)); P(0, 2, 24, 3, shade(col, -0.3));
    P(3, 7, 18, 1, shade(col, -0.25)); P(4, 14, 3, 2, '#1b1b24'); P(17, 14, 3, 2, '#1b1b24');
    if (v % 3 === 0) { P(5, 0, 6, 3, '#1d1d24'); P(13, 1, 4, 2, '#d8d0c0'); }
    outline(c); c.ax = 12; c.ay = 15; return c;
  }
  if (type === 'drums') {
    c = mk(16, 14); g = c.getContext('2d');
    for (let i = 0; i < 2; i++) { const x = 1 + i * 7; P(x, 2, 6, 11, '#2f6fb8'); P(x, 2, 6, 1, '#5a9ad8'); P(x, 6, 6, 1, '#1d4a8a'); P(x + 4, 3, 2, 10, '#1d4a8a'); }
    P(3, 8, 2, 2, '#ffd23f');
    outline(c); c.ax = 8; c.ay = 13; return c;
  }
  if (type === 'barrel') {
    c = mk(12, 20); g = c.getContext('2d');
    P(2, 9, 8, 10, '#7a3b22'); P(2, 11, 8, 1, '#5a2a18'); P(2, 15, 8, 1, '#5a2a18'); P(8, 9, 2, 10, '#5a2a18'); P(2, 9, 8, 1, '#2a1510');
    const fl = ['#ff8a3d', '#ffd23f', '#ff3b5c'];
    const f = frame % 3;
    P(3, 6 - f % 2, 6, 3 + f % 2, fl[0]); P(4, 3 + f, 3, 4 - f, fl[1]); P(6, 2 + (2 - f), 2, 3, fl[f === 1 ? 2 : 1]);
    outline(c);
    c.ax = 6; c.ay = 19;
    return c;
  }
  if (type === 'station') {
    const o = pair(26, 30);
    const kind = ['arsenal', 'clinic', 'locker', 'vault', 'garage'][v];
    const { P: PP, E } = o;
    if (kind === 'arsenal') {
      PP(2, 8, 22, 18, '#2a2636'); PP(2, 8, 22, 1, '#4e4a5c');
      for (let i = 0; i < 4; i++) { PP(4 + i * 5, 11, 2, 12, '#aeb9c9'); E(4 + i * 5, 11, 2, 2, ['#ff3fa4', '#22e5ff', '#ffd23f', '#3ddc84'][i]); }
      PP(2, 26, 22, 3, '#1b1b24');
    } else if (kind === 'clinic') {
      PP(4, 14, 18, 6, '#d8e4ee'); PP(4, 14, 18, 1, '#ffffff'); PP(18, 9, 4, 6, '#d8e4ee'); PP(6, 20, 2, 7, '#56606e'); PP(18, 20, 2, 7, '#56606e');
      E(9, 4, 6, 2, '#3ddc84'); E(11, 2, 2, 6, '#3ddc84'); PP(2, 9, 3, 1, '#9aa6b8'); PP(1, 10, 1, 5, '#9aa6b8');
    } else if (kind === 'locker') {
      for (let i = 0; i < 2; i++) { PP(3 + i * 11, 4, 10, 24, '#3a5a7a'); PP(3 + i * 11, 4, 10, 1, '#5a7a9a'); PP(5 + i * 11, 7, 6, 1, '#1b2a3a'); PP(5 + i * 11, 9, 6, 1, '#1b2a3a'); E(11 + i * 11, 15, 1, 3, '#22e5ff'); }
    } else if (kind === 'vault') {
      PP(3, 6, 20, 22, '#4a4a56'); PP(3, 6, 20, 1, '#7a7a86'); PP(5, 8, 16, 18, '#3a3a46'); E(11, 13, 5, 5, '#ffd23f'); PP(13, 15, 1, 1, '#3a3a46'); PP(18, 12, 2, 8, '#8a8a96');
    } else {
      PP(2, 10, 22, 17, '#3a3646'); PP(2, 10, 22, 1, '#5a566a'); PP(4, 13, 18, 11, '#2a2636');
      for (let y = 14; y < 24; y += 2) PP(4, y, 18, 1, '#4a4656');
      E(2, 8, 22, 2, '#ff8a3d'); E(10, 4, 6, 3, '#ff8a3d'); PP(12, 5, 2, 1, '#1b1b24');
      for (let i = 0; i < 5; i++) E(3 + i * 5, 27, 3, 1, i % 2 ? '#1b1b24' : '#ffd23f');
    }
    return finish(o, 13, 28);
  }
  if (type === 'sandbags') {
    c = mk(22, 12); g = c.getContext('2d');
    for (let r = 0; r < 2; r++) for (let i = 0; i < 4 - r; i++) { const x = 1 + i * 5 + r * 2, y = 6 - r * 4; P(x, y, 6, 4, '#a89870'); P(x, y, 6, 1, '#c8b890'); P(x, y + 3, 6, 1, '#7a6a4a'); }
    outline(c); c.ax = 11; c.ay = 11; return c;
  }
  if (type === 'paredao') {
    // a wall of speakers on a cart; frame 1 = the woofers pushed out on the beat
    const o = pair(34, 34);
    o.P(1, 30, 32, 3, '#2a2636'); o.P(3, 32, 4, 2, '#141018'); o.P(27, 32, 4, 2, '#141018');
    o.P(1, 4, 32, 27, '#16121e'); o.P(1, 4, 32, 1, '#3a3446'); o.P(32, 4, 1, 27, '#0a0810');
    for (const [cx, cy, r] of [[8, 11, 5], [25, 11, 5], [8, 24, 5], [25, 24, 5]]) {
      o.P(cx - r, cy - r, r * 2, r * 2, '#241c30');
      o.P(cx - r + 1, cy - r + 1, r * 2 - 2, r * 2 - 2, frame ? '#4a3e5c' : '#3a2e4a');
      o.P(cx - 2, cy - 2, 4, 4, frame ? '#6a5a80' : '#1a1422');
      o.E(cx - r, cy - r, r * 2, 1, frame ? '#22e5ff' : '#ff3fa4');
    }
    o.P(14, 6, 6, 22, '#201a2a'); for (let y = 8; y < 26; y += 3) o.P(15, y, 4, 1, '#3a3446');
    for (let x = 2; x < 32; x += 3) o.E(x, 2, 2, 2, ['#ff3fa4', '#22e5ff', '#ffd23f', '#3ddc84'][(x / 3 + frame) % 4 | 0]);
    o.E(14, 29, 6, 1, '#3ddc84');
    return finish(o, 17, 33);
  }
  if (type === 'chairs') {
    // plastic bar table with chairs (and a couple of bottles)
    c = mk(22, 14); g = c.getContext('2d');
    const col = v ? '#e8e4d8' : '#d01e2e';
    P(7, 4, 9, 6, col); P(7, 4, 9, 1, '#ffffff'); P(8, 10, 1, 3, shade(col, -0.3)); P(14, 10, 1, 3, shade(col, -0.3));
    P(9, 2, 2, 3, '#3a7a3a'); P(12, 2, 2, 3, '#8a5a1a');
    for (const cx of [1, 18]) { P(cx, 6, 4, 4, col); P(cx, 3, 4, 3, shade(col, -0.1)); P(cx, 10, 1, 3, shade(col, -0.35)); P(cx + 3, 10, 1, 3, shade(col, -0.35)); }
    outline(c); c.ax = 11; c.ay = 13; return c;
  }
  if (type === 'tires') {
    // stacked tires (barricade)
    c = mk(16, 14); g = c.getContext('2d');
    for (let r = 0; r < 3; r++) { const y = 9 - r * 4, x = 1 + (r % 2) + (v && r === 2 ? 2 : 0); P(x, y, 13, 4, '#1a1a1e'); P(x + 1, y, 11, 1, '#3a3a42'); P(x + 4, y + 1, 5, 2, '#0a0a0e'); }
    if (v) { P(10, 1, 4, 3, '#ffd23f'); P(11, 2, 2, 1, '#1a1a1e'); }
    outline(c); c.ax = 8; c.ay = 13; return c;
  }
  if (type === 'stall') {
    // street stall (barraca) with a striped awning: food, phones, or fruit
    const o = pair(26, 26);
    const aw = ['#d01e2e', '#2a7ad8', '#3a9a3a'][v % 3];
    o.P(3, 12, 20, 11, '#6a4a2a'); o.P(3, 12, 20, 2, '#8a6a3a'); o.P(4, 23, 2, 3, '#3a2a1a'); o.P(20, 23, 2, 3, '#3a2a1a');
    for (let x = 1; x < 25; x += 4) { o.P(x, 4, 2, 6, aw); o.P(x + 2, 4, 2, 6, '#f2f2f2'); }
    o.P(1, 10, 24, 1, 'rgba(0,0,0,0.35)'); o.P(2, 5, 1, 18, '#56606e'); o.P(23, 5, 1, 18, '#56606e');
    const goods = [['#ffd23f', '#ff8a3d', '#d01e2e'], ['#22e5ff', '#3a3a46', '#f2f2f2'], ['#3ddc84', '#ffd23f', '#ff3fa4']][v % 3];
    for (let i = 0; i < 6; i++) o.P(5 + i * 3, 13 + (i % 2), 2, 2, goods[i % 3]);
    o.E(5, 3, 16, 1, '#ffd88a');
    return finish(o, 13, 25);
  }
  if (type === 'moto') {
    // parked moto (mototáxi)
    c = mk(18, 12); g = c.getContext('2d');
    const col = ['#d01e2e', '#2a7ad8', '#1a1a22', '#ffd23f'][v % 4];
    P(1, 7, 5, 5, '#141018'); P(12, 7, 5, 5, '#141018'); P(2, 8, 3, 3, '#5a5a66'); P(13, 8, 3, 3, '#5a5a66');
    P(4, 5, 10, 3, col); P(6, 3, 5, 2, '#1a1a22'); P(13, 2, 2, 4, '#8a8a96'); P(12, 1, 4, 1, '#c8c8d0');
    outline(c); c.ax = 9; c.ay = 11; return c;
  }
  if (type === 'bocastall') {
    // street boca: a crate counter under a tarp with a green neon light
    const o = pair(22, 24);
    o.P(2, 13, 18, 9, '#5a3a2a'); o.P(2, 13, 18, 1, '#7a5a3a'); for (let x = 3; x < 20; x += 4) o.P(x, 14, 1, 8, '#3a2418');
    o.P(1, 4, 20, 5, '#2a5a2a'); o.P(1, 4, 20, 1, '#3a7a3a'); o.P(2, 9, 1, 13, '#56606e'); o.P(19, 9, 1, 13, '#56606e');
    o.E(5, 9, 12, 1, '#7dff5a'); o.E(9, 15, 4, 2, '#7dff5a');
    o.P(4, 11, 2, 2, '#f2f2f2'); o.P(15, 11, 3, 2, '#ff3fa4');
    return finish(o, 11, 23);
  }
  if (type === 'flood') {
    // base floodlight tower
    const o = pair(14, 44);
    o.P(6, 8, 2, 36, '#3a3646'); o.P(6, 8, 1, 36, '#5a566a');
    o.P(2, 2, 10, 6, '#2a2636'); o.E(3, 6, 8, 2, '#fff8e0'); o.P(2, 2, 10, 1, '#4e4a5c');
    o.P(4, 42, 6, 2, '#2a2636');
    return finish(o, 7, 43);
  }
  c = mk(4, 4); c.ax = 2; c.ay = 4;
  return c;
}

// ------------------------------------------------------------------ breakables (explode when shot)
export function breakSprite(type, v = 0, dead = false) {
  const key = 'brk' + type + v + (dead ? 'd' : '');
  let c = propCache.get(key);
  if (c) return c;
  let g;
  const P = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  if (type === 'xbarrel') {
    c = mk(12, 16); g = c.getContext('2d');
    if (dead) { P(2, 11, 8, 4, '#2a1a1a'); P(3, 10, 3, 2, '#3a2626'); }
    else {
      P(2, 2, 8, 13, '#c0282c'); P(2, 2, 8, 1, '#ff5a5a'); P(8, 3, 2, 12, '#8a1a1e'); P(2, 2, 8, 1, '#ff6a6a');
      P(2, 6, 8, 2, '#ffd23f'); for (let i = 0; i < 4; i++) P(2 + i * 2, 6 + (i % 2), 1, 1, '#1b1b24');
      P(4, 10, 3, 3, '#ffd23f'); P(5, 10, 1, 1, '#c0282c');
    }
    outline(c); c.ax = 6; c.ay = 15;
  } else if (type === 'gastank') {
    c = mk(10, 14); g = c.getContext('2d');
    if (dead) { P(1, 9, 8, 4, '#2a2228'); }
    else {
      const col = v % 2 ? '#ff7a1a' : '#2f6fb8';
      P(1, 5, 8, 8, col); P(2, 4, 6, 1, col); P(1, 5, 8, 1, shade(col, 0.35)); P(7, 6, 2, 7, shade(col, -0.3));
      P(3, 1, 4, 3, '#8a8494'); P(4, 0, 2, 1, '#aeb9c9'); P(2, 8, 6, 1, shade(col, -0.25)); P(1, 12, 8, 1, '#3a3646');
    }
    outline(c); c.ax = 5; c.ay = 13;
  } else if (type === 'transformer') {
    const o = pair(14, 18);
    if (dead) { o.P(2, 10, 10, 7, '#2a2a30'); o.P(3, 9, 4, 2, '#3a3a40'); }
    else {
      o.P(1, 3, 12, 14, '#4a6a5a'); o.P(1, 3, 12, 1, '#6a8a7a'); o.P(10, 4, 2, 13, '#2f4a3e');
      o.P(4, 6, 5, 5, '#ffd23f'); o.P(6, 7, 1, 2, '#1b1b24'); o.P(5, 9, 3, 1, '#1b1b24');
      o.E(3, 13, 2, 1, '#ff3b5c'); o.E(7, 13, 2, 1, '#3ddc84'); o.P(2, 1, 2, 2, '#8a8494'); o.P(9, 1, 2, 2, '#8a8494');
    }
    propCache.set(key, finish(o, 7, 17));
    return propCache.get(key);
  } else {
    // parked car
    c = mk(34, 20); g = c.getContext('2d');
    const cols = ['#b8432f', '#2f6fb8', '#e8e4d8', '#3a3646', '#d8902f', '#8a3fb8', '#3f9a4f'];
    const col = dead ? '#2a2228' : cols[v % cols.length];
    P(3, 7, 28, 9, col); P(3, 7, 28, 1, shade(col, 0.3)); P(3, 15, 28, 1, shade(col, -0.4));
    P(9, 3, 15, 6, shade(col, -0.1)); P(10, 4, 6, 4, dead ? '#141018' : '#1d3a5a'); P(17, 4, 6, 4, dead ? '#141018' : '#1d3a5a');
    if (!dead) {
      P(10, 4, 2, 1, '#9af0ff'); P(29, 9, 2, 2, '#fff6c0'); P(3, 9, 2, 2, '#ff3b5c');
      P(5, 16, 24, 2, ['#22e5ff', '#ff3fa4', '#3ddc84'][v % 3]);
      if (v % 4 === 0) { P(12, 10, 4, 2, '#5a2a18'); P(22, 12, 3, 2, '#5a2a18'); }
    } else { P(6, 10, 4, 3, '#4a3a3a'); P(18, 9, 6, 2, '#ff6a2b'); P(5, 16, 24, 2, '#1b1b24'); }
    outline(c); c.ax = 17; c.ay = 18;
  }
  propCache.set(key, c);
  return c;
}

// ------------------------------------------------------------------ flying vehicles
// dir: 0 down, 1 left, 2 right, 3 up. Riders sit at c.seats[i] (pixel offsets from the anchor).
const vehCache = new Map();
export function vehicleSprite(type, dir, color, frame = 0, dead = false) {
  const key = type + dir + color + frame + (dead ? 'd' : '');
  let c = vehCache.get(key);
  if (c) return c;
  const side = dir === 1 || dir === 2;
  const thr = frame % 2 ? '#9af0ff' : '#22e5ff';
  const body = dead ? '#2a2228' : color, bodyL = shade(body, 0.3), bodyD = shade(body, -0.35);
  let o;
  if (type === 'moto') {
    if (side) {
      o = pair(30, 16);
      const { P, E } = o;
      P(4, 6, 22, 5, body); P(4, 6, 22, 1, bodyL); P(4, 10, 22, 1, bodyD);
      P(20, 3, 7, 4, bodyD); P(25, 5, 3, 3, body); P(9, 4, 9, 2, '#1b1b24');
      E(27, 6, 2, 2, '#fff6c0'); E(3, 7, 2, 2, '#ff3b5c');
      P(6, 11, 6, 3, '#3a3646'); P(19, 11, 6, 3, '#3a3646');
      E(7, 14, 4, 1, thr); E(20, 14, 4, 1, thr);
      E(12, 8, 7, 1, '#22e5ff');
      o.c.seats = [[3, -6], [-7, -5]];
      o.c.top = 6;
    } else {
      o = pair(16, 20);
      const { P, E } = o;
      P(4, 6, 8, 10, body); P(4, 6, 8, 1, bodyL); P(10, 7, 2, 9, bodyD);
      P(2, 9, 12, 3, bodyD); P(5, 4, 6, 3, '#1b1b24');
      if (dir === 0) { E(6, 13, 4, 2, '#fff6c0'); } else E(6, 13, 4, 2, '#ff3b5c');
      P(3, 16, 3, 2, '#3a3646'); P(10, 16, 3, 2, '#3a3646'); E(3, 18, 3, 1, thr); E(10, 18, 3, 1, thr);
      o.c.seats = dir === 0 ? [[0, -4], [0, -9]] : [[0, -9], [0, -4]];
      o.c.top = 6;
    }
  } else {
    if (side) {
      o = pair(42, 22);
      const { P, E } = o;
      P(3, 9, 36, 7, body); P(3, 9, 36, 1, bodyL); P(3, 15, 36, 1, bodyD);
      P(10, 3, 20, 7, shade(body, -0.12)); P(11, 4, 8, 5, '#1d3a5a'); P(21, 4, 8, 5, '#1d3a5a'); P(11, 4, 3, 1, '#9af0ff');
      E(37, 11, 2, 2, '#fff6c0'); E(3, 11, 2, 2, '#ff3b5c');
      P(5, 16, 8, 3, '#3a3646'); P(29, 16, 8, 3, '#3a3646');
      E(6, 19, 6, 1, thr); E(30, 19, 6, 1, thr);
      E(13, 17, 16, 1, dead ? '#3a3a3a' : '#ff3fa4');
      o.c.seats = [[8, -8], [-5, -8], [2, -7], [-11, -7]];
      o.c.top = 4;
    } else {
      o = pair(30, 26);
      const { P, E } = o;
      P(3, 9, 24, 11, body); P(3, 9, 24, 1, bodyL); P(24, 10, 3, 10, bodyD);
      P(6, 3, 18, 7, shade(body, -0.12)); P(7, 4, 16, 5, '#1d3a5a'); P(7, 4, 5, 1, '#9af0ff');
      if (dir === 0) { E(4, 16, 4, 2, '#fff6c0'); E(22, 16, 4, 2, '#fff6c0'); } else { E(4, 16, 4, 2, '#ff3b5c'); E(22, 16, 4, 2, '#ff3b5c'); }
      P(4, 20, 6, 3, '#3a3646'); P(20, 20, 6, 3, '#3a3646'); E(5, 23, 4, 1, thr); E(21, 23, 4, 1, thr);
      E(10, 21, 10, 1, dead ? '#3a3a3a' : '#ff3fa4');
      o.c.seats = dir === 0 ? [[-5, -6], [5, -6], [-5, -11], [5, -11]] : [[-5, -11], [5, -11], [-5, -6], [5, -6]];
      o.c.top = 3;
    }
  }
  const W = o.c.width, H = o.c.height;
  c = finish(o, W / 2, H - 2);
  if (dir === 1) {
    const f = flipX(c); f.seats = c.seats.map(([x, y]) => [-x, y]); f.top = c.top;
    f.em = flipX(c.em); c = f;
  }
  vehCache.set(key, c);
  return c;
}

// ------------------------------------------------------------------ turrets
export function turretBase(color, dead = false) {
  const key = 'tb' + color + dead;
  let c = propCache.get(key);
  if (c) return c;
  const o = pair(18, 14);
  o.P(2, 5, 14, 8, dead ? '#2a2630' : '#4a4656'); o.P(3, 4, 12, 1, dead ? '#3a3640' : '#6a6676'); o.P(2, 12, 14, 1, '#1b1b24');
  if (!dead) { o.E(3, 9, 12, 1, color); o.P(4, 6, 2, 2, '#8a8494'); o.P(12, 6, 2, 2, '#8a8494'); }
  else { o.P(5, 3, 3, 2, '#3a3640'); o.P(10, 2, 2, 3, '#2a2630'); }
  c = finish(o, 9, 13);
  propCache.set(key, c);
  return c;
}
// turret head: points right, pivot at (4, h/2)
export function turretHead(type, color) {
  const key = 'th' + type + color;
  let c = propCache.get(key);
  if (c) return c;
  const o = pair(22, 12);
  const { P, E } = o;
  const m = 6;
  if (type === 'mg') { P(0, m - 3, 8, 6, '#3a3d48'); P(0, m - 3, 8, 1, '#5a5f6e'); P(8, m - 2, 9, 1, '#2b2b3a'); P(8, m + 1, 9, 1, '#2b2b3a'); E(2, m, 3, 1, color); }
  else if (type === 'rocket') { P(0, m - 4, 12, 8, '#4a5a3a'); P(0, m - 4, 12, 1, '#6a7a5a'); for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) P(10, m - 3 + i * 4, 3, 2, '#1b1b24'); E(2, m, 4, 1, color); }
  else if (type === 'tesla') { P(1, m - 4, 7, 8, '#3a3d48'); E(2, m - 2, 5, 4, '#9af0ff'); E(3, m - 1, 3, 2, '#ffffff'); }
  else if (type === 'flamer') { P(0, m - 3, 8, 6, '#6a3a2a'); P(0, m - 3, 8, 1, '#8a5a3a'); P(8, m - 1, 7, 2, '#3a3d48'); E(15, m - 1, 2, 2, '#ff8a3d'); E(2, m, 3, 1, color); }
  else { P(0, m - 3, 7, 6, '#3a3d48'); P(7, m - 2, 14, 1, '#3a3d48'); P(7, m + 1, 14, 1, '#3a3d48'); for (let i = 0; i < 3; i++) E(8 + i * 4, m - 1, 2, 2, '#22e5ff'); E(20, m - 2, 1, 4, '#9af0ff'); }
  c = finish(o, 4, m);
  propCache.set(key, c);
  return c;
}

// ------------------------------------------------------------------ tiles
let tileset = null;
export function getTileset() {
  if (!tileset) tileset = buildTileset();
  return tileset;
}

function speckle(g, rnd, n, cols, w = 1, h = 1) {
  for (let i = 0; i < n; i++) { g.fillStyle = cols[(rnd() * cols.length) | 0]; g.fillRect((rnd() * 16) | 0, (rnd() * 16) | 0, w, h); }
}

function buildTileset() {
  const set = {};
  let s = 1;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const tile = (fn, n = 4) => Array.from({ length: n }, (_, v) => { const c = mk(16, 16); const g = c.getContext('2d'); fn(g, v); return c; });
  const fill = (g, col) => { g.fillStyle = col; g.fillRect(0, 0, 16, 16); };
  const P = (g, x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };

  set[T.GRASS] = tile((g, v) => {
    fill(g, '#3a8f3c'); speckle(g, rnd, 22, ['#2f7a33', '#45a345', '#33853a']);
    for (let i = 0; i < 6; i++) { const x = (rnd() * 15) | 0, y = (rnd() * 14) | 0; P(g, x, y, 1, 2, '#56b84f'); }
    if (v === 3) { P(g, 4, 5, 1, 1, '#ff7ac8'); P(g, 11, 10, 1, 1, '#ffd23f'); P(g, 8, 13, 1, 1, '#ff7ac8'); }
  }, 4);
  set[T.DIRT] = tile((g, v) => {
    fill(g, '#9a5634'); speckle(g, rnd, 26, ['#87482a', '#a8623a', '#8f4f2f']);
    speckle(g, rnd, 4, ['#c48a5a', '#6a3520']);
    if (v === 2) { P(g, 3, 9, 3, 2, '#b07650'); P(g, 3, 9, 3, 1, '#c99068'); }
    if (v === 3) { P(g, 9, 4, 4, 3, '#5a3a5a'); P(g, 10, 4, 2, 1, '#8a6aa8'); }
  }, 4);
  set[T.SAND] = tile((g, v) => {
    fill(g, '#e9cf94'); speckle(g, rnd, 24, ['#dcbf80', '#f4dfaa', '#e2c588']);
    if (v === 1) { P(g, 6, 7, 2, 1, '#ffffff'); P(g, 7, 6, 1, 1, '#ffd0d8'); }
  }, 4);
  set[T.ROAD] = tile((g, v) => {
    fill(g, '#2b2a35'); speckle(g, rnd, 30, ['#24232c', '#33323e', '#2f2e3a']);
    if (v === 1) { P(g, 3, 4, 1, 3, '#1b1a22'); P(g, 4, 6, 3, 1, '#1b1a22'); P(g, 6, 7, 1, 3, '#1b1a22'); P(g, 7, 9, 4, 1, '#1b1a22'); P(g, 10, 10, 1, 3, '#1b1a22'); }
    if (v === 2) { P(g, 4, 6, 8, 5, '#2a2246'); P(g, 5, 5, 6, 1, '#2a2246'); P(g, 6, 7, 3, 1, '#ff4fd8'); P(g, 8, 9, 2, 1, '#22e5ff'); }
    if (v === 3) { P(g, 5, 5, 6, 6, '#3a3946'); P(g, 6, 6, 4, 4, '#2a2934'); P(g, 6, 7, 4, 1, '#3a3946'); P(g, 6, 9, 4, 1, '#3a3946'); }
    if (v === 4) { P(g, 4, 6, 8, 5, '#1a1920'); P(g, 5, 5, 6, 1, '#1a1920'); P(g, 3, 7, 1, 3, '#1a1920'); P(g, 5, 8, 5, 2, '#1d3048'); P(g, 6, 8, 2, 1, '#4a6a9a'); P(g, 4, 11, 7, 1, '#3a3946'); }
    if (v === 5) { P(g, 2, 9, 7, 4, '#24222c'); P(g, 3, 10, 4, 2, '#1e3a52'); P(g, 4, 10, 2, 1, '#ff4fd8'); P(g, 6, 11, 1, 1, '#22e5ff'); }
  }, 6);
  set[T.SIDEWALK] = tile((g, v) => {
    fill(g, '#8e8a99'); speckle(g, rnd, 12, ['#85818f', '#97939f']);
    P(g, 0, 0, 16, 1, '#7a7686'); P(g, 0, 8, 16, 1, '#7a7686'); P(g, 0, 0, 1, 16, '#7a7686'); P(g, 8, 0, 1, 8, '#7a7686'); P(g, 4, 8, 1, 8, '#7a7686'); P(g, 12, 8, 1, 8, '#7a7686');
    P(g, 1, 1, 7, 1, '#a19dab');
    if (v === 2) { P(g, 10, 3, 3, 2, '#3a3a3a'); P(g, 11, 2, 1, 1, '#5a5a5a'); }
    if (v === 3) { P(g, 3, 11, 1, 1, '#5a5666'); P(g, 9, 4, 1, 1, '#5a5666'); P(g, 13, 13, 2, 1, '#6a6676'); }
  }, 4);
  set[T.CALCADAO] = tile((g) => {
    for (let x = 0; x < 16; x++) for (let y = 0; y < 16; y++) {
      const wv = Math.round(2.5 * Math.sin((x / 16) * Math.PI * 2));
      const band = ((y + wv + 16) % 8) < 4;
      P(g, x, y, 1, 1, band ? '#1e1b24' : '#efe6d2');
    }
  }, 1);
  set[T.CONCRETE] = tile((g, v) => {
    fill(g, '#6f6880'); speckle(g, rnd, 22, ['#665f77', '#787189', '#6a6379']);
    P(g, 0, 15, 16, 1, '#5d566d'); P(g, 15, 0, 1, 16, '#5d566d'); P(g, 0, 0, 15, 1, '#7d7690');
    if (v === 1) { P(g, 2, 9, 5, 4, '#635c74'); P(g, 3, 10, 3, 2, '#5a536a'); }
    if (v === 2) { P(g, 9, 2, 1, 4, '#564f66'); P(g, 10, 5, 3, 1, '#564f66'); }
  }, 4);
  set[T.METAL] = tile((g, v) => {
    fill(g, '#4a5260'); P(g, 0, 0, 16, 1, '#3c434f'); P(g, 0, 0, 1, 16, '#3c434f'); P(g, 1, 1, 15, 1, '#5a6372');
    P(g, 2, 2, 1, 1, '#6a7484'); P(g, 13, 2, 1, 1, '#6a7484'); P(g, 2, 13, 1, 1, '#6a7484'); P(g, 13, 13, 1, 1, '#6a7484');
    if (v === 1) for (let i = 0; i < 4; i++) P(g, 3 + i * 3, 7, 2, 2, i % 2 ? '#1b1b24' : '#ffd23f');
    if (v === 2) { P(g, 5, 6, 6, 4, '#5a3a2a'); P(g, 6, 7, 3, 2, '#6a4a32'); }
    if (v === 3) { P(g, 3, 4, 9, 6, '#2a2e36'); P(g, 4, 5, 5, 3, '#3a4a5a'); P(g, 5, 5, 2, 1, '#8a6aff'); }
  }, 4);
  set[T.STAIRS] = tile((g, v) => {
    fill(g, '#8a7f78'); speckle(g, rnd, 10, ['#7f746d', '#958a83']);
    for (let y = 3; y < 16; y += 4) { P(g, 0, y, 16, 1, '#6a605a'); P(g, 0, y + 1, 16, 1, '#a49890'); }
    if (v === 1) { P(g, 11, 6, 3, 2, '#4a7a3a'); }
    if (v === 2) { P(g, 2, 9, 2, 2, '#3a3a46'); }
  }, 3);
  set[T.TREE] = tile((g, v) => {
    fill(g, '#2f7a33');
    P(g, 1, 2, 14, 12, '#1f5f2a'); P(g, 0, 4, 16, 8, '#1f5f2a'); P(g, 3, 1, 10, 14, '#1f5f2a');
    P(g, 3, 3, 9, 7, '#2b7a35'); P(g, 4, 3, 5, 3, '#3a9a44'); P(g, 5, 4, 2, 1, '#55b85a');
    P(g, 2, 12, 12, 2, '#16451f');
    if (v === 1) { P(g, 10, 7, 2, 2, '#ff7ac8'); }
    if (v === 2) { P(g, 4, 8, 2, 2, '#ffd23f'); }
  }, 3);
  set[T.PAD] = tile((g) => {
    fill(g, '#5a5664');
    P(g, 2, 2, 12, 12, '#47434f'); P(g, 4, 4, 8, 8, '#3a3642'); P(g, 7, 2, 2, 12, '#47434f'); P(g, 2, 7, 12, 2, '#47434f');
  }, 1);
  set[T.WATER] = tile((g, v) => {
    fill(g, '#0f4c72'); speckle(g, rnd, 12, ['#0d4466', '#13557e']);
    P(g, (v * 5) % 12, 4 + v, 4, 1, '#2a78a0'); P(g, (v * 7 + 6) % 12, 11 - v, 3, 1, '#2a78a0');
  }, 4);
  set[T.BRIDGE] = tile((g, v) => {
    fill(g, '#6a6470'); speckle(g, rnd, 14, ['#625c68', '#746e7a']);
    P(g, 0, 0, 16, 1, '#544e5a'); P(g, 0, 8, 16, 1, '#5a5460');
    if (v === 1) P(g, 6, 7, 4, 1, '#c8a83a');
  }, 2);
  set[T.CONCRETE + 100] = set[T.CONCRETE];
  return set;
}

// ------------------------------------------------------------------ buildings
const FAVELA_WALLS = ['#d9826a', '#e8c26a', '#7fb8d6', '#9ad17a', '#e89ab8', '#b5653f', '#f0e6d2', '#c8a0e8', '#ff9a5a'];
const HOUSE_WALLS = ['#f0e6d2', '#e8d0a8', '#a8d8e8', '#f0b8c8', '#c8e8b0', '#ffd8a0'];
const APT_WALLS = ['#d8c8b0', '#a8b8c8', '#c8a8a0', '#b0c8b0', '#e0d0e8', '#8a9aaa'];
const CONTAINER = ['#b8432f', '#2f6fb8', '#3f9a4f', '#d8902f', '#8a3fb8', '#2f9ab8'];
const CLOTHES = ['#ff3f8e', '#22e5ff', '#ffd23f', '#f2f2f2', '#3ddc84', '#ff8a3d', '#a66bff'];

// g: the ground chunk; ge: its emissive twin (neon, lit windows) drawn again after the night darkness.
export function drawBuilding(g, ge, b, ox, oy) {
  const P = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(ox + x, oy + y, w, h); };
  const E = (x, y, w, h, col) => { P(x, y, w, h, col); if (ge) { ge.fillStyle = col; ge.fillRect(ox + x, oy + y, w, h); } };
  let s = b.seed | 0 || 1;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const W = b.w * TILE, H = b.h * TILE;
  const fh = b.fr * TILE;          // facade height
  const rh = H - fh;               // roof height
  const pick = (arr) => arr[(rnd() * arr.length) | 0];
  // ---- details
  const win = (x, y, w, h, litP = 0.35) => {
    const r = rnd();
    if (r < litP) E(x, y, w, h, r < litP * 0.7 ? '#ffd88a' : r < litP * 0.85 ? '#9af0ff' : '#ff9ae8');
    else { P(x, y, w, h, '#1a2236'); P(x, y, Math.max(1, w >> 1), 1, '#3a4a66'); }
  };
  const pipe = (x, y0, y1) => { P(x, y0, 1, y1 - y0, '#56606e'); for (let y = y0 + 3; y < y1; y += 6) P(x - 1, y, 3, 1, '#3a3d48'); };
  const ac = (x, y) => { P(x, y, 5, 4, '#c8c8d0'); P(x, y, 5, 1, '#e8e8f0'); P(x + 1, y + 1, 3, 2, '#8a8a96'); P(x + 2, y + 4, 1, 2, '#56606e'); };
  const tank = (x, y) => { P(x, y, 9, 7, '#2f68b8'); P(x, y, 9, 2, '#5a8ad8'); P(x + 1, y + 6, 7, 1, '#1d4a8a'); P(x + 3, y + 1, 3, 1, '#8ab0f0'); };
  const dish = (x, y) => { P(x, y, 5, 4, '#d8d8e0'); P(x + 1, y + 1, 3, 2, '#a8a8b8'); P(x + 2, y + 4, 1, 2, '#56606e'); };
  const antenna = (x, y, h = 7) => { P(x, y, 1, h, '#56606e'); E(x, y - 1, 1, 1, '#ff3b5c'); };
  const vent = (x, y) => { P(x, y, 6, 5, '#4a4a5e'); P(x, y, 6, 1, '#6a6a7e'); P(x + 1, y + 2, 4, 1, '#2a2a3e'); };
  const solar = (x, y, w) => { for (let i = 0; i < w; i += 5) { P(x + i, y, 4, 6, '#1d2a5a'); P(x + i, y, 4, 1, '#4a6ab8'); P(x + i + 2, y, 1, 6, '#2a3a7a'); } };
  const laundry = (x, y, w) => { P(x, y, w, 1, '#c8c0b0'); for (let i = 2; i < w - 2; i += 3 + ((rnd() * 2) | 0)) P(x + i, y + 1, 2, 2 + ((rnd() * 2) | 0), pick(CLOTHES)); };
  const balcony = (x, y, w) => { P(x, y, w, 1, '#c8c8d0'); for (let i = 0; i < w; i += 2) P(x + i, y + 1, 1, 2, '#9a9aa6'); P(x, y + 3, w, 1, '#7a7a86'); };
  const shutter = (x, y, w, h) => { P(x, y, w, h, '#5a5f6e'); for (let yy = y + 1; yy < y + h; yy += 2) P(x, yy, w, 1, '#6a707e'); if (rnd() < 0.6) tag(x + 1, y + 2, w - 2); };
  const tag = (x, y, w) => {
    const col = rnd() < 0.6 ? '#141018' : pick(['#ff3f8e', '#22e5ff', '#ffd23f', '#3ddc84']);
    let xx = x;
    for (let i = 0; i < 4 && xx < x + w - 2; i++) {
      const hh = 3 + ((rnd() * 3) | 0);
      P(xx, y, 1, hh, col); if (rnd() < 0.6) P(xx, y, 3, 1, col); if (rnd() < 0.5) P(xx + 2, y, 1, hh, col);
      xx += 4;
    }
  };
  const floors = (y0, y1, fn) => { for (let y = y0; y < y1; y += TILE) fn(y); };
  // ---- neon signs
  const signs = () => {
    const S = b.sign;
    if (!S) return;
    if (S.kind === 'cross') {
      const cx = (W / 2) | 0, cy = Math.max(2, rh - 12);
      P(cx - 4, cy - 1, 9, 12, '#120a1c');
      E(cx, cy, 1, 10, '#ff3b5c'); E(cx - 3, cy + 3, 7, 1, '#ff3b5c');
      const t = 'IGREJA';
      neonText(g, ge, t, ox + ((W - (t.length * 4 - 1)) / 2 | 0), oy + rh + 2, '#ffffff');
      return;
    }
    const B = BRANDS[S.brand];
    if (S.kind === 'vertical') {
      const letters = B.name.replace(/[^A-Z0-9+]/g, '').slice(0, Math.max(3, Math.min(7, b.fr * 2 + 1)));
      const x = S.right ? W - 7 : 1, y = rh + 1;
      const h = letters.length * 6 + 10;
      P(x - 1, y - 1, 7, h + 2, '#120a1c');
      E(x - 1, y - 1, 7, 1, B.c); E(x - 1, y + h, 7, 1, B.c); E(x - 1, y - 1, 1, h + 2, B.c); E(x + 5, y - 1, 1, h + 2, B.c);
      drawLogo(E, B.logo, x - 1 + 0, y + 1, B.c2, null, 1);
      for (let i = 0; i < letters.length; i++) {
        const tch = textSprite(letters[i], B.c, null);
        g.drawImage(tch, ox + x + 1, oy + y + 9 + i * 6);
        if (ge) ge.drawImage(tch, ox + x + 1, oy + y + 9 + i * 6);
      }
      return;
    }
    if (S.kind === 'marquee') {
      const y = rh + 1, w = W - 4;
      P(2, y, w, 9, '#120a1c');
      for (let i = 0; i < w; i += 2) { E(2 + i, y, 1, 1, i % 4 ? '#ffd23f' : '#ff3fa4'); E(2 + i, y + 8, 1, 1, i % 4 ? '#ff3fa4' : '#ffd23f'); }
      const tw = B.name.length * 4 - 1;
      neonText(g, ge, B.name, ox + ((W - tw) / 2 | 0), oy + y + 2, B.c);
      return;
    }
    // panel: [logo] NAME
    const name = B.name.length * 4 > W - 14 ? B.name.split(/[ .]/)[0] : B.name;
    const tw = name.length * 4 - 1;
    const pw = Math.min(W - 2, tw + 13);
    const px = ((W - pw) / 2) | 0, py = rh + 2;
    P(px, py, pw, 11, '#120a1c');
    E(px, py, pw, 1, B.c); E(px, py + 10, pw, 1, B.c); E(px, py, 1, 11, B.c); E(px + pw - 1, py, 1, 11, B.c);
    drawLogo(E, B.logo, px + 2, py + 2, B.c, B.c2);
    neonText(g, ge, name, ox + px + 11, oy + py + 3, B.c2 && B.c2 !== '#ffffff' ? B.c : '#ffffff');
  };
  const billboard = () => {
    if (!b.board) return;
    const B = BRANDS[b.board.brand];
    const bw = Math.min(W - 6, 44), bh = 18, bx = ((W - bw) / 2) | 0, by = 3;
    P(bx + 3, by + bh, 2, 5, '#3a3d48'); P(bx + bw - 5, by + bh, 2, 5, '#3a3d48');
    P(bx, by, bw, bh, '#120a1c');
    E(bx, by, bw, 1, B.c); E(bx, by + bh - 1, bw, 1, B.c); E(bx, by, 1, bh, B.c); E(bx + bw - 1, by, 1, bh, B.c);
    drawLogo(E, B.logo, bx + 3, by + 2, B.c, B.c2, 2);
    const words = B.name.split(/[ .]/);
    words.slice(0, 2).forEach((wd, i) => neonText(g, ge, wd.slice(0, Math.floor((bw - 20) / 4)), ox + bx + 19, oy + by + 3 + i * 7, i ? B.c2 || B.c : B.c));
  };

  if (b.style === 'container') {
    const col = CONTAINER[b.seed % CONTAINER.length];
    P(0, 1, W, H - 2, col); P(0, 1, W, 1, shade(col, 0.3)); P(0, H - 2, W, 1, shade(col, -0.4));
    for (let x = 2; x < W - 1; x += 3) P(x, 2, 1, H - 4, shade(col, -0.2));
    P(1, 3, 3, 3, '#f2f2f2');
    if (b.seed % 3 === 0) tag(6, 4, W - 8);
    return;
  }
  if (b.style === 'favela') {
    const wall = pick(FAVELA_WALLS), wall2 = pick(FAVELA_WALLS);
    const brick = rnd() < 0.4;
    // roof (laje): water tanks, dishes, rebar, laundry, little gardens
    P(0, 0, W, rh, '#8a8590'); P(0, 0, W, 1, '#a8a3ae'); P(0, rh - 2, W, 2, '#6a6570');
    speckle2(P, rnd, W, rh, 10, ['#7f7a85', '#96919c']);
    if (rnd() < 0.8) tank(2 + ((rnd() * (W - 12)) | 0), 2 + ((rnd() * Math.max(1, rh - 10)) | 0));
    if (rnd() < 0.45) dish(W - 7, 2);
    if (rnd() < 0.55) for (let i = 0; i < 3; i++) P(1 + i * 3, 1, 1, 3, '#5a3a2a');
    if (rnd() < 0.4 && W >= 40) laundry(4, rh - 7, W - 8);
    if (rnd() < 0.25) { P(W - 10, rh - 6, 7, 4, '#3a8a3c'); P(W - 9, rh - 7, 2, 1, '#ff7ac8'); }
    // facade: every floor can be a different color (houses stacked over the years)
    for (let f = 0; f < b.fr; f++) {
      const y0 = rh + f * TILE, col = f % 2 ? wall2 : wall;
      P(0, y0, W, TILE, col);
      if (brick && f === b.fr - 1) for (let y = y0; y < y0 + TILE; y += 3) for (let x = (y % 6 ? 0 : 2); x < W; x += 5) P(x, y, 4, 2, shade('#b5653f', (rnd() - 0.5) * 0.15));
      P(0, y0, W, 1, shade(col, -0.35));
      if (f < b.fr - 1) { for (let x = 3; x < W - 4; x += 9) win(x, y0 + 5, 4, 4, 0.5); if (rnd() < 0.5) balcony(2, y0 + 12, Math.min(14, W - 4)); }
    }
    const door = 2 + ((rnd() * (W - 8)) | 0);
    P(door, H - 10, 5, 10, '#3a2a2a'); P(door + 1, H - 9, 3, 8, pick(['#4a6a8a', '#8a3a3a', '#3a6a4a', '#5a4a3a']));
    for (let x = 2; x < W - 4; x += 8) if (Math.abs(x - door) > 6) { win(x, H - 12, 4, 4, 0.45); P(x - 1, H - 13, 6, 1, shade(wall, -0.3)); }
    if (rnd() < 0.4) ac(W - 7, rh + 3);
    if (rnd() < 0.5) tag(2, H - 6, W - 6);
    signs();
    return;
  }
  if (b.style === 'house') {
    const wall = pick(HOUSE_WALLS), roof = pick(['#c4553a', '#b84a30', '#d0683f', '#7a4a6a']);
    P(0, 0, W, rh, roof);
    for (let y = 2; y < rh; y += 3) P(0, y, W, 1, shade(roof, -0.2));
    P(0, (rh / 2) | 0, W, 1, shade(roof, 0.25));
    P(0, rh - 1, W, 1, shade(roof, -0.45));
    if (rnd() < 0.35) solar(4, 3, Math.min(20, W - 8));
    else if (rnd() < 0.4) dish(W - 8, 3);
    P(0, rh, W, fh, wall); P(0, rh, W, 1, shade(wall, -0.3));
    const door = ((W - 6) / 2) | 0;
    P(door, H - 11, 6, 11, '#5a3a2a'); P(door + 4, H - 6, 1, 1, '#ffd23f');
    for (let x = 3; x < W - 5; x += 9) if (Math.abs(x - door) > 6) { win(x, rh + 3, 6, 5, 0.5); P(x, rh + 3, 6, 1, '#f2f2f2'); P(x + 2, rh + 3, 1, 5, '#f2f2f2'); }
    if (rnd() < 0.4) ac(W - 7, rh + 2);
    if (rnd() < 0.3) pipe(1, rh + 1, H - 1);
    signs();
    return;
  }
  if (b.style === 'shop') {
    const wall = pick(HOUSE_WALLS.concat(APT_WALLS)), awn = pick([['#ff3f8e', '#f2f2f2'], ['#3ddc84', '#ffd23f'], ['#22e5ff', '#f2f2f2'], ['#ff8a3d', '#ffd23f'], ['#a66bff', '#ffd23f']]);
    P(0, 0, W, rh, '#5a5664'); P(0, 0, W, 1, '#7a7686'); P(0, rh - 2, W, 2, '#3a3646');
    if (rnd() < 0.6) ac(3, 3); if (rnd() < 0.5) vent(W - 9, 3); if (rnd() < 0.3) tank(((W - 9) / 2) | 0, 2);
    P(0, rh, W, fh, wall); P(0, rh, W, 1, shade(wall, -0.3));
    if (b.fr >= 2) floors(rh, H - TILE, (y) => { for (let x = 3; x < W - 4; x += 7) win(x, y + 4, 4, 5); if (rnd() < 0.4) laundry(2, y + 11, W - 4); });
    const sy = H - 13;
    for (let x = 0; x < W; x += 4) P(x, sy, 4, 3, (x / 4) % 2 ? awn[1] : awn[0]);
    P(0, sy + 3, W, 1, shade(awn[0], -0.4));
    const sw = Math.min(W - 6, 22);
    if (rnd() < 0.5) shutter(3, sy + 4, sw, H - sy - 4);
    else { E(3, sy + 4, sw, H - sy - 5, '#ffd88a'); P(3, sy + 4, sw, 1, '#c8a060'); for (let x = 5; x < 3 + sw; x += 4) P(x, sy + 6, 2, 3, pick(CLOTHES)); }
    P(W - 7, H - 9, 5, 9, '#3a2a2a');
    signs();
    return;
  }
  if (b.style === 'church') {
    const wall = '#f0e6d2';
    P(0, 0, W, rh, '#8a4a3a'); for (let y = 2; y < rh; y += 3) P(0, y, W, 1, '#7a3a2a'); P(0, rh - 1, W, 1, '#5a2a1a');
    P(0, rh, W, fh, wall); P(0, rh, W, 1, '#c8bca8');
    const cx = (W / 2) | 0;
    P(cx - 4, H - 14, 8, 14, '#5a3a2a'); P(cx - 3, H - 16, 6, 2, '#5a3a2a');
    for (let x = 4; x < W - 4; x += 10) if (Math.abs(x + 2 - cx) > 7) { E(x, rh + 6, 4, 8, rnd() < 0.5 ? '#ff9ae8' : '#9af0ff'); P(x + 1, rh + 6, 1, 8, '#5a3a5a'); }
    signs();
    return;
  }
  if (b.style === 'apartment') {
    const wall = pick(APT_WALLS);
    P(0, 0, W, rh, '#6a6676'); P(0, 0, W, 1, '#8a8696'); P(0, rh - 2, W, 2, '#4a4656');
    speckle2(P, rnd, W, rh, 8, ['#5a5666', '#7a7686']);
    if (rnd() < 0.7) tank(3, 3); if (rnd() < 0.6) ac(W - 8, 3); if (rnd() < 0.4) antenna(W - 3, 2);
    if (rnd() < 0.4 && rh > 20) solar(12, rh - 10, Math.min(15, W - 16));
    billboard();
    P(0, rh, W, fh, wall); P(0, rh, W, 1, shade(wall, -0.3));
    floors(rh, H, (y) => {
      P(0, y + TILE - 1, W, 1, shade(wall, -0.18));
      for (let x = 3; x < W - 5; x += 8) { win(x, y + 3, 5, 6, 0.4); if (rnd() < 0.35) ac(x + 1, y + 10); }
      if (y < H - TILE && rnd() < 0.55) balcony(2, y + 10, W - 4);
      if (y < H - TILE && rnd() < 0.3) laundry(3, y + 9, W - 6);
    });
    pipe(W - 2, rh + 1, H);
    const door = ((W - 8) / 2) | 0;
    P(door, H - 10, 8, 10, '#2a2a36'); E(door + 1, H - 9, 6, 1, '#ffd88a');
    if (rnd() < 0.5) tag(2, H - 7, door - 3);
    signs();
    return;
  }
  if (b.style === 'tower') {
    const trim = b.sign ? b.sign.c : pick(['#22e5ff', '#ff3fa4', '#a66bff', '#ffd23f']);
    const glass = pick(['#1d2a44', '#22203a', '#1a2e3a', '#2a1d3a']);
    P(0, 0, W, rh, '#2a2a3e'); E(0, 0, W, 1, trim); E(0, 0, 1, rh, trim); P(W - 1, 0, 1, rh, shade(trim, -0.4));
    P(2, 2, W - 4, rh - 4, '#232336');
    const roofKind = rnd();
    if (b.board) billboard();
    else if (roofKind < 0.3 && rh >= 32 && W >= 48) {
      const cx = (W / 2) | 0, cy = (rh / 2) | 0;
      P(cx - 9, cy - 9, 18, 18, '#3a3a50'); E(cx - 9, cy - 9, 18, 1, '#ffd23f'); E(cx - 9, cy + 8, 18, 1, '#ffd23f');
      E(cx - 4, cy - 5, 1, 10, '#ffd23f'); E(cx + 3, cy - 5, 1, 10, '#ffd23f'); E(cx - 4, cy, 8, 1, '#ffd23f');
    } else {
      for (let i = 0; i < Math.max(1, (W * rh) / 380); i++) { const x = 4 + ((rnd() * (W - 14)) | 0), y = 4 + ((rnd() * Math.max(1, rh - 12)) | 0); vent(x, y); }
      if (rnd() < 0.5) solar(4, rh - 10, Math.min(20, W - 10));
    }
    if (rnd() < 0.7) antenna(W - 5, 3, 8);
    if (rnd() < 0.4) antenna(4, 3, 5);
    // glass facade: floors of windows, neon trim at each floor every so often
    P(0, rh, W, fh, glass); P(0, rh, W, 2, shade(glass, -0.35));
    floors(rh, H, (y) => {
      for (let x = 2; x < W - 2; x += 4) for (let yy = y + 3; yy < y + 13 && yy < H - 10; yy += 5) win(x, yy, 3, 3, 0.4);
      if (rnd() < 0.35) E(0, y + 14, W, 1, trim);
    });
    if (rnd() < 0.5) pipe(1, rh + 2, H - 10);
    const door = ((W - 10) / 2) | 0;
    P(door, H - 9, 10, 9, '#0e1420'); E(door, H - 9, 10, 1, trim); P(door + 4, H - 8, 1, 8, '#2a3a5a');
    signs();
    return;
  }
  if (b.style === 'club') {
    P(0, 0, W, rh, '#2a1838'); P(0, 0, W, 1, '#4a2858'); P(0, rh - 2, W, 2, '#1a0e24');
    for (let i = 0; i < 3; i++) vent(4 + i * 12, 4);
    E(W - 6, 3, 2, 2, '#ff3fa4');
    P(0, rh, W, fh, '#1d1028'); P(0, rh, W, 1, '#3a1d4a');
    for (let x = 0; x < W; x += 6) E(x, rh + 11, 3, 1, x % 12 ? '#22e5ff' : '#ff3fa4');
    const door = ((W - 10) / 2) | 0;
    P(door, H - 10, 10, 10, '#0a0610'); E(door, H - 10, 10, 1, '#ff3fa4'); E(door + 1, H - 2, 8, 1, '#ffd23f');
    signs();
    return;
  }
  if (b.style === 'warehouse' || b.style === 'factory') {
    const roof = b.style === 'factory' ? '#5a5f6e' : '#6a7080';
    P(0, 0, W, rh, roof);
    if (b.style === 'factory') { for (let x = 0; x < W; x += 10) { P(x, 0, 10, rh, '#5a5f6e'); P(x, 0, 5, rh, '#7a8090'); P(x + 4, 0, 1, rh, '#3a3e48'); } }
    else for (let x = 0; x < W; x += 4) P(x, 0, 2, rh, '#5a606e');
    P(0, rh - 1, W, 1, '#3a3e48');
    if (rnd() < 0.5) { P(6, 4, 8, 5, '#8ab0d0'); P(6, 4, 8, 1, '#c0d8f0'); }
    if (b.style === 'factory') { const cx = 6 + (((b.seed / 7) | 0) % Math.max(1, b.w - 1)) * 0; void cx; }
    billboard();
    const wall = pick(['#5a606e', '#6a5a4e', '#4e5a6a', '#7a4a3a']);
    P(0, rh, W, fh, wall); P(0, rh, W, 1, shade(wall, -0.3));
    if (b.fr >= 2) for (let x = 4; x < W - 4; x += 8) win(x, rh + 4, 5, 3, 0.3);
    const dw = Math.min(W - 6, 18), dx = ((W - dw) / 2) | 0;
    P(dx, H - 13, dw, 13, '#3a3e48');
    for (let y = H - 12; y < H; y += 2) P(dx, y, dw, 1, '#4a4e58');
    for (let x = 0; x < W; x += 4) P(x, H - 2, 2, 2, '#ffd23f');
    pipe(2, rh + 1, H); if (W > 60) pipe(W - 3, rh + 1, H);
    if (rnd() < 0.6) tag(dx + 1, H - 10, dw - 2);
    E(dx - 3, H - 14, 2, 2, '#ff8a3d');
    signs();
    return;
  }
  if (b.style === 'kiosk') {
    const a = pick([['#ff3f8e', '#f2f2f2'], ['#3ddc84', '#ffd23f'], ['#22e5ff', '#f2f2f2'], ['#ff8a3d', '#ffd23f']]);
    for (let x = 0; x < W; x += 4) P(x, 0, 4, rh, x % 8 ? a[1] : a[0]);
    P(0, rh - 2, W, 2, shade(a[0], -0.3));
    P(0, rh, W, fh, '#d8b880'); P(2, rh + 4, W - 4, 3, '#8a6a40'); P(2, rh + 3, W - 4, 1, '#f0d8a0');
    E(2, rh + 8, W - 4, 1, a[0]);
    signs();
    return;
  }
  // ruin
  P(0, 0, W, H, '#6a6870'); P(0, rh, W, fh, '#58565e');
  for (let i = 0; i < 6; i++) P((rnd() * (W - 4)) | 0, (rnd() * (H - 4)) | 0, 4 + ((rnd() * 4) | 0), 3, rnd() < 0.5 ? '#3a8a3c' : '#4e4c54');
  P(2, rh + 4, 4, 4, '#1a1622');
  if (rnd() < 0.5) tag(2, rh + 9, W - 4);
}

function speckle2(P, rnd, W, H, n, cols) {
  for (let i = 0; i < n; i++) P((rnd() * W) | 0, (rnd() * H) | 0, 1, 1, cols[(rnd() * cols.length) | 0]);
}

// Hologram ad (animated, drawn each frame by the renderer): returns a cached logo+text canvas for a brand.
export function holoSprite(brand) {
  const key = 'holo' + brand;
  let c = propCache.get(key);
  if (c) return c;
  const B = BRANDS[brand];
  const word = B.name.split(/[ .]/)[0];
  const tw = word.length * 4 - 1;
  const w = Math.max(30, tw + 6), h = 26;
  c = mk(w, h);
  const g = c.getContext('2d');
  const F = (x, y, ww, hh, col) => { g.fillStyle = col; g.fillRect(x, y, ww, hh); };
  drawLogo(F, B.logo, ((w - 14) / 2) | 0, 0, B.c, B.c2, 2);
  g.drawImage(textSprite(word, B.c, null), ((w - tw) / 2) | 0, 18);
  for (let y = 1; y < h; y += 2) { g.globalCompositeOperation = 'destination-out'; g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, y, w, 1); }
  g.globalCompositeOperation = 'source-over';
  propCache.set(key, c);
  return c;
}
