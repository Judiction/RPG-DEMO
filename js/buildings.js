// GTA2-style 3D buildings: every building is a box with textured walls and a roof.
// The renderer projects them with a perspective camera, so walls lean away from the center of the screen.
//
// Per building we paint (once): a roof texture and 4 wall textures, plus "emissive" layers (neon, lit windows)
// in 2 animation states (e.g. neon on/off, or color A/B). Then we "bake" them for the current light:
// base × ambient color (with a fixed per-side shade, so the box reads as 3D) + lit windows + neon at full brightness.
// Baked results are cached and only rebuilt when the light level or the window pattern changes.

import { TILE, BRANDS } from './data.js';
import { mk, shade, drawLogo } from './sprites.js';
import { textSprite } from './font.js';
import { hash2 } from './rng.js';

export const CAM_Z = 560;                  // camera height (px). Smaller = stronger perspective
export const projK = (z) => CAM_Z / (CAM_Z - Math.min(z, CAM_Z * 0.7));

// Neon animation state, shared by signs (baked in 2 states) and their lights.
// For flicker/broken: 1 = off for a moment. For swap/chase/strobe: 1 = second color.
export function neonState(anim, seed, t) {
  switch (anim) {
    case 'flicker': { const k = Math.floor(t * 11 + seed); return hash2(k, 7, seed | 0) < 0.16 || (hash2(k >> 3, 9, seed | 0) < 0.12 && k % 2) ? 1 : 0; }
    case 'broken': { const k = Math.floor(t * 6 + seed); return hash2(k, 3, seed | 0) < 0.3 ? 1 : 0; }
    case 'swap': return Math.floor(t / 1.4 + seed) % 2;
    case 'chase': return Math.floor(t * 4 + seed) % 2;
    case 'strobe': return Math.floor(t * 6 + seed) % 2;
    default: return 0;
  }
}
export const neonIsOff = (anim, st) => st === 1 && (anim === 'flicker' || anim === 'broken');

const SIDE_SHADE = { roof: 1.0, S: 0.92, E: 0.78, W: 0.64, N: 0.52 };
const FAVELA_WALLS = ['#d9826a', '#e8c26a', '#7fb8d6', '#9ad17a', '#e89ab8', '#b5653f', '#f0e6d2', '#c8a0e8', '#ff9a5a', '#a8d8c0'];
const HOUSE_WALLS = ['#f0e6d2', '#e8d0a8', '#a8d8e8', '#f0b8c8', '#c8e8b0', '#ffd8a0'];
const APT_WALLS = ['#d8c8b0', '#a8b8c8', '#c8a8a0', '#b0c8b0', '#e0d0e8', '#8a9aaa', '#c0b090'];
const GLASS = ['#1d2a44', '#22203a', '#1a2e3a', '#2a1d3a', '#18283a'];
const CONTAINER = ['#b8432f', '#2f6fb8', '#3f9a4f', '#d8902f', '#8a3fb8', '#2f9ab8'];
const CLOTHES = ['#ff3f8e', '#22e5ff', '#ffd23f', '#f2f2f2', '#3ddc84', '#ff8a3d', '#a66bff'];
const LIT = ['#ffd88a', '#ffd88a', '#ffd88a', '#ffe8b0', '#ffe8b0', '#fff2d0', '#ffb86a', '#ffb86a', '#9af0ff', '#ff9ae8'];

// ------------------------------------------------------------------ painting helpers
function surface(w, h) {
  const base = mk(w, h), e0 = mk(w, h), e1 = mk(w, h);
  const g = base.getContext('2d'), g0 = e0.getContext('2d'), g1 = e1.getContext('2d');
  const P = (x, y, ww, hh, col) => { g.fillStyle = col; g.fillRect(x | 0, y | 0, ww, hh); };
  // emissive in both states / only state 0 / only state 1
  const E = (x, y, ww, hh, col, col2 = col) => { P(x, y, ww, hh, col); g0.fillStyle = col; g0.fillRect(x | 0, y | 0, ww, hh); if (col2) { g1.fillStyle = col2; g1.fillRect(x | 0, y | 0, ww, hh); } };
  return { w, h, base, e0, e1, g, g0, g1, P, E, wins: [], anim: false };
}
const rngOf = (seed) => { let s = (seed | 0) % 2147483646 + 1; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; };

function speckle(P, rnd, x, y, w, h, n, cols) { for (let i = 0; i < n; i++) P(x + rnd() * w, y + rnd() * h, 1, 1, cols[(rnd() * cols.length) | 0]); }

// a window: unlit glass painted on the base; the bake step lights some of them up
function win(S, x, y, w, h, p = 1, frame = null) {
  if (frame) { S.P(x - 1, y - 1, w + 2, h + 2, frame); }
  S.P(x, y, w, h, '#141c2c');
  S.P(x, y, w, 1, '#2e3e5a');
  if (w > 2) S.P(x + w - 1, y + 1, 1, h - 1, '#0c1220');
  S.wins.push({ x, y, w, h, p });
}
function tag(S, rnd, x, y, w) {
  const col = rnd() < 0.6 ? '#141018' : ['#ff3f8e', '#22e5ff', '#ffd23f', '#3ddc84', '#f2f2f2'][(rnd() * 5) | 0];
  let xx = x;
  for (let i = 0; i < 5 && xx < x + w - 2; i++) {
    const hh = 3 + ((rnd() * 3) | 0);
    S.P(xx, y, 1, hh, col); if (rnd() < 0.6) S.P(xx, y, 3, 1, col); if (rnd() < 0.5) S.P(xx + 2, y, 1, hh, col); if (rnd() < 0.3) S.P(xx, y + hh - 1, 3, 1, col);
    xx += 4;
  }
}
function pipe(S, x, y0, y1) { S.P(x, y0, 1, y1 - y0, '#56606e'); S.P(x + 1, y0, 1, y1 - y0, '#3a3d48'); for (let y = y0 + 4; y < y1; y += 7) S.P(x - 1, y, 3, 1, '#2a2d38'); }
function acUnit(S, x, y) { S.P(x, y, 5, 4, '#c8c8d0'); S.P(x, y, 5, 1, '#e8e8f0'); S.P(x + 1, y + 1, 3, 2, '#8a8a96'); S.P(x + 2, y + 4, 1, 3, '#3a6a8a'); }
function stains(S, rnd, n) { for (let i = 0; i < n; i++) { const x = (rnd() * S.w) | 0, y = (rnd() * S.h * 0.6) | 0; S.P(x, y, 1, 4 + rnd() * 10, 'rgba(0,0,0,0.12)'); } }
function bricks(S, rnd, x0, y0, w, h, col) {
  for (let y = y0; y < y0 + h; y += 3) for (let x = x0 + ((y / 3) % 2 ? 0 : 2); x < x0 + w; x += 5) S.P(x, y, 4, 2, shade(col, (rnd() - 0.5) * 0.18));
}
function cornice(S, col) { S.P(0, 0, S.w, 3, shade(col, 0.18)); S.P(0, 3, S.w, 1, shade(col, -0.4)); }
function groundLine(S) { S.P(0, S.h - 2, S.w, 2, 'rgba(0,0,0,0.35)'); }

