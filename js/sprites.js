// All pixel art is drawn here in code: tiles, buildings, characters, enemies, arm weapons and props.
// Sprites are painted once into small canvases and cached.

import { LOOK_OPTIONS, FACTIONS, TILE } from './data.js';
import { hash2 } from './rng.js';
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
function paintDrone(frame) {
  const c = mk(18, 16), g = c.getContext('2d');
  const P = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  const y = 3 + (frame % 2);
  P(4, y + 2, 10, 5, '#d8e4ee'); P(5, y + 1, 8, 1, '#eef4fa'); P(4, y + 6, 10, 1, '#7a8ea3');
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
];

export function allySpec(gangColor, id) {
  const skins = LOOK_OPTIONS.skin;
  return {
    bulk: 1, skin: skins[(id * 7) % skins.length], hair: ['buzz', 'cap', 'braids', 'afro'][id % 4], hairColor: '#1a1414',
    top: shade(gangColor, -0.35), pants: '#23243a', mask: 'bandana', bandana: gangColor, capColor: gangColor, band: gangColor,
  };
}

// ------------------------------------------------------------------ sprite cache (characters)
const charCache = new Map();
export function charSprite(spec, dir, frame) {
  if (!spec._k) spec._k = JSON.stringify(spec);
  const key = spec._k + dir + ':' + frame;
  let c = charCache.get(key);
  if (c) return c;
  if (spec.special === 'drone') c = paintDrone(frame);
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
    case 'claw': forearm(6); P(6, m - 2, 2, 1, '#e8f6ff'); P(6, m, 3, 1, '#e8f6ff'); P(6, m + 2, 2, 1, '#e8f6ff'); break;
    default: forearm(6);
  }
  outline(c);
  armCache.set(key, c);
  return c;
}