// neon sign helpers (emissive)
function signPanel(S, B, cx, y, anim) {
  const name = B.name.length * 4 > S.w - 14 ? B.name.split(/[ .]/)[0] : B.name;
  const tw = name.length * 4 - 1;
  const pw = Math.min(S.w - 2, tw + 13);
  const px = Math.max(1, Math.round(cx - pw / 2));
  const c2 = anim === 'swap' ? B.c2 : anim === 'flicker' ? null : B.c;
  S.P(px, y, pw, 11, '#0c0814');
  S.E(px, y, pw, 1, B.c, c2); S.E(px, y + 10, pw, 1, B.c, c2); S.E(px, y, 1, 11, B.c, c2); S.E(px + pw - 1, y, 1, 11, B.c, c2);
  drawLogo((x, yy, w, h, col) => S.E(x, yy, w, h, col, anim === 'swap' ? B.c : c2 ? col : null), B.logo, px + 2, y + 2, B.c, B.c2);
  const tc = B.c2 && B.c2 !== '#ffffff' ? B.c : '#ffffff';
  const t0 = textSprite(name, tc, null), t1 = anim === 'flicker' ? null : textSprite(name, anim === 'swap' ? B.c2 : tc, null);
  S.g.drawImage(t0, px + 11, y + 3); S.g0.drawImage(t0, px + 11, y + 3); if (t1) S.g1.drawImage(t1, px + 11, y + 3);
  S.anim = S.anim || anim !== 'steady';
}
function signVertical(S, B, x, y0, y1, anim) {
  const letters = B.name.replace(/[^A-Z0-9+]/g, '');
  const n = Math.max(2, Math.min(letters.length, Math.floor((y1 - y0 - 10) / 6)));
  const h = n * 6 + 10;
  const c2 = anim === 'swap' ? B.c2 : anim === 'flicker' ? null : B.c;
  S.P(x - 1, y0 - 1, 8, h + 2, '#0c0814');
  S.E(x - 1, y0 - 1, 8, 1, B.c, c2); S.E(x - 1, y0 + h, 8, 1, B.c, c2); S.E(x - 1, y0 - 1, 1, h + 2, B.c, c2); S.E(x + 6, y0 - 1, 1, h + 2, B.c, c2);
  drawLogo((xx, yy, w, hh, col) => S.E(xx, yy, w, hh, B.c2 || col, c2 ? B.c2 || col : null), B.logo, x, y0 + 1, B.c2, null);
  for (let i = 0; i < n; i++) {
    const t0 = textSprite(letters[i], B.c, null), t1 = anim === 'flicker' ? null : textSprite(letters[i], anim === 'swap' ? B.c2 : B.c, null);
    S.g.drawImage(t0, x + 2, y0 + 9 + i * 6); S.g0.drawImage(t0, x + 2, y0 + 9 + i * 6); if (t1) S.g1.drawImage(t1, x + 2, y0 + 9 + i * 6);
  }
  S.anim = S.anim || anim !== 'steady';
}

// ------------------------------------------------------------------ walls
function paintWall(b, side, len, rnd, tint = '#ff3f8e') {
  const H = b.H;
  const S = surface(len, H);
  const { P } = S;
  const F = 13, fl = b.floors;
  const front = side === 'S';
  const floorY = (f) => 4 + f * F;                       // top of floor f (0 = top floor)
  const st = b.style;
  const pick = (a) => a[(rnd() * a.length) | 0];
  if (st === 'cwall') {
    // compound wall: concrete panels with the owner's color band and lights
    const big = H >= 18;
    P(0, 0, len, H, '#4a4656');
    for (let x = 0; x < len; x += 16) { P(x, 0, 1, H, '#3a3646'); P(x + 1, 0, 1, H, '#5a566a'); }
    speckle(P, rnd, 0, 0, len, H, len / 2, ['#423e4e', '#56526a']);
    P(0, 0, len, 2, '#8a8698'); P(0, 2, len, 1, '#2a2636');
    P(0, big ? 5 : 4, len, big ? 4 : 3, shade(tint, -0.25));
    S.E(0, big ? 6 : 5, len, 1, tint);
    for (let x = 6; x < len; x += 16) S.E(x, big ? 12 : 9, 2, 1, shade(tint, 0.4));
    if (big) for (let x = 0; x < len; x += 6) P(x, H - 3, 3, 2, x % 12 ? '#141018' : '#ffd23f');
    if (rnd() < 0.4) tag(S, rnd, 3 + ((rnd() * Math.max(1, len - 20)) | 0), H - (big ? 9 : 7), 18);
    groundLine(S);
    return S;
  }
  if (st === 'hq') {
    // main-base building: dark armored walls, gang-color trims, a big lit door facing the yard
    const K = { arsenal: '#ff3f8e', clinic: '#3ddc84', locker: '#22e5ff', vault: '#ffd23f' }[b.kind] || '#fff';
    P(0, 0, len, H, '#2e2a3a');
    for (let x = 0; x < len; x += 8) P(x, 0, 1, H, '#26222f');
    cornice(S, '#3e3a4e');
    S.E(0, 4, len, 1, tint);
    for (let f = 0; f < fl; f++) {
      const y0 = floorY(f);
      P(0, floorY(f + 1) - 1, len, 1, '#1e1a28');
      if (f < fl - 1) for (let x = 4; x < len - 6; x += 9) win(S, x, y0 + 3, 6, 4, 1.4, '#1a1622');
    }
    const doorSide = b.doorN ? 'N' : 'S';
    if (side === doorSide) {
      const dw = Math.min(len - 8, 22), dx = ((len - dw) / 2) | 0;
      P(dx - 2, H - 15, dw + 4, 15, '#1a1622');
      S.E(dx, H - 13, dw, 13, shade(K, -0.55));
      for (let y = H - 12; y < H; y += 2) P(dx, y, dw, 1, 'rgba(0,0,0,0.25)');
      S.E(dx - 2, H - 15, dw + 4, 1, K); S.E(dx - 2, H - 15, 1, 15, K); S.E(dx + dw + 1, H - 15, 1, 15, K);
      for (let x = 0; x < len; x += 4) P(x, H - 2, 2, 2, x % 8 ? '#141018' : '#ffd23f');
    } else if (rnd() < 0.6) pipe(S, len - 4, 4, H);
    S.E(0, H - 1, len, 1, shade(tint, -0.2));
    return S;
  }
  if (st === 'shack') {
    // outpost shack: patched plaster + corrugated metal, gang tag in the owner's color
    const col = pick(['#b8a088', '#c89a7a', '#8aa0a8', '#a8b090', '#c8b8a0', '#9a8070']);
    P(0, 0, len, H, col);
    speckle(P, rnd, 0, 0, len, H, len, [shade(col, -0.1), shade(col, 0.08)]);
    if (rnd() < 0.5) bricks(S, rnd, 0, H / 2, len, H / 2, '#a0583a');
    for (let x = (rnd() * 8) | 0; x < len - 6; x += 12) { P(x, 3, 8, H - 6, '#7a8090'); for (let xx = x; xx < x + 8; xx += 2) P(xx, 3, 1, H - 6, '#5a606e'); }
    cornice(S, col);
    for (let x = 3; x < len - 4; x += 9) win(S, x, 6, 3, 4, 1.2, '#3a2a2a');
    if (side === (b.doorN ? 'N' : 'S')) { const d = (len / 2 - 3) | 0; P(d, H - 10, 6, 10, '#2a1e1e'); S.E(d + 1, H - 10, 4, 1, '#ffd88a'); }
    // painted gang tag (owner color)
    let xx = 2 + ((rnd() * 4) | 0);
    for (let i = 0; i < 4 && xx < len - 4; i++) { const hh = 3 + ((rnd() * 3) | 0); P(xx, H - 8, 1, hh, tint); P(xx, H - 8, 3, 1, tint); if (rnd() < 0.5) P(xx + 2, H - 8, 1, hh, tint); xx += 4; }
    groundLine(S);
    return S;
  }
  if (st === 'bar') {
    const col = pick(['#2a1838', '#1d1028', '#2a2030', '#3a1a28']);
    P(0, 0, len, H, col);
    bricks(S, rnd, 0, 4, len, H - 4, shade(col, 0.15));
    cornice(S, '#3a2a4a');
    for (let f = 0; f < fl - 1; f++) for (let x = 4; x < len - 5; x += 8) win(S, x, floorY(f) + 3, 4, 5, 1.5, '#1a1020');
    if (side === 'S') {
      const name = (b.barName || 'BAR').toUpperCase();
      const tw = Math.min(len - 6, name.length * 4 + 4);
      const y = H - 26;
      P(((len - tw) / 2 | 0) - 2, y - 1, tw + 4, 10, '#0c0814');
      for (let i = 0; i < tw + 4; i += 2) { S.E(((len - tw) / 2 | 0) - 2 + i, y - 1, 1, 1, i % 4 ? '#ff3fa4' : '#ffd23f', i % 4 ? '#ffd23f' : '#ff3fa4'); S.E(((len - tw) / 2 | 0) - 2 + i, y + 8, 1, 1, i % 4 ? '#22e5ff' : '#ff3fa4', i % 4 ? '#ff3fa4' : '#22e5ff'); }
      const t0 = textSprite(name.slice(0, Math.floor((tw - 2) / 4)), '#ff3fa4', null), t1 = textSprite(name.slice(0, Math.floor((tw - 2) / 4)), '#22e5ff', null);
      const tx = ((len - t0.width) / 2) | 0;
      S.g.drawImage(t0, tx, y + 2); S.g0.drawImage(t0, tx, y + 2); S.g1.drawImage(t1, tx, y + 2);
      const d = (len / 2 - 4) | 0;
      P(d - 1, H - 13, 10, 13, '#0a0610');
      S.E(d, H - 12, 8, 12, '#3a1040', '#10304a');
      S.E(d - 1, H - 13, 10, 1, '#ff3fa4', '#22e5ff');
      // posters
      for (const px of [3, len - 9]) { P(px, H - 14, 6, 8, pick(['#ff3f8e', '#ffd23f', '#22e5ff', '#3ddc84'])); P(px + 1, H - 12, 4, 1, '#120a1c'); P(px + 1, H - 10, 3, 1, '#120a1c'); }
      S.anim = true;
    }
    groundLine(S);
    return S;
  }
  if (st === 'container') {
    const col = CONTAINER[b.seed % CONTAINER.length];
    P(0, 0, len, H, col); P(0, 0, len, 1, shade(col, 0.35)); P(0, H - 1, len, 1, shade(col, -0.45));
    for (let x = 1; x < len; x += 3) P(x, 1, 1, H - 2, shade(col, -0.22));
    if (side === 'S' || side === 'N') { P(2, 2, 3, 3, '#f2f2f2'); if (b.seed % 3 === 0) tag(S, rnd, 6, 2, len - 8); }
    return S;
  }
  if (st === 'favela') {
    let prev = pick(FAVELA_WALLS);
    for (let f = 0; f < fl; f++) {
      const col = f === 0 ? prev : (prev = rnd() < 0.6 ? pick(FAVELA_WALLS) : prev);
      const y0 = f === 0 ? 0 : floorY(f), y1 = floorY(f + 1);
      P(0, y0, len, y1 - y0, col);
      speckle(P, rnd, 0, y0, len, y1 - y0, len * 0.6, [shade(col, -0.08), shade(col, 0.06)]);
      if (rnd() < 0.35) bricks(S, rnd, 0, y0 + 2, len, y1 - y0 - 2, '#b5653f');
      P(0, y1 - 1, len, 1, shade(col, -0.35));
      const ground = f === fl - 1;
      for (let x = 2 + ((rnd() * 4) | 0); x < len - 4; x += 7 + ((rnd() * 5) | 0)) {
        if (ground && front && x > len / 2 - 6 && x < len / 2 + 4) continue;
        win(S, x, y0 + 4 + ((rnd() * 2) | 0), 3, 4, 0.9, shade(col, -0.3));
      }
      if (!ground && rnd() < 0.35) { const lx = 2 + ((rnd() * (len - 16)) | 0); P(lx, y1 - 4, 14, 1, '#c8c0b0'); for (let i = 1; i < 13; i += 3) P(lx + i, y1 - 3, 2, 2 + ((rnd() * 2) | 0), pick(CLOTHES)); }
      if (rnd() < 0.3) acUnit(S, len - 7, y0 + 3);
    }
    P(0, 0, len, 2, '#8a8590');
    if (rnd() < 0.5) for (let i = 0; i < 3; i++) P(2 + i * 4, 0, 1, 3, '#5a3a2a');
    if (front) { const d = (len / 2 - 3) | 0; P(d, H - 10, 6, 10, '#2a1e1e'); P(d + 1, H - 9, 4, 9, pick(['#4a6a8a', '#8a3a3a', '#3a6a4a', '#5a4a3a'])); }
    if (rnd() < 0.6) tag(S, rnd, 2, H - 7, len - 6);
    if (rnd() < 0.4) pipe(S, len - 2, 2, H);
    groundLine(S);
    return S;
  }
  if (st === 'house' || st === 'church' || st === 'kiosk' || st === 'ruin') {
    const col = st === 'church' ? '#f0e6d2' : st === 'kiosk' ? '#d8b880' : st === 'ruin' ? '#6a6870' : pick(HOUSE_WALLS);
    P(0, 0, len, H, col);
    speckle(P, rnd, 0, 0, len, H, len, [shade(col, -0.06), shade(col, 0.05)]);
    cornice(S, col);
    if (st === 'ruin') {
      for (let i = 0; i < 6; i++) P(rnd() * (len - 4), rnd() * H, 3 + rnd() * 5, 2 + rnd() * 3, rnd() < 0.5 ? '#2a2830' : '#3a8a3c');
      groundLine(S); return S;
    }
    if (st === 'kiosk') {
      const a = pick([['#ff3f8e', '#f2f2f2'], ['#3ddc84', '#ffd23f'], ['#22e5ff', '#f2f2f2'], ['#ff8a3d', '#ffd23f']]);
      for (let x = 0; x < len; x += 4) P(x, 0, 4, 5, (x / 4) % 2 ? a[1] : a[0]);
      if (front) { P(2, 7, len - 4, 3, '#8a6a40'); S.E(2, 6, len - 4, 1, '#ffd88a'); }
      groundLine(S); return S;
    }
    for (let f = 0; f < fl; f++) {
      const y0 = floorY(f);
      if (st === 'church') {
        for (let x = 4; x < len - 4; x += 9) { S.P(x, y0 + 2, 3, 9, '#2a1e3a'); S.E(x, y0 + 3, 3, 7, f % 2 ? '#ff9ae8' : '#9af0ff'); S.P(x + 1, y0 + 2, 1, 1, col); }
      } else for (let x = 3; x < len - 5; x += 8) { if (front && f === fl - 1 && Math.abs(x + 2 - len / 2) < 6) continue; win(S, x, y0 + 3, 4, 5, 1, '#f2f2f2'); P(x - 1, y0 + 9, 6, 1, shade(col, -0.25)); }
      P(0, floorY(f + 1) - 1, len, 1, shade(col, -0.12));
    }
    if (front) { const d = (len / 2 - 3) | 0; P(d, H - 11, 6, 11, st === 'church' ? '#5a3a2a' : '#4a2e1e'); P(d + 4, H - 6, 1, 1, '#ffd23f'); }
    if (rnd() < 0.4) acUnit(S, len - 8, floorY(0) + 2);
    if (rnd() < 0.4) pipe(S, 1, 3, H);
    groundLine(S);
    return S;
  }
  if (st === 'shop' || st === 'apartment' || st === 'club') {
    const col = st === 'club' ? '#1d1028' : pick(st === 'shop' ? HOUSE_WALLS.concat(APT_WALLS) : APT_WALLS);
    P(0, 0, len, H, col);
    speckle(P, rnd, 0, 0, len, H, len, [shade(col, -0.07), shade(col, 0.05)]);
    stains(S, rnd, len / 8);
    cornice(S, col);
    const balconies = st === 'apartment' && rnd() < 0.7;
    for (let f = 0; f < fl; f++) {
      const y0 = floorY(f), ground = f === fl - 1;
      P(0, floorY(f + 1) - 1, len, 1, shade(col, -0.16));
      if (st === 'club') { for (let x = 0; x < len; x += 6) S.E(x, y0 + 9, 3, 1, x % 12 ? '#22e5ff' : '#ff3fa4', x % 12 ? '#ff3fa4' : '#22e5ff'); S.anim = true; continue; }
      if (ground && front && st === 'shop') {
        // storefront: awning, big shop window (lit or shutter)
        const a = pick([['#ff3f8e', '#f2f2f2'], ['#3ddc84', '#ffd23f'], ['#22e5ff', '#f2f2f2'], ['#ff8a3d', '#ffd23f'], ['#a66bff', '#ffd23f']]);
        for (let x = 0; x < len; x += 4) P(x, y0, 4, 3, (x / 4) % 2 ? a[1] : a[0]);
        P(0, y0 + 3, len, 1, shade(a[0], -0.45));
        const sw = Math.min(len - 10, 26);
        if (rnd() < 0.45) { P(2, y0 + 4, sw, F - 4, '#5a5f6e'); for (let yy = y0 + 5; yy < y0 + F; yy += 2) P(2, yy, sw, 1, '#6a707e'); tag(S, rnd, 3, y0 + 6, sw - 2); }
        else { S.E(2, y0 + 4, sw, F - 5, '#ffe2a0'); for (let x = 4; x < 2 + sw - 2; x += 4) P(x, y0 + 7, 2, 4, pick(CLOTHES)); P(2, y0 + 4, sw, 1, '#c8a060'); }
        P(len - 7, y0 + 3, 5, F - 3, '#2a1e1e');
        continue;
      }
      for (let x = 3; x < len - 4; x += 7) {
        if (ground && front && Math.abs(x + 2 - len / 2) < 6) continue;
        win(S, x, y0 + 3, 4, 6, 1, shade(col, -0.28));
        if (!ground && rnd() < 0.18) acUnit(S, x, y0 + 9);
      }
      if (balconies && !ground) { P(1, y0 + 9, len - 2, 1, '#e0e0e8'); for (let x = 1; x < len - 1; x += 2) P(x, y0 + 10, 1, 2, '#9a9aa6'); P(1, y0 + 12, len - 2, 1, '#6a6a76'); if (rnd() < 0.3) { const lx = 4 + ((rnd() * (len - 18)) | 0); for (let i = 0; i < 12; i += 3) P(lx + i, y0 + 7, 2, 3, pick(CLOTHES)); } }
    }
    if (front && st !== 'shop') { const d = (len / 2 - 4) | 0; P(d, H - 10, 8, 10, '#14141c'); S.E(d + 1, H - 9, 6, 1, st === 'club' ? '#ff3fa4' : '#ffd88a'); }
    if (rnd() < 0.6) pipe(S, len - 3, 4, H);
    if (front && rnd() < 0.5) tag(S, rnd, 2, H - 7, Math.min(len - 4, 20));
    groundLine(S);
    return S;
  }
  if (st === 'tower') {
    const glass = pick(GLASS), trim = b.sign ? b.sign.c : pick(['#22e5ff', '#ff3fa4', '#a66bff', '#ffd23f']);
    const frame = shade(glass, 0.28);
    P(0, 0, len, H, glass);
    // concrete frame + curtain wall grid
    for (let x = 0; x < len; x += 4) P(x, 0, 1, H, frame);
    cornice(S, '#3a3a50');
    for (let f = 0; f < fl; f++) {
      const y0 = floorY(f);
      P(0, y0, len, 1, frame);
      for (let x = 1; x < len - 2; x += 4) win(S, x, y0 + 2, 3, 9, 1.3);
      if ((f + (b.seed % 3)) % 3 === 0) { S.E(0, y0 + 12, len, 1, trim, b.sign && b.sign.anim === 'swap' ? b.sign.c2 : trim); }
    }
    if (front) { const d = (len / 2 - 6) | 0; P(d, H - 11, 12, 11, '#0a0e18'); S.E(d, H - 11, 12, 1, trim); P(d + 5, H - 10, 1, 10, '#2a3a5a'); }
    groundLine(S);
    return S;
  }
  // warehouse / factory
  const col = st === 'factory' ? pick(['#8a4a3a', '#7a3a2e', '#6a5a4e']) : pick(['#5a606e', '#6a5a4e', '#4e5a6a', '#7a6a50']);
  P(0, 0, len, H, col);
  if (st === 'warehouse') for (let x = 0; x < len; x += 3) P(x, 0, 1, H, shade(col, -0.18));
  else bricks(S, rnd, 0, 3, len, H - 3, col);
  cornice(S, col);
  for (let f = 0; f < fl; f++) {
    const y0 = floorY(f);
    if (f === fl - 1 && front) continue;
    for (let x = 4; x < len - 6; x += st === 'factory' ? 7 : 10) win(S, x, y0 + 3, st === 'factory' ? 4 : 6, st === 'factory' ? 7 : 3, 0.5);
  }
  if (front) {
    const dw = Math.min(len - 8, 22), dx = ((len - dw) / 2) | 0;
    P(dx, H - 12, dw, 12, '#3a3e48');
    for (let y = H - 11; y < H; y += 2) P(dx, y, dw, 1, '#4a4e58');
    if (rnd() < 0.6) tag(S, rnd, dx + 1, H - 9, dw - 2);
    S.E(dx - 3, H - 13, 2, 2, '#ff8a3d', '#ff8a3d');
  }
  for (let x = 0; x < len; x += 4) P(x, H - 2, 2, 2, '#ffd23f');
  pipe(S, 2, 3, H); if (len > 50) pipe(S, len - 4, 3, H);
  return S;
}