export const ENEMY_ARM = { melee: 'claw', gun: 'pistol', shotgun: 'shotgun', burst: 'smg', slam: 'hammer', rocket: 'rocket', boss: 'rail' };

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
    let x = 16, y = 44;
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
  } else if (type === 'banana') {
    c = mk(24, 26); g = c.getContext('2d');
    P(11, 12, 2, 13, '#7a8a3a');
    const leaf = (x, y, w, h, col) => { P(x, y, w, h, col); P(x + (w >> 1), y, 1, h, shade(col, 0.3)); };
    leaf(3, 6, 8, 4, '#3fbf4f'); leaf(13, 5, 8, 4, '#35a845'); leaf(7, 1, 10, 4, '#48cc58'); leaf(2, 10, 6, 3, '#2f9e44'); leaf(16, 10, 6, 3, '#2f9e44');
    if (v % 2) { P(13, 12, 3, 4, '#d8c040'); P(13, 12, 3, 1, '#f0d860'); }
    outline(c);
    c.ax = 12; c.ay = 25;
  } else if (type === 'lamp') {
    c = mk(14, 36); g = c.getContext('2d');
    P(6, 6, 2, 30, '#3a3646'); P(6, 6, 1, 30, '#4e4a5c');
    P(4, 4, 7, 3, '#2a2636'); P(5, 7, 5, 1, v ? '#9af0ff' : '#fff0c0');
    P(5, 34, 4, 2, '#2a2636');
    outline(c);
    c.ax = 7; c.ay = 35;
  } else if (type === 'umbrella') {
    c = mk(22, 22); g = c.getContext('2d');
    const cols = [['#ff3f8e', '#f2f2f2'], ['#ffd23f', '#3ddc84'], ['#22e5ff', '#f2f2f2'], ['#ff8a3d', '#ffd23f']][v % 4];
    P(10, 8, 2, 13, '#d8d0c0');
    for (let i = 0; i < 9; i++) P(2 + i * 2, 4 + Math.abs(4 - i) * 0.5 | 0, 2, 5 - (Math.abs(4 - i) * 0.5 | 0), cols[i % 2]);
    P(10, 2, 2, 2, cols[0]);
    P(4, 19, 6, 2, '#f0e0b0'); P(13, 19, 5, 2, '#ff6a8e');
    outline(c);
    c.ax = 11; c.ay = 20;
  } else if (type === 'barrel') {
    c = mk(12, 20); g = c.getContext('2d');
    P(2, 9, 8, 10, '#7a3b22'); P(2, 11, 8, 1, '#5a2a18'); P(2, 15, 8, 1, '#5a2a18'); P(8, 9, 2, 10, '#5a2a18'); P(2, 9, 8, 1, '#2a1510');
    const fl = ['#ff8a3d', '#ffd23f', '#ff3b5c'];
    const f = frame % 3;
    P(3, 6 - f % 2, 6, 3 + f % 2, fl[0]); P(4, 3 + f, 3, 4 - f, fl[1]); P(6, 2 + (2 - f), 2, 3, fl[f === 1 ? 2 : 1]);
    outline(c);
    c.ax = 6; c.ay = 19;
  } else if (type === 'car') {
    c = mk(34, 20); g = c.getContext('2d');
    const cols = ['#b8432f', '#2f6fb8', '#e8e4d8', '#3a3646', '#d8902f', '#8a3fb8', '#3f9a4f'];
    const col = cols[v % cols.length];
    P(3, 7, 28, 9, col); P(3, 7, 28, 1, shade(col, 0.3)); P(3, 15, 28, 1, shade(col, -0.4));
    P(9, 3, 15, 6, shade(col, -0.1)); P(10, 4, 6, 4, '#1d3a5a'); P(17, 4, 6, 4, '#1d3a5a'); P(10, 4, 2, 1, '#9af0ff');
    P(29, 9, 2, 2, '#fff6c0'); P(3, 9, 2, 2, '#ff3b5c');
    P(5, 16, 24, 2, ['#22e5ff', '#ff3fa4', '#3ddc84'][v % 3]);
    if (v % 4 === 0) { P(12, 10, 4, 2, '#5a2a18'); P(22, 12, 3, 2, '#5a2a18'); }
    outline(c);
    c.ax = 17; c.ay = 18;
  } else if (type === 'station') {
    c = mk(26, 30); g = c.getContext('2d');
    const kind = ['arsenal', 'clinic', 'locker', 'vault'][v];
    if (kind === 'arsenal') {
      P(2, 8, 22, 18, '#2a2636'); P(2, 8, 22, 1, '#4e4a5c');
      for (let i = 0; i < 4; i++) { P(4 + i * 5, 11, 2, 12, '#aeb9c9'); P(4 + i * 5, 11, 2, 2, ['#ff3fa4', '#22e5ff', '#ffd23f', '#3ddc84'][i]); }
      P(2, 26, 22, 3, '#1b1b24');
    } else if (kind === 'clinic') {
      P(4, 14, 18, 6, '#d8e4ee'); P(4, 14, 18, 1, '#ffffff'); P(18, 9, 4, 6, '#d8e4ee'); P(6, 20, 2, 7, '#56606e'); P(18, 20, 2, 7, '#56606e');
      P(9, 4, 6, 2, '#3ddc84'); P(11, 2, 2, 6, '#3ddc84'); P(2, 9, 3, 1, '#9aa6b8'); P(1, 10, 1, 5, '#9aa6b8');
    } else if (kind === 'locker') {
      for (let i = 0; i < 2; i++) { P(3 + i * 11, 4, 10, 24, '#3a5a7a'); P(3 + i * 11, 4, 10, 1, '#5a7a9a'); P(5 + i * 11, 7, 6, 1, '#1b2a3a'); P(5 + i * 11, 9, 6, 1, '#1b2a3a'); P(11 + i * 11, 15, 1, 3, '#d8e4ee'); }
    } else {
      P(3, 6, 20, 22, '#4a4a56'); P(3, 6, 20, 1, '#7a7a86'); P(5, 8, 16, 18, '#3a3a46'); P(11, 13, 5, 5, '#ffd23f'); P(13, 15, 1, 1, '#3a3a46'); P(18, 12, 2, 8, '#8a8a96');
    }
    outline(c);
    c.ax = 13; c.ay = 28;
  } else {
    c = mk(4, 4); c.ax = 2; c.ay = 4;
  }
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
  }, 4);
  set[T.SAND] = tile((g, v) => {
    fill(g, '#e9cf94'); speckle(g, rnd, 24, ['#dcbf80', '#f4dfaa', '#e2c588']);
    if (v === 1) { P(g, 6, 7, 2, 1, '#ffffff'); P(g, 7, 6, 1, 1, '#ffd0d8'); }
  }, 4);
  set[T.ROAD] = tile((g, v) => {
    fill(g, '#2b2a35'); speckle(g, rnd, 30, ['#24232c', '#33323e', '#2f2e3a']);
    if (v === 1) { P(g, 3, 4, 1, 3, '#1b1a22'); P(g, 4, 6, 3, 1, '#1b1a22'); P(g, 6, 7, 1, 3, '#1b1a22'); }
    if (v === 2) { P(g, 4, 6, 8, 5, '#2a2246'); P(g, 5, 5, 6, 1, '#2a2246'); P(g, 6, 7, 3, 1, '#ff4fd8'); P(g, 8, 9, 2, 1, '#22e5ff'); }
    if (v === 3) { P(g, 5, 5, 6, 6, '#3a3946'); P(g, 6, 6, 4, 4, '#2a2934'); P(g, 6, 7, 4, 1, '#3a3946'); P(g, 6, 9, 4, 1, '#3a3946'); }
  }, 6);
  set[T.SIDEWALK] = tile((g, v) => {
    fill(g, '#8e8a99'); speckle(g, rnd, 12, ['#85818f', '#97939f']);
    P(g, 0, 0, 16, 1, '#7a7686'); P(g, 0, 8, 16, 1, '#7a7686'); P(g, 0, 0, 1, 16, '#7a7686'); P(g, 8, 0, 1, 8, '#7a7686'); P(g, 4, 8, 1, 8, '#7a7686'); P(g, 12, 8, 1, 8, '#7a7686');
    P(g, 1, 1, 7, 1, '#a19dab');
    if (v === 2) { P(g, 10, 3, 3, 2, '#3a3a3a'); P(g, 11, 2, 1, 1, '#5a5a5a'); }
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
    if (v === 2) { P(g, 9, 2, 1, 4, '#564f66'); P(g, 10, 5, 3, 1, '#564f66'); }  }, 4);
  set[T.METAL] = tile((g, v) => {
    fill(g, '#4a5260'); P(g, 0, 0, 16, 1, '#3c434f'); P(g, 0, 0, 1, 16, '#3c434f'); P(g, 1, 1, 15, 1, '#5a6372');
    P(g, 2, 2, 1, 1, '#6a7484'); P(g, 13, 2, 1, 1, '#6a7484'); P(g, 2, 13, 1, 1, '#6a7484'); P(g, 13, 13, 1, 1, '#6a7484');
    if (v === 1) for (let i = 0; i < 4; i++) P(g, 3 + i * 3, 7, 2, 2, i % 2 ? '#1b1b24' : '#ffd23f');
    if (v === 2) { P(g, 5, 6, 6, 4, '#5a3a2a'); P(g, 6, 7, 3, 2, '#6a4a32'); }
  }, 4);
  set[T.STAIRS] = tile((g, v) => {
    fill(g, '#8a7f78'); speckle(g, rnd, 10, ['#7f746d', '#958a83']);
    for (let y = 3; y < 16; y += 4) { P(g, 0, y, 16, 1, '#6a605a'); P(g, 0, y + 1, 16, 1, '#a49890'); }
    if (v === 1) { P(g, 11, 6, 3, 2, '#4a7a3a'); }
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
  set[T.CONCRETE + 100] = set[T.CONCRETE];
  return set;
}

// ------------------------------------------------------------------ buildings
const FAVELA_WALLS = ['#d9826a', '#e8c26a', '#7fb8d6', '#9ad17a', '#e89ab8', '#b5653f', '#f0e6d2', '#c8a0e8', '#ff9a5a'];
const HOUSE_WALLS = ['#f0e6d2', '#e8d0a8', '#a8d8e8', '#f0b8c8', '#c8e8b0', '#ffd8a0'];
const CONTAINER = ['#b8432f', '#2f6fb8', '#3f9a4f', '#d8902f', '#8a3fb8', '#2f9ab8'];

export function drawBuilding(g, b, ox, oy) {
  const P = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(ox + x, oy + y, w, h); };
  let s = b.seed | 0 || 1;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const W = b.w * TILE, H = b.h * TILE;
  const fh = b.fr * TILE;          // facade height
  const rh = H - fh;               // roof height
  const pick = (arr) => arr[(rnd() * arr.length) | 0];
  const signPanel = () => {
    if (!b.sign) return;
    const t = textSprite(b.sign.text, b.sign.c, '#120a1c');
    const sx = ((W - t.width) / 2) | 0, sy = rh + 1;
    P(sx - 2, sy - 1, t.width + 4, t.height + 2, '#120a1c');
    g.drawImage(t, ox + sx, oy + sy);
  };

  if (b.style === 'container') {
    const col = CONTAINER[b.seed % CONTAINER.length];
    P(0, 1, W, H - 2, col); P(0, 1, W, 1, shade(col, 0.3)); P(0, H - 2, W, 1, shade(col, -0.4));
    for (let x = 2; x < W - 1; x += 3) P(x, 2, 1, H - 4, shade(col, -0.2));
    P(1, 3, 3, 3, '#f2f2f2');
    return;
  }
  if (b.style === 'favela') {
    const wall = pick(FAVELA_WALLS);
    const brick = rnd() < 0.35;
    // roof (laje)
    P(0, 0, W, rh, '#8a8590'); P(0, 0, W, 1, '#a8a3ae'); P(0, rh - 2, W, 2, '#6a6570');
    speckle2(P, rnd, W, rh, 10, ['#7f7a85', '#96919c']);
    if (rnd() < 0.75) { const tx = 2 + ((rnd() * (W - 12)) | 0), ty = 2 + ((rnd() * Math.max(1, rh - 10)) | 0); P(tx, ty, 9, 7, '#2f68b8'); P(tx, ty, 9, 2, '#5a8ad8'); P(tx + 1, ty + 6, 7, 1, '#1d4a8a'); P(tx + 3, ty + 1, 3, 1, '#8ab0f0'); }
    if (rnd() < 0.4) { const dx = W - 7, dy = 2; P(dx, dy, 5, 4, '#d8d8e0'); P(dx + 1, dy + 1, 3, 2, '#a8a8b8'); P(dx + 2, dy + 4, 1, 2, '#56606e'); }
    if (rnd() < 0.5) for (let i = 0; i < 3; i++) P(1 + i * 3, 1, 1, 3, '#5a3a2a');
    // facade
    P(0, rh, W, fh, wall);
    if (brick) for (let y = rh; y < H; y += 3) for (let x = (y % 6 ? 0 : 2); x < W; x += 5) P(x, y, 4, 2, shade('#b5653f', (rnd() - 0.5) * 0.15));
    P(0, rh, W, 1, shade(wall, -0.35));
    const door = 2 + ((rnd() * (W - 8)) | 0);
    P(door, H - 10, 5, 10, '#3a2a2a'); P(door + 1, H - 9, 3, 8, pick(['#4a6a8a', '#8a3a3a', '#3a6a4a', '#5a4a3a']));
    for (let x = 2; x < W - 4; x += 8) if (Math.abs(x - door) > 6) { P(x, rh + 4, 4, 4, rnd() < 0.5 ? '#ffd88a' : '#1a1622'); P(x - 1, rh + 3, 6, 1, shade(wall, -0.3)); }
    if (rnd() < 0.5) pixacao(P, rnd, W, rh, fh);
    return;
  }
  if (b.style === 'house') {
    const wall = pick(HOUSE_WALLS), roof = pick(['#c4553a', '#b84a30', '#d0683f', '#7a4a6a']);
    P(0, 0, W, rh, roof);
    for (let y = 2; y < rh; y += 3) P(0, y, W, 1, shade(roof, -0.2));
    P(0, (rh / 2) | 0, W, 1, shade(roof, 0.25));
    P(0, rh - 1, W, 1, shade(roof, -0.45));
    P(0, rh, W, fh, wall); P(0, rh, W, 1, shade(wall, -0.3));
    const door = ((W - 6) / 2) | 0;
    P(door, H - 11, 6, 11, '#5a3a2a'); P(door + 4, H - 6, 1, 1, '#ffd23f');
    for (let x = 3; x < W - 5; x += 9) if (Math.abs(x - door) > 6) { P(x, rh + 3, 6, 5, rnd() < 0.6 ? '#ffd88a' : '#22314a'); P(x, rh + 3, 6, 1, '#f2f2f2'); P(x + 2, rh + 3, 1, 5, '#f2f2f2'); }
    if (rnd() < 0.4) { P(W - 7, rh + 2, 5, 3, '#d8d8e0'); P(W - 6, rh + 3, 3, 1, '#8a8a96'); }
    signPanel();
    return;
  }
  if (b.style === 'tower') {
    const roof = '#2a2a3e', trim = b.sign ? b.sign.c : pick(['#22e5ff', '#ff3fa4', '#a66bff']);
    P(0, 0, W, rh, roof); P(0, 0, W, 1, trim); P(0, 0, 1, rh, trim); P(W - 1, 0, 1, rh, shade(trim, -0.4));
    P(2, 2, W - 4, rh - 4, '#232336');
    for (let i = 0; i < Math.max(1, (W * rh) / 400); i++) { const x = 4 + ((rnd() * (W - 14)) | 0), y = 4 + ((rnd() * Math.max(1, rh - 12)) | 0); P(x, y, 8, 6, '#4a4a5e'); P(x, y, 8, 1, '#6a6a7e'); P(x + 2, y + 2, 4, 2, '#2a2a3e'); }
    if (rnd() < 0.4 && rh > 24) { const cx = (W / 2) | 0, cy = (rh / 2) | 0; P(cx - 6, cy - 6, 12, 12, '#3a3a50'); P(cx - 3, cy - 4, 1, 8, '#ffd23f'); P(cx + 2, cy - 4, 1, 8, '#ffd23f'); P(cx - 3, cy, 6, 1, '#ffd23f'); }
    if (rnd() < 0.6) { P(W - 5, 2, 1, 6, '#56606e'); P(W - 5, 1, 1, 1, '#ff3b5c'); }
    // glass facade with lit windows
    P(0, rh, W, fh, '#1d2a44'); P(0, rh, W, 2, '#121a2c');
    for (let y = rh + 3; y < H - 10; y += 5) for (let x = 2; x < W - 2; x += 4) {
      const r = rnd();
      P(x, y, 3, 3, r < 0.25 ? '#ffd88a' : r < 0.35 ? '#22e5ff' : r < 0.42 ? '#ff4fd8' : '#2a3a5a');
    }
    const door = ((W - 10) / 2) | 0;
    P(door, H - 9, 10, 9, '#0e1420'); P(door, H - 9, 10, 1, trim); P(door + 4, H - 8, 1, 8, '#2a3a5a');
    signPanel();
    return;
  }
  if (b.style === 'warehouse') {
    const roof = '#6a7080';
    P(0, 0, W, rh, roof);
    for (let x = 0; x < W; x += 4) P(x, 0, 2, rh, '#5a606e');
    P(0, rh - 1, W, 1, '#3a3e48');
    if (rnd() < 0.5) { P(6, 4, 8, 5, '#8ab0d0'); P(6, 4, 8, 1, '#c0d8f0'); }
    const wall = pick(['#5a606e', '#6a5a4e', '#4e5a6a']);
    P(0, rh, W, fh, wall); P(0, rh, W, 1, shade(wall, -0.3));
    const dw = Math.min(W - 6, 18), dx = ((W - dw) / 2) | 0;
    P(dx, rh + 3, dw, fh - 3, '#3a3e48');
    for (let y = rh + 4; y < H; y += 2) P(dx, y, dw, 1, '#4a4e58');
    for (let x = 0; x < W; x += 4) P(x, H - 2, 2, 2, '#ffd23f');
    if (rnd() < 0.5) pixacao(P, rnd, W, rh, fh);
    signPanel();
    return;
  }
  if (b.style === 'kiosk') {
    const a = pick([['#ff3f8e', '#f2f2f2'], ['#3ddc84', '#ffd23f'], ['#22e5ff', '#f2f2f2'], ['#ff8a3d', '#ffd23f']]);
    for (let x = 0; x < W; x += 4) P(x, 0, 4, rh, x % 8 ? a[1] : a[0]);
    P(0, rh - 2, W, 2, shade(a[0], -0.3));
    P(0, rh, W, fh, '#d8b880'); P(2, rh + 4, W - 4, 3, '#8a6a40'); P(2, rh + 3, W - 4, 1, '#f0d8a0');
    signPanel();
    return;
  }
  // ruin
  P(0, 0, W, H, '#6a6870'); P(0, rh, W, fh, '#58565e');
  for (let i = 0; i < 6; i++) P((rnd() * (W - 4)) | 0, (rnd() * (H - 4)) | 0, 4 + ((rnd() * 4) | 0), 3, rnd() < 0.5 ? '#3a8a3c' : '#4e4c54');
  P(2, rh + 4, 4, 4, '#1a1622');
}

function speckle2(P, rnd, W, H, n, cols) {
  for (let i = 0; i < n; i++) P((rnd() * W) | 0, (rnd() * H) | 0, 1, 1, cols[(rnd() * cols.length) | 0]);
}

// pichação-style tags (abstract glyph strokes)
function pixacao(P, rnd, W, rh, fh) {
  const y0 = rh + 2 + ((rnd() * Math.max(1, fh - 10)) | 0);
  let x = 2 + ((rnd() * 4) | 0);
  const col = rnd() < 0.7 ? '#141018' : ['#ff3f8e', '#22e5ff', '#ffd23f'][(rnd() * 3) | 0];
  const n = 2 + ((rnd() * 4) | 0);
  for (let i = 0; i < n && x < W - 4; i++) {
    const h = 4 + ((rnd() * 3) | 0);
    P(x, y0, 1, h, col);
    if (rnd() < 0.6) P(x, y0, 3, 1, col);
    if (rnd() < 0.5) P(x + 2, y0, 1, h, col);
    if (rnd() < 0.4) P(x, y0 + h - 1, 3, 1, col);
    x += 4;
  }
}