function addSigns(b, S, rnd) {
  const sg = b.sign;
  if (!sg) return;
  const H = b.H, len = S.w;
  if (sg.kind === 'cross') {
    const cx = (len / 2) | 0, y = 5;
    S.P(cx - 4, y - 1, 9, 13, '#0c0814');
    S.E(cx, y, 1, 11, '#ff3b5c', sg.anim === 'flicker' ? null : sg.anim === 'swap' ? '#ffffff' : '#ff3b5c');
    S.E(cx - 3, y + 3, 7, 1, '#ff3b5c', sg.anim === 'flicker' ? null : sg.anim === 'swap' ? '#ffffff' : '#ff3b5c');
    S.anim = sg.anim !== 'steady';
    return;
  }
  const B = BRANDS[sg.brand];
  if (sg.kind === 'vertical') { signVertical(S, B, sg.right ? len - 8 : 2, 6, H - 12, sg.anim); return; }
  if (sg.kind === 'marquee') {
    const y = H - 24;
    S.P(2, y, len - 4, 10, '#0c0814');
    for (let i = 0; i < len - 4; i += 2) { S.E(2 + i, y, 1, 1, i % 4 ? '#ffd23f' : '#ff3fa4', i % 4 ? '#ff3fa4' : '#ffd23f'); S.E(2 + i, y + 9, 1, 1, i % 4 ? '#ff3fa4' : '#ffd23f', i % 4 ? '#ffd23f' : '#ff3fa4'); }
    const tw = B.name.length * 4 - 1;
    const t = textSprite(B.name, B.c, null);
    const tx = ((len - tw) / 2) | 0;
    S.g.drawImage(t, tx, y + 3); S.g0.drawImage(t, tx, y + 3); S.g1.drawImage(textSprite(B.name, B.c2 || B.c, null), tx, y + 3);
    S.anim = true;
    return;
  }
  // panel above the ground floor
  const y = Math.max(5, H - 13 - 13);
  signPanel(S, B, len / 2, b.style === 'shop' ? H - 13 - 12 : y, sg.anim);
}

// ------------------------------------------------------------------ roofs
function paintRoof(b, rnd, tint = '#ff3f8e') {
  const W = b.w * TILE, D = b.h * TILE;
  const S = surface(W, D);
  const { P } = S;
  const st = b.style;
  const pick = (a) => a[(rnd() * a.length) | 0];
  const parapet = (col) => { P(0, 0, W, 1, shade(col, 0.35)); P(0, 0, 1, D, shade(col, 0.25)); P(W - 1, 0, 1, D, shade(col, -0.35)); P(0, D - 1, W, 1, shade(col, -0.45)); P(1, 1, W - 2, 1, shade(col, -0.25)); P(1, 1, 1, D - 2, shade(col, -0.2)); };
  const tank = (x, y) => { P(x, y, 9, 8, '#2f68b8'); P(x, y, 9, 2, '#5a8ad8'); P(x + 1, y + 7, 7, 1, '#1d4a8a'); P(x + 3, y + 1, 3, 1, '#8ab0f0'); P(x + 2, y + 8, 6, 1, 'rgba(0,0,0,0.3)'); };
  const dish = (x, y) => { P(x, y, 6, 5, '#d8d8e0'); P(x + 1, y + 1, 4, 3, '#a8a8b8'); P(x + 2, y + 2, 2, 1, '#6a6a76'); };
  const vent = (x, y) => { P(x, y, 7, 6, '#4a4a5e'); P(x, y, 7, 1, '#6a6a7e'); for (let i = 1; i < 6; i += 2) P(x + 1, y + i, 5, 1, '#2a2a3e'); P(x + 1, y + 6, 7, 1, 'rgba(0,0,0,0.35)'); };
  const ac = (x, y) => { P(x, y, 8, 6, '#c8c8d0'); P(x, y, 8, 1, '#e8e8f0'); P(x + 2, y + 2, 4, 3, '#5a5a66'); P(x + 3, y + 3, 2, 1, '#8a8a96'); P(x + 1, y + 6, 8, 1, 'rgba(0,0,0,0.35)'); };
  const solar = (x, y, w) => { for (let i = 0; i + 4 <= w; i += 5) { P(x + i, y, 4, 7, '#1d2a5a'); P(x + i, y, 4, 1, '#5a7ad8'); P(x + i + 2, y, 1, 7, '#2a3a7a'); } };
  const antenna = (x, y) => { P(x, y, 1, 1, '#c8c8d0'); P(x - 1, y + 1, 3, 1, '#56606e'); S.blinks.push({ x, y }); };
  S.blinks = [];
  if (st === 'cwall') {
    P(0, 0, W, D, '#6a6676');
    P(0, 0, W, 1, '#8a8698'); P(0, D - 1, W, 1, '#3a3646'); P(0, 0, 1, D, '#7a7688'); P(W - 1, 0, 1, D, '#3a3646');
    const along = W > D;
    if (along) { S.E(0, (D / 2) | 0, W, 1, tint); for (let x = 2; x < W; x += 6) P(x, 2, 2, 1, '#9a96a8'); }
    else { S.E((W / 2) | 0, 0, 1, D, tint); for (let y = 2; y < D; y += 6) P(2, y, 1, 2, '#9a96a8'); }
    if (b.H >= 18) for (let i = 4; i < (along ? W : D); i += 16) { if (along) S.E(i, 2, 2, 2, '#fff2c0'); else S.E(2, i, 2, 2, '#fff2c0'); }
    return S;
  }
  if (st === 'hq') {
    const K = { arsenal: '#ff3f8e', clinic: '#3ddc84', locker: '#22e5ff', vault: '#ffd23f' }[b.kind] || '#fff';
    const col = '#2e2a3a';
    P(0, 0, W, D, col);
    speckle(P, rnd, 0, 0, W, D, W * D / 12, ['#28242f', '#36324a']);
    parapet(col);
    S.E(1, 1, W - 2, 1, tint); S.E(1, D - 2, W - 2, 1, tint); S.E(1, 1, 1, D - 2, tint); S.E(W - 2, 1, 1, D - 2, tint);
    // big painted emblem of the building's job
    const cx = (W / 2) | 0, cy = (D / 2) | 0, r = Math.min(W, D) / 2 - 5;
    for (let a = 0; a < 40; a++) { const an = a / 40 * Math.PI * 2; S.E(Math.round(cx + Math.cos(an) * r), Math.round(cy + Math.sin(an) * r), 1, 1, K); }
    const icon = { arsenal: 'star', clinic: 'cross', locker: 'box', vault: 'coin' }[b.kind] || 'star';
    drawLogo((x, y, w, h, c) => S.E(x, y, w, h, c), icon, cx - 7, cy - 7, K, shade(K, 0.4), 2);
    for (let i = 0; i < 2; i++) { const x = 4 + i * (W - 16), y = D - 10; P(x, y, 8, 6, '#c8c8d0'); P(x + 2, y + 2, 4, 3, '#5a5a66'); }
    S.blinks.push({ x: W - 4, y: 3 });
    return S;
  }
  if (st === 'shack') {
    const col = pick(['#8a8494', '#7a8090', '#9a7a5a']);
    P(0, 0, W, D, col);
    for (let x = 0; x < W; x += 3) { P(x, 0, 1, D, shade(col, -0.2)); P(x + 1, 0, 1, D, shade(col, 0.1)); }
    for (let i = 0; i < 2; i++) P(rnd() * (W - 8), rnd() * (D - 6), 6 + rnd() * 6, 4 + rnd() * 4, rnd() < 0.5 ? '#8a5a3a' : '#5a6a7a');
    // tarp in the owner's color + a little flag
    const tw = Math.min(W - 4, 14), th = Math.min(D - 4, 9), tx = 2 + ((rnd() * (W - tw - 4)) | 0), ty = 2 + ((rnd() * (D - th - 4)) | 0);
    P(tx, ty, tw, th, shade(tint, -0.25)); P(tx, ty, tw, 1, shade(tint, 0.2)); for (let x = tx + 3; x < tx + tw; x += 4) P(x, ty, 1, th, shade(tint, -0.4));
    if (rnd() < 0.6) { P(W - 8, D - 8, 6, 5, '#1d1d24'); P(W - 7, D - 7, 4, 3, '#2a2a36'); }
    parapet(col);
    return S;
  }
  if (st === 'bar') {
    const col = '#2a2036';
    P(0, 0, W, D, col);
    speckle(P, rnd, 0, 0, W, D, W * D / 14, ['#241c30', '#342a44']);
    parapet(col);
    // rooftop neon sign with a cocktail glass, readable from above
    const name = (b.barName || 'BAR').toUpperCase().slice(0, Math.floor((W - 22) / 4));
    const bw = Math.min(W - 6, name.length * 4 + 20), bx = ((W - bw) / 2) | 0, by = Math.max(3, ((D - 14) / 2) | 0);
    P(bx, by, bw, 13, '#0c0814');
    S.E(bx, by, bw, 1, '#ff3fa4', '#22e5ff'); S.E(bx, by + 12, bw, 1, '#ff3fa4', '#22e5ff'); S.E(bx, by, 1, 13, '#ff3fa4', '#22e5ff'); S.E(bx + bw - 1, by, 1, 13, '#ff3fa4', '#22e5ff');
    const gx = bx + 4, gy = by + 3;
    S.E(gx, gy, 9, 1, '#22e5ff'); S.E(gx + 1, gy + 1, 7, 1, '#22e5ff'); S.E(gx + 2, gy + 2, 5, 1, '#ff3fa4'); S.E(gx + 3, gy + 3, 3, 1, '#22e5ff'); S.E(gx + 4, gy + 4, 1, 3, '#22e5ff'); S.E(gx + 2, gy + 7, 5, 1, '#22e5ff'); S.E(gx + 7, gy - 1, 1, 2, '#3ddc84');
    const t0 = textSprite(name, '#ffd23f', null), t1 = textSprite(name, '#ff3fa4', null);
    S.g.drawImage(t0, bx + 16, by + 4); S.g0.drawImage(t0, bx + 16, by + 4); S.g1.drawImage(t1, bx + 16, by + 4);
    S.anim = true;
    for (let i = 0; i < 2; i++) { const x = 4 + i * (W - 14), y = D - 9; P(x, y, 9, 6, '#c8c8d0'); P(x + 2, y + 2, 5, 3, '#5a5a66'); }
    return S;
  }
  if (st === 'container') {
    const col = CONTAINER[b.seed % CONTAINER.length];
    P(0, 0, W, D, shade(col, 0.1));
    for (let x = 1; x < W; x += 3) P(x, 0, 1, D, shade(col, -0.15));
    P(0, 0, W, 1, shade(col, 0.4)); P(0, D - 1, W, 1, shade(col, -0.4));
    return S;
  }
  if (st === 'house' || st === 'church') {
    // pitched clay tile roof
    const col = st === 'church' ? '#8a4a3a' : pick(['#c4553a', '#b84a30', '#d0683f', '#7a4a6a', '#9a5a3a']);
    P(0, 0, W, D, col);
    const mid = (D / 2) | 0;
    for (let y = 0; y < D; y += 3) { P(0, y, W, 1, shade(col, y < mid ? -0.12 : -0.3)); for (let x = (y % 6 ? 0 : 2); x < W; x += 4) P(x, y + 1, 1, 2, shade(col, -0.2)); }
    P(0, 0, W, mid, 'rgba(255,220,180,0.10)'); P(0, mid, W, D - mid, 'rgba(0,0,0,0.18)');
    P(0, mid - 1, W, 2, shade(col, 0.3));
    parapet(col);
    if (st === 'church') { const cx = (W / 2) | 0; P(cx - 1, mid - 9, 3, 18, '#e8e4d8'); P(cx - 5, mid - 4, 11, 3, '#e8e4d8'); }
    else { if (rnd() < 0.4) solar(4, mid + 3, Math.min(20, W - 8)); if (rnd() < 0.5) dish(W - 9, 3); P(W - 8, 2, 4, 6, '#8a3a2a'); }
    return S;
  }
  if (st === 'kiosk') {
    const a = pick([['#ff3f8e', '#f2f2f2'], ['#3ddc84', '#ffd23f'], ['#22e5ff', '#f2f2f2'], ['#ff8a3d', '#ffd23f']]);
    for (let x = 0; x < W; x += 4) P(x, 0, 4, D, (x / 4) % 2 ? a[1] : a[0]);
    P(0, 0, W, D, 'rgba(0,0,0,0.08)');
    parapet(a[0]);
    return S;
  }
  if (st === 'warehouse' || st === 'factory') {
    const col = st === 'factory' ? '#5a5f6e' : '#6a7080';
    P(0, 0, W, D, col);
    if (st === 'factory') for (let y = 0; y < D; y += 8) { P(0, y, W, 4, '#7a8090'); P(0, y + 4, W, 4, '#4a4e5a'); P(0, y + 3, W, 1, '#9aa0b0'); }
    else for (let x = 0; x < W; x += 4) { P(x, 0, 2, D, shade(col, -0.12)); P(x + 2, 0, 1, D, shade(col, 0.1)); }
    for (let i = 0; i < Math.floor(W / 24); i++) { const x = 6 + i * 22; S.P(x, 6, 10, D - 12, '#2a3a4a'); S.wins.push({ x: x + 1, y: 7, w: 8, h: D - 14, p: 0.6 }); }
    if (rnd() < 0.5) { const x = W - 12; P(x, 4, 6, 6, '#3a3a46'); P(x + 1, 5, 4, 4, '#1a1a22'); }
    parapet(col);
    return S;
  }
  if (st === 'favela') {
    const col = '#8a8590';
    P(0, 0, W, D, col);
    speckle(P, rnd, 0, 0, W, D, W * D / 14, ['#7f7a85', '#96919c', '#6f6a75']);
    for (let i = 0; i < 3; i++) P(rnd() * (W - 8), rnd() * (D - 6), 4 + rnd() * 8, 2 + rnd() * 4, 'rgba(40,30,30,0.18)');
    parapet(col);
    if (rnd() < 0.85) tank(2 + ((rnd() * Math.max(1, W - 13)) | 0), 2 + ((rnd() * Math.max(1, D - 12)) | 0));
    if (rnd() < 0.45) dish(W - 8, D - 8);
    if (rnd() < 0.6) for (let i = 0; i < 4; i++) P(2 + i * 3, D - 5, 1, 3, '#5a3a2a');
    if (rnd() < 0.4 && W >= 32) { const y = 4 + ((rnd() * (D - 10)) | 0); P(3, y, W - 6, 1, '#c8c0b0'); for (let x = 5; x < W - 6; x += 3) P(x, y + 1, 2, 3, pick(CLOTHES)); }
    if (rnd() < 0.3) { P(4, 4, 8, 5, '#3a8a3c'); P(5, 3, 2, 1, '#ff7ac8'); }
    if (rnd() < 0.25) { P(W - 14, 3, 10, 6, '#3a3a46'); P(W - 13, 4, 8, 4, '#2a2a36'); }
    // gambiarra: strings of warm bulbs across the laje (a party on the roof)
    if (rnd() < 0.4) {
      const y0 = 3 + ((rnd() * (D - 8)) | 0), y1 = 3 + ((rnd() * (D - 8)) | 0);
      for (let x = 2; x < W - 2; x++) {
        const y = Math.round(y0 + (y1 - y0) * (x / W) + Math.sin((x / W) * Math.PI) * 3);
        P(x, y, 1, 1, '#1a1418');
        if (x % 4 === 2) S.E(x, y + 1, 1, 1, ['#ffd88a', '#ff9ae8', '#9af0ff', '#ffb86a'][(x >> 2) % 4]);
      }
    }
    if (rnd() < 0.2) { const x = 3 + ((rnd() * (W - 10)) | 0), y = 3 + ((rnd() * (D - 8)) | 0); P(x, y, 6, 4, '#2a2a36'); S.E(x + 1, y + 1, 4, 2, '#7ab0ff'); }
    return S;
  }
  // flat modern roofs: shop, apartment, tower, club — packed with rooftop equipment
  const col = st === 'tower' ? pick(['#2a2a3e', '#32303e', '#2a3038', '#38323a']) : st === 'club' ? '#2a1838' : st === 'apartment' ? pick(['#6a6676', '#5e646e', '#6e6460']) : pick(['#5a5664', '#625a58', '#545c64']);
  P(0, 0, W, D, col);
  speckle(P, rnd, 0, 0, W, D, W * D / 10, [shade(col, -0.1), shade(col, 0.1), shade(col, -0.05)]);
  for (let x = 8; x < W; x += 8) P(x, 2, 1, D - 4, shade(col, -0.1));
  for (let y = 8; y < D; y += 8) P(2, y, W - 4, 1, shade(col, -0.07));
  for (let i = 0; i < (W * D) / 900; i++) P(rnd() * (W - 10), rnd() * (D - 8), 5 + rnd() * 8, 3 + rnd() * 5, shade(col, rnd() < 0.5 ? -0.14 : 0.07));
  parapet(col);
  P(2, 2, W - 4, 1, shade(col, 0.15));
  // occupancy grid so equipment doesn't overlap
  const used = [];
  const place = (w, h, pad = 2) => {
    for (let t = 0; t < 14; t++) {
      const x = 3 + ((rnd() * Math.max(1, W - w - 6)) | 0), y = 3 + ((rnd() * Math.max(1, D - h - 6)) | 0);
      if (x + w > W - 3 || y + h > D - 3) continue;
      if (used.some((u) => x < u.x + u.w + pad && x + w + pad > u.x && y < u.y + u.h + pad && y + h + pad > u.y)) continue;
      used.push({ x, y, w, h });
      return { x, y };
    }
    return null;
  };
  const box3d = (x, y, w, h, c) => { P(x + 1, y + 1, w, h, 'rgba(0,0,0,0.35)'); P(x, y, w, h, shade(c, 0.12)); P(x, y, w, 1, shade(c, 0.35)); P(x, y + h - 3, w, 3, shade(c, -0.3)); P(x + w - 1, y, 1, h, shade(c, -0.2)); };
  const stairHut = () => { const q = place(12, 11); if (!q) return; box3d(q.x, q.y, 12, 11, shade(col, 0.15)); P(q.x + 4, q.y + 8, 4, 3, '#14141c'); S.E(q.x + 5, q.y + 7, 2, 1, '#ffd88a'); };
  const hvac = () => { const q = place(14, 10); if (!q) return; box3d(q.x, q.y, 14, 10, '#8a8a96'); for (let i = 0; i < 2; i++) { P(q.x + 2 + i * 6, q.y + 2, 5, 5, '#3a3a46'); P(q.x + 4 + i * 6, q.y + 3, 1, 3, '#8a8a96'); P(q.x + 3 + i * 6, q.y + 4, 3, 1, '#8a8a96'); } };
  const waterTower = () => { const q = place(11, 11); if (!q) return; P(q.x + 2, q.y + 2, 10, 10, 'rgba(0,0,0,0.35)'); P(q.x + 1, q.y, 9, 11, '#8a6a4a'); P(q.x, q.y + 1, 11, 9, '#8a6a4a'); P(q.x + 2, q.y + 1, 7, 9, '#a07a50'); P(q.x + 3, q.y + 2, 3, 2, '#c09a70'); for (let i = 0; i < 3; i++) P(q.x + 1, q.y + 2 + i * 3, 9, 1, '#5a4030'); };
  const pipes = () => { const y = 4 + ((rnd() * (D - 8)) | 0); const x0 = 3 + ((rnd() * W * 0.3) | 0), x1 = W - 3 - ((rnd() * W * 0.3) | 0); P(x0, y, x1 - x0, 2, '#7a7a86'); P(x0, y, x1 - x0, 1, '#a8a8b4'); for (let x = x0 + 6; x < x1; x += 10) P(x, y - 1, 2, 4, '#4a4a56'); };
  const garden = () => { const q = place(18, 14); if (!q) return; P(q.x, q.y, 18, 14, '#3a5a2a'); P(q.x, q.y, 18, 1, '#8a8a7a'); P(q.x, q.y + 13, 18, 1, '#5a5a4a'); for (let i = 0; i < 9; i++) P(q.x + 1 + rnd() * 15, q.y + 1 + rnd() * 11, 3, 3, pick(['#3fa84c', '#2f8a3c', '#4fc85c', '#ff7ac8'])); };
  const pool = () => { const q = place(20, 12); if (!q) return; P(q.x - 1, q.y - 1, 22, 14, '#e8e4d8'); P(q.x, q.y, 20, 12, '#1a6a9a'); S.E(q.x + 1, q.y + 1, 18, 1, '#22e5ff'); S.E(q.x + 1, q.y + 10, 18, 1, '#22e5ff'); for (let i = 0; i < 4; i++) P(q.x + 3 + i * 4, q.y + 4 + (i % 2) * 3, 3, 1, '#5ab0e8'); P(q.x + 21, q.y + 2, 4, 2, '#ff3f8e'); P(q.x + 21, q.y + 6, 4, 2, '#ffd23f'); };
  const skylight = () => { const q = place(8, 6); if (!q) return; P(q.x, q.y, 8, 6, '#3a3a46'); S.P(q.x + 1, q.y + 1, 6, 4, '#1a2236'); S.wins.push({ x: q.x + 1, y: q.y + 1, w: 6, h: 4, p: 1.2 }); };
  const area = W * D;
  if (st === 'tower') {
    const trim = b.sign ? b.sign.c : '#22e5ff';
    const t2 = b.sign && b.sign.anim === 'swap' ? b.sign.c2 : trim;
    S.E(1, 1, W - 2, 1, trim, t2); S.E(1, D - 2, W - 2, 1, trim, t2); S.E(1, 1, 1, D - 2, trim, t2); S.E(W - 2, 1, 1, D - 2, trim, t2);
    if (b.sign && b.sign.anim === 'swap') S.anim = true;
    if (!b.board && W >= 48 && D >= 48 && rnd() < 0.45) {
      const q = place(26, 26, 3);
      if (q) {
        const cx = q.x + 13, cy = q.y + 13;
        P(cx - 13, cy - 13, 26, 26, '#3a3a50'); P(cx - 12, cy - 12, 24, 24, '#2e2e42');
        S.E(cx - 13, cy - 13, 26, 1, '#ffd23f'); S.E(cx - 13, cy + 12, 26, 1, '#ffd23f'); S.E(cx - 13, cy - 13, 1, 26, '#ffd23f'); S.E(cx + 12, cy - 13, 1, 26, '#ffd23f');
        P(cx - 5, cy - 7, 2, 14, '#e8e8f0'); P(cx + 3, cy - 7, 2, 14, '#e8e8f0'); P(cx - 5, cy - 1, 10, 2, '#e8e8f0');
        for (const [x, y] of [[cx - 13, cy - 13], [cx + 12, cy - 13], [cx - 13, cy + 12], [cx + 12, cy + 12]]) S.blinks.push({ x, y, c: '#3ddc84' });
      }
    } else if (!b.board && area > 3000 && rnd() < 0.5) (rnd() < 0.5 ? pool : garden)();
    stairHut();
    const items = [hvac, () => { const q = place(7, 7); if (q) vent(q.x, q.y); }, () => { const q = place(9, 7); if (q) ac(q.x, q.y); }, skylight];
    for (let i = 0; i < area / 900; i++) items[(rnd() * 4) | 0]();
    if (rnd() < 0.6) pipes();
    antenna(W - 5, 4); if (rnd() < 0.6) antenna(5, D - 6);
  } else if (st === 'club') {
    for (let i = 0; i < W - 4; i += 3) S.E(2 + i, 2, 2, 1, i % 6 ? '#ff3fa4' : '#22e5ff', i % 6 ? '#22e5ff' : '#ff3fa4');
    for (let i = 0; i < W - 4; i += 3) S.E(2 + i, D - 3, 2, 1, i % 6 ? '#22e5ff' : '#ff3fa4', i % 6 ? '#ff3fa4' : '#22e5ff');
    S.anim = true;
    for (let i = 0; i < 3; i++) { const q = place(8, 8); if (q) { box3d(q.x, q.y, 8, 8, '#2a1838'); P(q.x + 2, q.y + 2, 4, 4, '#120a1c'); S.E(q.x + 3, q.y + 3, 2, 2, '#ffd23f'); } }
  } else {
    if (rnd() < 0.75) { const q = place(10, 9); if (q) tank(q.x, q.y); }
    if (st === 'apartment') { if (rnd() < 0.5) waterTower(); stairHut(); if (rnd() < 0.3 && area > 2500) garden(); }
    for (let i = 0; i < 1 + area / 800; i++) [() => { const q = place(9, 7); if (q) ac(q.x, q.y); }, () => { const q = place(7, 7); if (q) vent(q.x, q.y); }, hvac, () => { const q = place(6, 5); if (q) dish(q.x, q.y); }][(rnd() * 4) | 0]();
    if (rnd() < 0.4 && W >= 36) { const q = place(20, 8); if (q) solar(q.x, q.y, 20); }
    if (rnd() < 0.4) pipes();
    if (rnd() < 0.3) skylight();
    if (st === 'apartment' && rnd() < 0.5) antenna(W - 4, 3);
    if (rnd() < 0.25) { const y = 3 + ((rnd() * (D - 8)) | 0); P(3, y, W - 6, 1, '#c8c0b0'); for (let x = 5; x < W - 6; x += 3) P(x, y + 1, 2, 3, pick(CLOTHES)); }
  }
  // rooftop billboard (flat, lit)
  if (b.board) {
    const B = BRANDS[b.board.brand];
    const bw = Math.min(W - 8, 46), bh = Math.min(D - 8, 20), bx = ((W - bw) / 2) | 0, by = 4;
    const anim = b.board.anim, c2 = anim === 'swap' ? B.c2 : B.c;
    P(bx + 1, by + 1, bw, bh, 'rgba(0,0,0,0.4)');
    P(bx, by, bw, bh, '#0c0814');
    S.E(bx, by, bw, 1, B.c, c2); S.E(bx, by + bh - 1, bw, 1, B.c, c2); S.E(bx, by, 1, bh, B.c, c2); S.E(bx + bw - 1, by, 1, bh, B.c, c2);
    drawLogo((x, y, w, h, c) => S.E(x, y, w, h, c, anim === 'swap' ? (c === B.c ? B.c2 : B.c) : c), B.logo, bx + 3, by + 3, B.c, B.c2, 2);
    const words = B.name.split(/[ .]/);
    words.slice(0, 2).forEach((wd, i) => {
      const t = textSprite(wd.slice(0, Math.floor((bw - 21) / 4)), i ? B.c2 || B.c : B.c, null);
      S.g.drawImage(t, bx + 19, by + 3 + i * 7); S.g0.drawImage(t, bx + 19, by + 3 + i * 7); S.g1.drawImage(t, bx + 19, by + 3 + i * 7);
    });
    if (anim === 'swap') S.anim = true;
  }
  return S;
}

// ------------------------------------------------------------------ art + bake
export function buildingArt(b, tint = null) {
  if (tint) {
    b._arts = b._arts || {};
    if (b._arts[tint]) return (b._art = b._arts[tint]);
  } else if (b._art) return b._art;
  const rnd = rngOf(b.seed);
  const W = b.w * TILE, D = b.h * TILE;
  const walls = {};
  for (const side of ['S', 'N', 'E', 'W']) {
    const S = paintWall(b, side, side === 'S' || side === 'N' ? W : D, rngOf(b.seed + side.charCodeAt(0) * 977), tint || '#ff3f8e');
    if (side === 'S') addSigns(b, S, rnd);
    walls[side] = S;
  }
  const roof = paintRoof(b, rnd, tint || '#ff3f8e');
  const anim = b.sign ? b.sign.anim : b.board ? b.board.anim : 'steady';
  const litMul = { hq: 1.4, bar: 1.2, shack: 0.9, cwall: 0, tower: 1.25, apartment: 1.1, shop: 0.9, favela: 0.9, house: 0.8, club: 0.4, church: 0.6, warehouse: 0.35, factory: 0.5, kiosk: 0.6, ruin: 0, container: 0 }[b.style] ?? 0.8;
  const art = { W, D, H: b.H, k: projK(b.H), walls, roof, anim: b.style === 'bar' ? 'swap' : anim, seed: (b.seed % 1000) / 10, litMul, bakeKey: '', baked: null };
  if (tint) b._arts[tint] = art;
  b._art = art;
  return art;
}

// Bakes the building for the current ambient light ([r,g,b] 0..1) and lit-window pattern.
// Returns { roof: [state0, state1], S: [..], N, E, W } (E and W are transposed for column drawing).
export function bakeBuilding(b, amb, epoch, litFrac, tint = null) {
  const art = buildingArt(b, tint);
  const key = amb.map((v) => Math.round(v * 24)).join(',') + '|' + epoch + '|' + Math.round(litFrac * 10);
  if (art.bakeKey === key && art.baked) return art.baked;
  art.bakeKey = key;
  const out = {};
  const bakeOne = (S, sideShade, sideIdx, transpose) => {
    const states = [];
    for (let st = 0; st < (S.anim || art.walls.S.anim || art.roof.anim ? 2 : 1); st++) {
      const c = transpose ? mk(S.h, S.w) : mk(S.w, S.h);
      const g = c.getContext('2d');
      if (transpose) g.setTransform(0, 1, 1, 0, 0, 0);
      g.drawImage(S.base, 0, 0);
      g.globalCompositeOperation = 'multiply';
      g.fillStyle = `rgb(${Math.round(255 * Math.min(1, amb[0] * sideShade))},${Math.round(255 * Math.min(1, amb[1] * sideShade))},${Math.round(255 * Math.min(1, amb[2] * sideShade))})`;
      g.fillRect(0, 0, S.w, S.h);
      g.globalCompositeOperation = 'source-over';
      // lit windows (their pattern changes every so often: lights going on and off)
      let i = 0;
      for (const w of S.wins) {
        const h = hash2(i++ + sideIdx * 997, epoch, b.seed | 0);
        if (h < litFrac * art.litMul * w.p) {
          g.fillStyle = LIT[(hash2(i, sideIdx, b.seed | 0) * LIT.length) | 0];
          g.fillRect(w.x, w.y, w.w, w.h);
          if (w.h > 3) { g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(w.x, w.y, w.w, 1); }
        } else if (amb[2] > 0.5 && hash2(i, sideIdx + 7, b.seed | 0) < 0.4) {
          // daytime sky reflection on glass
          g.fillStyle = 'rgba(150,190,230,0.35)'; g.fillRect(w.x, w.y, Math.max(1, w.w - 1), Math.max(1, (w.h / 2) | 0));
        }
      }
      g.drawImage(st ? S.e1 : S.e0, 0, 0);
      states.push(c);
    }
    if (states.length === 1) states.push(states[0]);
    return states;
  };
  out.roof = bakeOne(art.roof, SIDE_SHADE.roof, 9, false);
  out.S = bakeOne(art.walls.S, SIDE_SHADE.S, 0, false);
  out.N = bakeOne(art.walls.N, SIDE_SHADE.N, 1, false);
  out.E = bakeOne(art.walls.E, SIDE_SHADE.E, 2, true);
  out.W = bakeOne(art.walls.W, SIDE_SHADE.W, 3, true);
  art.baked = out;
  return out;
}
export const releaseBake = (b) => { if (b._art) { b._art.baked = null; b._art.bakeKey = ''; } };
