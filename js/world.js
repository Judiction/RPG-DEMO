// Procedural city generation + tile collision helpers.
// generateWorld(seed, opts) is deterministic: host and clients build the exact same city from the seed + options.
// opts: { type: coastal|island|lakes|river|archipelago, size: S|M|L, bases: number of gang base sites }

import { makeRng, fbm, hash2 } from './rng.js';
import { TILE, FACTIONS, NAME_PARTS, MAP_SIZES, MAP_TYPES, PVP_BASE_NAMES, BRANDS } from './data.js';

export const T = {
  WATER: 0, SAND: 1, GRASS: 2, DIRT: 3, ROAD: 4, SIDEWALK: 5, CALCADAO: 6, CONCRETE: 7,
  BUILD: 8, WALL: 9, STAIRS: 10, METAL: 11, TREE: 12, PAD: 13, BRIDGE: 14,
};
export const SOLID = new Uint8Array(16);
SOLID[T.WATER] = SOLID[T.BUILD] = SOLID[T.WALL] = SOLID[T.TREE] = 1;
export const OPAQUE = new Uint8Array(16);           // blocks bullets and sight
OPAQUE[T.BUILD] = OPAQUE[T.WALL] = OPAQUE[T.TREE] = 1;

const GROUND = { base: T.CONCRETE, beach: T.GRASS, favela: T.DIRT, downtown: T.CONCRETE, suburb: T.GRASS, industrial: T.METAL, jungle: T.GRASS };

export const CHUNK = 16;                            // tiles per prop/light bucket

export function generateWorld(seed, opts = {}) {
  const type = MAP_TYPES[opts.type] ? opts.type : 'coastal';
  const sizeKey = MAP_SIZES[opts.size] ? opts.size : 'M';
  const nBases = Math.max(1, Math.min(6, opts.bases | 0 || 1));
  const W = MAP_SIZES[sizeKey].n, H = W;
  const k = W / 256;
  const rng = makeRng(seed);
  const N = W * H;
  const tiles = new Uint8Array(N);
  let region = new Int16Array(N).fill(-1);
  const coast = new Float32Array(N);                // distance to the ocean in tiles (< 0 = ocean)
  const shore = new Float32Array(N).fill(99);       // distance to inland water (lakes, rivers)
  const land = new Uint8Array(N);                   // 1 = land (incl. bridges), 0 = water
  const bridge = new Uint8Array(N);
  const reserved = new Uint8Array(N);
  const I = (x, y) => y * W + x;
  const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
  const legacy = type === 'coastal';

  // ---------------------------------------------------------------- water
  const side = rng.int(0, 3);                       // which edge the ocean is on
  const bayU = rng.range(50 * k, 200 * k), bayDepth = rng.range(4, 22), bayW = rng.range(12, 26);
  const cseed = seed ^ 0x51ab;
  const wr = makeRng(seed ^ 0x77a1);                // extra rng for the newer map types
  const uv = (x, y) => (side === 0 ? [x, H - 1 - y] : side === 1 ? [y, W - 1 - x] : side === 2 ? [x, y] : [y, x]);
  if (type === 'coastal' || type === 'lakes' || type === 'river') {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const [u, v] = uv(x, y);
      const od = (legacy ? 14 : 11) + fbm(u * 0.03, 0.5, cseed, 3) * 14 + bayDepth * Math.exp(-(((u - bayU) / bayW) ** 2));
      coast[I(x, y)] = v - od;
      land[I(x, y)] = coast[I(x, y)] >= 0 ? 1 : 0;
    }
  }
  const inland = new Uint8Array(N);
  if (type === 'lakes') {
    const lakes = [];
    const n = Math.round((3 + wr.int(0, 2)) * k);
    for (let a = 0; a < 400 && lakes.length < n; a++) {
      const x = wr.int(20, W - 21), y = wr.int(20, H - 21);
      if (coast[I(x, y)] < 34) continue;
      const r = wr.range(7, 15) * Math.sqrt(k);
      if (lakes.some((l) => Math.hypot(l.x - x, l.y - y) < l.r + r + 26)) continue;
      lakes.push({ x, y, r });
    }
    for (const l of lakes) {
      const R = Math.ceil(l.r * 1.4);
      for (let y = l.y - R; y <= l.y + R; y++) for (let x = l.x - R; x <= l.x + R; x++) {
        if (!inb(x, y)) continue;
        const d = Math.hypot((x - l.x) * 0.9, y - l.y);
        if (d < l.r * (0.72 + 0.5 * fbm(x * 0.09, y * 0.09, seed + 99, 2))) inland[I(x, y)] = 1;
      }
    }
  }
  let riverAxis = null;
  if (type === 'river') {
    const ph = wr.range(0, 6.28), amp = wr.range(10, 22) * k, freq = wr.range(0.018, 0.03) / k;
    const uc = (v) => bayU + Math.sin(v * freq + ph) * amp + (fbm(v * 0.02, 3.3, seed + 5, 2) - 0.5) * 30 * k;
    const wd = (v) => 2.6 + 2.2 * Math.exp(-v / (70 * k)) + fbm(v * 0.05, 1.7, seed + 6, 2) * 1.6;
    riverAxis = { uc, wd };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const [u, v] = uv(x, y);
      if (Math.abs(u - uc(v)) < wd(v) && land[I(x, y)]) inland[I(x, y)] = 1;
    }
  }
  if (type === 'island' || type === 'archipelago') {
    const cx = W / 2 + wr.range(-8, 8) * k, cy = H / 2 + wr.range(-8, 8) * k;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - cx, y - cy) / (W * 0.5);
      let s;
      if (type === 'island') s = 0.86 - d + (fbm(x * 0.02, y * 0.02, cseed, 3) - 0.5) * 0.55;
      else {
        s = (fbm(x * 0.017, y * 0.017, cseed, 4) - 0.5) * 1.7 + 0.95 - d * d * 1.15;
        // sea channels split the land into islands
        const ch1 = Math.abs(fbm(x * 0.011, y * 0.011, seed ^ 0x3c3c, 3) - 0.5);
        const ch2 = Math.abs(fbm(x * 0.009 + 40, y * 0.009, seed ^ 0x5d5d, 3) - 0.5);
        if (ch1 < 0.028 || ch2 < 0.022) s = -1;
      }
      land[I(x, y)] = s > 0 && x > 3 && y > 3 && x < W - 4 && y < H - 4 ? 1 : 0;
    }
  }
  for (let i = 0; i < N; i++) if (inland[i]) land[i] = 0;

  // drop tiny islands, then link the remaining land masses with bridges
  if (!legacy) {
    const comp = components(land, W, H);
    for (let i = 0; i < N; i++) if (land[i] && comp.size[comp.id[i]] < 160) land[i] = 0;
    linkLand(land, bridge, W, H, riverAxis, uv, side);
  }

  // distance fields: to the ocean (for beaches) and to inland water (lake/river promenades)
  if (!legacy) {
    const ocean = new Uint8Array(N);
    for (let i = 0; i < N; i++) ocean[i] = !land[i] && !inland[i] ? 1 : 0;
    const dO = distField(ocean, W, H), dI = distField(inland, W, H);
    for (let i = 0; i < N; i++) {
      if (type === 'lakes' || type === 'river') { if (!land[i] && !inland[i]) coast[i] = Math.min(coast[i], -0.5); }
      else coast[i] = ocean[i] ? -1 : dO[i];
      shore[i] = dI[i];
    }
  }

  // ---------------------------------------------------------------- region seeds (poisson-ish)
  const seeds = [];
  const minD = 36;
  const seedCoast = legacy ? 15 : type === 'island' || type === 'archipelago' ? 8 : 12;
  for (let a = 0; a < 6000 && seeds.length < (sizeKey === 'L' ? 110 : 70); a++) {
    const x = rng.int(9, W - 10), y = rng.int(9, H - 10);
    if (coast[I(x, y)] < seedCoast || !land[I(x, y)] || shore[I(x, y)] < 5 || bridge[I(x, y)]) continue;
    let ok = true;
    for (const s of seeds) if ((s.x - x) ** 2 + (s.y - y) ** 2 < minD * minD) { ok = false; break; }
    if (ok) seeds.push({ x, y });
  }

  // ---------------------------------------------------------------- voronoi with warped borders
  const ws1 = seed ^ 0x1234, ws2 = seed ^ 0x4321;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = I(x, y);
    if (!land[i]) continue;
    const wx = x + (fbm(x * 0.05, y * 0.05, ws1, 2) - 0.5) * 16;
    const wy = y + (fbm(x * 0.05, y * 0.05, ws2, 2) - 0.5) * 16;
    let best = 0, bd = Infinity;
    for (let s = 0; s < seeds.length; s++) {
      const d = (seeds[s].x - wx) ** 2 + (seeds[s].y - wy) ** 2;
      if (d < bd) { bd = d; best = s; }
    }
    region[i] = best;
  }

  // merge tiny regions into a neighbor, then compact ids
  const countTiles = () => {
    const c = new Int32Array(seeds.length);
    for (let i = 0; i < N; i++) if (region[i] >= 0) c[region[i]]++;
    return c;
  };
  let counts = countTiles();
  for (let r = 0; r < seeds.length; r++) {
    if (counts[r] >= 420) continue;
    const near = new Map();
    for (let y = 0; y < H; y++) for (let x = 0; x < W - 1; x++) {
      const a = region[I(x, y)], b = region[I(x + 1, y)];
      if (a === r && b >= 0 && b !== r) near.set(b, (near.get(b) || 0) + 1);
      if (b === r && a >= 0 && a !== r) near.set(a, (near.get(a) || 0) + 1);
    }
    let target = -1, bc = 0;
    for (const [kk, v] of near) if (v > bc) { bc = v; target = kk; }
    for (let i = 0; i < N; i++) if (region[i] === r) region[i] = target;
    counts = countTiles();
  }
  const remap = new Int16Array(seeds.length).fill(-1);
  const regions = [];
  for (let r = 0; r < seeds.length; r++) {
    if (counts[r] === 0) continue;
    remap[r] = regions.length;
    regions.push({
      id: regions.length, seedX: seeds[r].x, seedY: seeds[r].y, tiles: 0, sx: 0, sy: 0,
      minX: W, minY: H, maxX: 0, maxY: 0, neighbors: [], coastTiles: 0,
      biome: '', name: '', faction: -1, tier: 0, hq: false, base: false, compound: null,
    });
  }
  for (let i = 0; i < N; i++) if (region[i] >= 0) region[i] = remap[region[i]];

  const nbSets = regions.map(() => new Set());
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = I(x, y), r = region[i];
    if (r < 0) continue;
    const R = regions[r];
    R.tiles++; R.sx += x; R.sy += y;
    if (x < R.minX) R.minX = x; if (x > R.maxX) R.maxX = x;
    if (y < R.minY) R.minY = y; if (y > R.maxY) R.maxY = y;
    if (coast[i] < 9) R.coastTiles++;
    const deep = Math.min(coast[i], shore[i]);
    if (deep > (R.deep || 0)) R.deep = deep;
    if (x + 1 < W) { const b = region[i + 1]; if (b >= 0 && b !== r) { nbSets[r].add(b); nbSets[b].add(r); } }
    if (y + 1 < H) { const b = region[i + W]; if (b >= 0 && b !== r) { nbSets[r].add(b); nbSets[b].add(r); } }
  }
  regions.forEach((R, kk) => {
    R.neighbors = [...nbSets[kk]];
    R.cx = Math.round(R.sx / R.tiles);
    R.cy = Math.round(R.sy / R.tiles);
    if (region[I(R.cx, R.cy)] !== kk) { R.cx = R.seedX; R.cy = R.seedY; }
  });

  // ---------------------------------------------------------------- bases, tiers, factions
  const bases = [];
  let mx = 0, my = 0, ml = 0;
  for (const R of regions) { mx += R.sx; my += R.sy; ml += R.tiles; }
  mx /= ml; my /= ml;
  if (nBases === 1) {
    let baseId = 0, bestD = Infinity;
    for (const R of regions) {
      const d = (R.cx - W / 2) ** 2 + (R.cy - H / 2) ** 2 + (coast[I(R.cx, R.cy)] < 40 ? 4000 : 0) + (!legacy && R.tiles < 700 ? 9000 : 0);
      if (d < bestD) { bestD = d; baseId = R.id; }
    }
    bases.push(baseId);
  } else {
    // spread the gang base sites out: farthest-point sampling over big-enough regions
    // prefer roomy districts (deep inland) so the base compound with its shops fits
    let pool = regions;
    for (const need of [13, 11, 9, 0]) {
      const ok = regions.filter((R) => R.tiles >= 700 && (R.deep || 0) >= need);
      if (ok.length >= nBases) { pool = ok; break; }
    }
    let first = pool[0], fd = -1;
    for (const R of pool) { const d = Math.hypot(R.cx - mx, R.cy - my); if (d > fd) { fd = d; first = R; } }
    bases.push(first.id);
    while (bases.length < Math.min(nBases, pool.length)) {
      let best = null, bd = -1;
      for (const R of pool) {
        if (bases.includes(R.id)) continue;
        let m = Infinity;
        for (const b of bases) m = Math.min(m, Math.hypot(R.cx - regions[b].cx, R.cy - regions[b].cy));
        if (m > bd) { bd = m; best = R; }
      }
      bases.push(best.id);
    }
  }
  const baseId = bases[0];
  for (const b of bases) regions[b].base = true;
  for (const R of regions) R.tier = -1;
  const q = [];
  for (const b of bases) { regions[b].tier = 0; q.push(b); }
  while (q.length) {
    const r = q.shift();
    for (const n of regions[r].neighbors) if (regions[n].tier < 0) { regions[n].tier = regions[r].tier + 1; q.push(n); }
  }
  for (const R of regions) if (R.tier < 0) R.tier = 1;

  const offset = rng.range(0, Math.PI * 2);
  const center = nBases === 1 ? regions[baseId] : { cx: mx, cy: my };
  const factionRegions = [[], [], []];
  for (const R of regions) {
    if (R.base) continue;
    let a = Math.atan2(R.cy - center.cy, R.cx - center.cx) - offset;
    a = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    R.faction = Math.min(2, Math.floor(a / (Math.PI * 2 / 3)));
    factionRegions[R.faction].push(R.id);
  }
  const hqs = [-1, -1, -1];
  for (let f = 0; f < 3; f++) {
    let best = -1, bs = -1;
    for (const id of factionRegions[f]) {
      const R = regions[id];
      const s = R.tier * 1000 + Math.hypot(R.cx - center.cx, R.cy - center.cy) + R.tiles * 0.01;
      if (s > bs) { bs = s; best = id; }
    }
    hqs[f] = best;
    if (best >= 0) regions[best].hq = true;
  }

  // ---------------------------------------------------------------- biomes + names
  const used = new Set();
  for (const R of regions) {
    const elev = R.base ? 0 : fbm(R.cx * 0.02, R.cy * 0.02, seed + 7, 3);
    if (R.base) R.biome = 'base';
    else if (R.coastTiles / R.tiles > (type === 'archipelago' ? 0.62 : type === 'island' ? 0.3 : 0.16)) R.biome = 'beach';
    else if (elev > 0.6) R.biome = rng.chance(0.75) ? 'favela' : 'jungle';
    else R.biome = rng.weighted(FACTIONS[R.faction].biomes);
    if (R.base) { R.name = PVP_BASE_NAMES[bases.indexOf(R.id)] || 'QG'; continue; }
    const parts = NAME_PARTS[R.biome];
    let name = '';
    for (let t = 0; t < 30; t++) {
      name = `${rng.pick(parts[0])} ${rng.pick(parts[1])}`;
      if (!used.has(name)) break;
    }
    used.add(name);
    R.name = name;
  }

  // ---------------------------------------------------------------- ground
  const gseed = seed ^ 0x777;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = I(x, y);
    const c = coast[i];
    if (!land[i]) { tiles[i] = T.WATER; continue; }
    if (bridge[i]) { tiles[i] = T.BRIDGE; continue; }
    const R = regions[region[i]];
    let g = GROUND[R.biome];
    const n = fbm(x * 0.12, y * 0.12, gseed, 2);
    if (R.biome === 'favela' && n > 0.62) g = T.GRASS;
    if (R.biome === 'industrial' && n > 0.58) g = T.CONCRETE;
    if (R.biome === 'suburb' && n > 0.66) g = T.DIRT;
    if (R.biome === 'jungle' && n > 0.68) g = T.DIRT;
    const sandW = (4.2 + fbm(x * 0.1, y * 0.1, gseed + 3, 2) * 2.2) * (type === 'archipelago' ? 0.6 : type === 'island' ? 0.85 : 1);
    if (c < sandW) g = T.SAND;
    else if (c < sandW + 2) g = T.CALCADAO;
    else if (shore[i] < 2.2) g = T.CALCADAO;
    tiles[i] = g;
  }

  // ---------------------------------------------------------------- roads on region borders
  const isLandGround = (t) => t !== T.WATER && t !== T.SAND && t !== T.CALCADAO && t !== T.BRIDGE;
  const roadMask = new Uint8Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = I(x, y), r = region[i];
    if (r < 0 || !isLandGround(tiles[i])) continue;
    let border = false;
    for (let dy = -1; dy <= 1 && !border; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!inb(x + dx, y + dy)) continue;
      const rr = region[I(x + dx, y + dy)];
      if (rr >= 0 && rr !== r) { border = true; break; }
    }
    if (border) roadMask[i] = 1;
  }
  // inner streets for big regions
  for (const R of regions) {
    if (R.tiles < 1500 || R.biome === 'jungle' || R.biome === 'favela') continue;
    const horiz = rng.chance(0.5) || R.biome === 'downtown';
    const vert = !horiz || R.biome === 'downtown' || R.tiles > 1400;
    if (horiz) {
      const yy = R.cy + rng.int(-4, 4) + (R.biome === 'base' ? 12 : 0);
      for (let x = R.minX; x <= R.maxX; x++) for (let kk = 0; kk < 2; kk++) {
        if (inb(x, yy + kk) && region[I(x, yy + kk)] === R.id && isLandGround(tiles[I(x, yy + kk)])) roadMask[I(x, yy + kk)] = 1;
      }
    }
    if (vert) {
      const xx = R.cx + rng.int(-4, 4) + (R.biome === 'base' ? 14 : 0);
      for (let y = R.minY; y <= R.maxY; y++) for (let kk = 0; kk < 2; kk++) {
        if (inb(xx + kk, y) && region[I(xx + kk, y)] === R.id && isLandGround(tiles[I(xx + kk, y)])) roadMask[I(xx + kk, y)] = 1;
      }
    }
  }
  for (let i = 0; i < N; i++) if (roadMask[i]) tiles[i] = T.ROAD;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = I(x, y);
    if (!isLandGround(tiles[i]) || tiles[i] === T.ROAD) continue;
    let nearRoad = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (inb(x + dx, y + dy) && tiles[I(x + dx, y + dy)] === T.ROAD) nearRoad = true;
    }
    if (!nearRoad) continue;
    const b = regions[region[i]].biome;
    if (b === 'favela') tiles[i] = T.STAIRS;
    else if (b !== 'jungle') tiles[i] = T.SIDEWALK;
  }

  // ---------------------------------------------------------------- compounds
  for (const R of regions) {
    let w = 13, h = 11;
    if (R.base) { w = 23; h = 17; } else if (R.hq) { w = 17; h = 13; }
    let placed = false;
    const tryAt = (cx, cy) => {
      const x0 = cx - (w >> 1), y0 = cy - (h >> 1);
      if (x0 < 2 || y0 < 2 || x0 + w > W - 2 || y0 + h > H - 2) return false;
      for (let y = y0 - 1; y < y0 + h + 1; y++) for (let x = x0 - 1; x < x0 + w + 1; x++) {
        const t = tiles[I(x, y)];
        if (t === T.WATER || t === T.SAND || t === T.CALCADAO || t === T.BRIDGE) return false;
        if (reserved[I(x, y)]) return false;
      }
      let inRegion = 0;
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (region[I(x, y)] === R.id) inRegion++;
      if (inRegion < w * h * 0.8) return false;
      R.compound = { x: x0, y: y0, w, h, coreX: x0 + (w >> 1), coreY: y0 + (h >> 1) };
      return true;
    };
    const cands = [[R.cx, R.cy], [R.seedX, R.seedY]];
    for (let kk = 0; kk < 40; kk++) cands.push([R.cx + rng.int(-8, 8), R.cy + rng.int(-8, 8)]);
    for (const [cx, cy] of cands) if (tryAt(cx, cy)) { placed = true; break; }
    if (!placed && R.base) {
      // bases need room for the shops: search a wider spiral, then a slightly smaller base
      for (const [bw, bh] of [[23, 17], [19, 13], [15, 11]]) {
        w = bw; h = bh;
        for (let rr = 2; rr <= 30 && !placed; rr += 2) for (let a = 0; a < 16 && !placed; a++) {
          const cx = Math.round(R.cx + Math.cos(a / 16 * Math.PI * 2) * rr), cy = Math.round(R.cy + Math.sin(a / 16 * Math.PI * 2) * rr);
          if (tryAt(cx, cy)) placed = true;
        }
        if (placed) break;
      }
    }
    if (!placed) {
      w = 9; h = 9;
      for (const [cx, cy] of cands) if (tryAt(cx, cy)) { placed = true; break; }
    }
    if (!placed) {
      // last resort: tiny compound right at the seed
      w = 7; h = 7;
      const x0 = Math.max(2, Math.min(W - 9, R.seedX - 3)), y0 = Math.max(2, Math.min(H - 9, R.seedY - 3));
      R.compound = { x: x0, y: y0, w, h, coreX: x0 + 3, coreY: y0 + 3 };
    }
    const C = R.compound;
    const gate = R.base ? 2 : 1;
    for (let y = C.y - 2; y < C.y + C.h + 2; y++) for (let x = C.x - 2; x < C.x + C.w + 2; x++) {
      if (!inb(x, y)) continue;
      const i = I(x, y);
      reserved[i] = 1;
      const inside = x >= C.x && x < C.x + C.w && y >= C.y && y < C.y + C.h;
      if (!inside) { if (tiles[i] === T.WATER || tiles[i] === T.BRIDGE) continue; if (!roadMask[i] && tiles[i] !== T.SIDEWALK && tiles[i] !== T.STAIRS) tiles[i] = GROUND[R.biome] === T.METAL ? T.CONCRETE : GROUND[R.biome]; continue; }
      const edge = x === C.x || y === C.y || x === C.x + C.w - 1 || y === C.y + C.h - 1;
      const midX = C.x + (C.w >> 1), midY = C.y + (C.h >> 1);
      const isGate = (Math.abs(x - midX) <= gate && (y === C.y || y === C.y + C.h - 1)) ||
        (Math.abs(y - midY) <= gate && (x === C.x || x === C.x + C.w - 1));
      tiles[i] = edge && !isGate ? T.WALL : T.CONCRETE;
    }
    tiles[I(C.coreX, C.coreY)] = T.PAD;
    if (R.base) {
      const mx = Math.min(4, Math.floor(C.w / 4)), my = Math.min(3, Math.floor(C.h / 4));
      const l = C.x + mx, r = C.x + C.w - 1 - mx, t = C.y + my, b = C.y + C.h - 1 - my;
      C.stations = [
        { kind: 'arsenal', x: l, y: t },
        { kind: 'clinic', x: r, y: t },
        { kind: 'locker', x: l, y: b },
        { kind: 'vault', x: r, y: b },
        { kind: 'garage', x: l, y: C.coreY },
      ];
      C.garage = { x: (Math.min(l + 2.5, C.coreX - 1.5)) * TILE, y: (C.coreY + 0.5) * TILE };
    }
    // turret slots around the core
    const dx = Math.max(1, Math.min(4, (C.w >> 1) - 2)), dy = Math.max(1, Math.min(3, (C.h >> 1) - 2));
    C.slots = [[-dx, -dy], [dx, -dy], [-dx, dy], [dx, dy]].map(([ox, oy]) => ({ x: (C.coreX + ox + 0.5) * TILE, y: (C.coreY + oy + 0.5) * TILE }));
  }

  // ---------------------------------------------------------------- buildings
  const buildings = [];
  const groundOk = (t) => t === T.GRASS || t === T.DIRT || t === T.CONCRETE || t === T.METAL;
  const canPlace = (rid, x0, y0, w, h, m) => {
    if (x0 - m < 1 || y0 - m < 1 || x0 + w + m > W - 1 || y0 + h + m > H - 1) return false;
    for (let y = y0 - m; y < y0 + h + m; y++) for (let x = x0 - m; x < x0 + w + m; x++) {
      const i = I(x, y), t = tiles[i];
      const foot = x >= x0 && x < x0 + w && y >= y0 && y < y0 + h;
      if (foot) { if (region[i] !== rid || !groundOk(t) || reserved[i]) return false; }
      else if (t === T.BUILD || t === T.WALL || t === T.TREE || t === T.WATER) return false;
    }
    return true;
  };
  for (const R of regions) {
    const S = BSPEC[R.biome];
    const attempts = R.tiles * 2;
    let n = 0;
    for (let a = 0; a < attempts && n < R.tiles / S.per; a++) {
      const style = rng.weighted(S.styles);
      const st = STYLE[style];
      const w = rng.int(st.w[0], st.w[1]), h = rng.int(st.h[0], st.h[1]);
      const x0 = rng.int(R.minX, R.maxX - w), y0 = rng.int(R.minY, R.maxY - h);
      if (!canPlace(R.id, x0, y0, w, h, st.m ?? 1)) continue;
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) tiles[I(x, y)] = T.BUILD;
      const fr = Math.max(0, Math.min(h - 1, rng.int(st.fr[0], st.fr[1])));
      buildings.push({ x: x0, y: y0, w, h, style, fr, ht: fr + (style === 'tower' ? 1 : 0), r: R.id, seed: rng.int(0, 1e9) });
      n++;
    }
  }

  // ---------------------------------------------------------------- trees
  const tseed = seed ^ 0xbeef;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = I(x, y);
    if (tiles[i] !== T.GRASS || reserved[i]) continue;
    const b = regions[region[i]].biome;
    const p = b === 'jungle' ? 0.2 + fbm(x * 0.15, y * 0.15, tseed, 2) * 0.25 : b === 'suburb' ? 0.025 : b === 'beach' ? 0.01 : 0;
    if (hash2(x, y, tseed) >= p) continue;
    let ok = true;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const t = tiles[I(x + dx, y + dy)];
      if (t === T.BUILD || t === T.WALL || t === T.ROAD) ok = false;
    }
    if (ok) tiles[i] = T.TREE;
  }

  // ---------------------------------------------------------------- connectivity
  const world = {
    seed, type, size: sizeKey, W, H, tiles, region, regions, buildings, coast, baseId, bases, factionRegions, hqs,
    props: [], lights: [], propGrid: null, lightGrid: null, reach: null, spawnTiles: null, roadTiles: null,
    breakables: [], breakGrid: null, wires: [], wireGrid: null, smokers: [], holos: [],
  };
  const b0 = regions[baseId].compound;
  let reach = floodReach(world, b0.coreX, b0.coreY);
  for (const R of regions) {
    const C = R.compound;
    if (!reach[I(C.coreX, C.coreY)]) {
      carvePath(world, C.coreX, C.coreY, reach);
      reach = floodReach(world, b0.coreX, b0.coreY);
    }
  }
  world.reach = reach;

  // spawn tiles per region (reachable, open, not inside compounds), and road tiles for vehicles
  world.spawnTiles = regions.map(() => []);
  world.roadTiles = [];
  for (let i = 0; i < N; i++) {
    if (!reach[i] || region[i] < 0 || reserved[i]) continue;
    world.spawnTiles[region[i]].push(i);
    if (tiles[i] === T.ROAD) world.roadTiles.push(i);
  }

  // ---------------------------------------------------------------- props, lights & decoration
  buildProps(world);
  return world;
}

// building styles: footprint size ranges and facade (front) rows = how tall it looks
const STYLE = {
  favela: { w: [2, 4], h: [2, 4], fr: [1, 2] },
  house: { w: [3, 5], h: [3, 4], fr: [1, 1] },
  shop: { w: [3, 5], h: [2, 3], fr: [1, 2] },
  church: { w: [3, 4], h: [3, 4], fr: [2, 2] },
  apartment: { w: [3, 6], h: [3, 5], fr: [2, 3] },
  tower: { w: [3, 7], h: [4, 7], fr: [2, 4] },
  club: { w: [4, 6], h: [3, 4], fr: [1, 2] },
  warehouse: { w: [4, 8], h: [3, 5], fr: [1, 2] },
  factory: { w: [4, 7], h: [3, 5], fr: [2, 2] },
  container: { w: [2, 3], h: [1, 1], fr: [0, 0], m: 1 },
  kiosk: { w: [3, 4], h: [2, 3], fr: [1, 1] },
  ruin: { w: [2, 4], h: [2, 3], fr: [1, 1] },
};
const BSPEC = {
  favela: { per: 7, styles: { favela: 1 } },
  suburb: { per: 12, styles: { house: 6, shop: 3, church: 0.5, apartment: 1.2 } },
  downtown: { per: 15, styles: { tower: 6, apartment: 2, shop: 1.5, club: 0.8 } },
  industrial: { per: 19, styles: { warehouse: 5, factory: 1.5, container: 4 } },
  beach: { per: 24, styles: { kiosk: 3, shop: 1 } },
  jungle: { per: 90, styles: { ruin: 1 } },
  base: { per: 22, styles: { tower: 2, apartment: 1, shop: 1 } },
};

// connected components of a 0/1 grid (4-neighborhood)
function components(grid, W, H) {
  const N = W * H;
  const id = new Int32Array(N).fill(-1);
  const size = [];
  const q = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    if (!grid[s] || id[s] >= 0) continue;
    const c = size.length;
    let h = 0, t = 0;
    q[t++] = s; id[s] = c;
    while (h < t) {
      const i = q[h++], x = i % W;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
        if (j < 0 || j >= N || !grid[j] || id[j] >= 0) continue;
        id[j] = c; q[t++] = j;
      }
    }
    size.push(t);
  }
  return { id, size };
}

// chamfer distance (in tiles) from the cells where src = 1
function distField(src, W, H) {
  const N = W * H;
  const d = new Float32Array(N);
  for (let i = 0; i < N; i++) d[i] = src[i] ? 0 : 1e9;
  const D = Math.SQRT2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 1);
    if (y > 0) {
      d[i] = Math.min(d[i], d[i - W] + 1);
      if (x > 0) d[i] = Math.min(d[i], d[i - W - 1] + D);
      if (x < W - 1) d[i] = Math.min(d[i], d[i - W + 1] + D);
    }
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x;
    if (x < W - 1) d[i] = Math.min(d[i], d[i + 1] + 1);
    if (y < H - 1) {
      d[i] = Math.min(d[i], d[i + W] + 1);
      if (x < W - 1) d[i] = Math.min(d[i], d[i + W + 1] + D);
      if (x > 0) d[i] = Math.min(d[i], d[i + W - 1] + D);
    }
  }
  return d;
}

// Links separate land masses with straight bridges (2 tiles wide). Rivers get several bridges.
function linkLand(land, bridge, W, H, riverAxis, uv, side) {
  const I = (x, y) => y * W + x;
  const lay = (x0, y0, dx, dy, len) => {
    for (let s = 0; s <= len; s++) for (let w = 0; w < 2; w++) {
      const x = x0 + dx * s + (dy ? w : 0), y = y0 + dy * s + (dx ? w : 0);
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
      if (!land[I(x, y)]) { land[I(x, y)] = 1; bridge[I(x, y)] = 1; }
    }
  };
  // river: a bridge every ~48 tiles along the river
  if (riverAxis) {
    for (let v = 26; v < H - 10; v += 46) {
      const u = Math.round(riverAxis.uc(v));
      // walk across the river along u at this v
      let a = -1, b = -1;
      for (let du = -16; du <= 16; du++) {
        const [x, y] = fromUV(u + du, v, W, H, side);
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        if (!land[I(x, y)]) { if (a < 0) a = du; b = du; }
      }
      if (a < 0) continue;
      for (let du = a - 1; du <= b + 1; du++) for (let w = 0; w < 2; w++) {
        const [x, y] = fromUV(u + du, v + w, W, H, side);
        if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
        if (!land[I(x, y)]) { land[I(x, y)] = 1; bridge[I(x, y)] = 1; }
      }
    }
  }
  for (let guard = 0; guard < 40; guard++) {
    const comp = components(land, W, H);
    if (comp.size.length <= 1) return;
    let main = 0;
    for (let c = 1; c < comp.size.length; c++) if (comp.size[c] > comp.size[main]) main = c;
    // shortest straight water crossing from any other land mass into the main one
    let best = null;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = I(x, y);
      if (!land[i] || comp.id[i] === main) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (land[I(x + dx, y + dy)]) continue;
        for (let s = 1; s < 60; s++) {
          const xx = x + dx * s, yy = y + dy * s;
          if (xx < 1 || yy < 1 || xx >= W - 1 || yy >= H - 1) break;
          const j = I(xx, yy);
          if (!land[j]) continue;
          if (comp.id[j] === main && (!best || s < best.len)) best = { x, y, dx, dy, len: s };
          break;
        }
      }
    }
    if (!best) {
      // no straight crossing: L-shaped bridge to the nearest main-land tile
      let src = -1, dst = -1, bd = Infinity;
      for (let i = 0; i < W * H; i += 3) {
        if (!land[i] || comp.id[i] === main) continue;
        for (let j = 0; j < W * H; j += 5) {
          if (!land[j] || comp.id[j] !== main) continue;
          const d = Math.abs((i % W) - (j % W)) + Math.abs(((i / W) | 0) - ((j / W) | 0));
          if (d < bd) { bd = d; src = i; dst = j; }
        }
      }
      if (src < 0) return;
      const sx = src % W, sy = (src / W) | 0, tx = dst % W, ty = (dst / W) | 0;
      lay(Math.min(sx, tx), sy, 1, 0, Math.abs(tx - sx));
      lay(tx, Math.min(sy, ty), 0, 1, Math.abs(ty - sy));
      continue;
    }
    lay(best.x, best.y, best.dx, best.dy, best.len);
  }
}
function fromUV(u, v, W, H, side) {
  if (side === 0) return [u, H - 1 - v];
  if (side === 1) return [W - 1 - v, u];
  if (side === 2) return [u, v];
  return [v, u];
}

function floodReach(world, sx, sy) {
  const { tiles, W, H } = world;
  const reach = new Uint8Array(W * H);
  const q = new Int32Array(W * H);
  let h = 0, t = 0;
  q[t++] = sy * W + sx; reach[sy * W + sx] = 1;
  while (h < t) {
    const i = q[h++], x = i % W, y = (i / W) | 0;
    const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
    for (const j of nb) {
      if (j < 0 || reach[j] || SOLID[tiles[j]]) continue;
      reach[j] = 1; q[t++] = j;
    }
  }
  return reach;
}

// Opens a path from (sx, sy) to the reachable area, cutting through trees/walls (then a building, then water as a bridge).
function carvePath(world, sx, sy, reach) {
  const { tiles, W, H } = world;
  for (const pass of [0, 1, 2]) {
    const prev = new Int32Array(W * H).fill(-2);
    const q = new Int32Array(W * H);
    let h = 0, t = 0, found = -1;
    const s = sy * W + sx;
    q[t++] = s; prev[s] = -1;
    while (h < t && found < 0) {
      const i = q[h++], x = i % W, y = (i / W) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
        if (j < 0 || prev[j] !== -2) continue;
        const tt = tiles[j];
        if ((tt === T.WATER && pass < 2) || (tt === T.BUILD && pass < 1)) continue;
        prev[j] = i;
        if (reach[j]) { found = j; break; }
        q[t++] = j;
      }
    }
    if (found < 0) continue;
    let i = prev[found];
    while (i >= 0) {
      if (tiles[i] === T.BUILD) {
        const x = i % W, y = (i / W) | 0;
        const bi = world.buildings.findIndex((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);
        if (bi >= 0) {
          const b = world.buildings[bi];
          for (let yy = b.y; yy < b.y + b.h; yy++) for (let xx = b.x; xx < b.x + b.w; xx++) tiles[yy * W + xx] = T.CONCRETE;
          world.buildings.splice(bi, 1);
        }
      }
      if (tiles[i] === T.WATER) tiles[i] = T.BRIDGE;
      else if (SOLID[tiles[i]]) tiles[i] = T.CONCRETE;
      i = prev[i];
    }
    return;
  }
}

// ---------------------------------------------------------------- props, lights, signs, wires, breakables
function buildProps(world) {
  const { tiles, regions, seed, W, H } = world;
  const props = world.props, lights = world.lights;
  const I = (x, y) => y * W + x;
  const ps = seed ^ 0xfacade;
  const tAt = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? T.WATER : tiles[I(x, y)]);
  const near = (x, y, t) => tAt(x - 1, y) === t || tAt(x + 1, y) === t || tAt(x, y - 1) === t || tAt(x, y + 1) === t;
  const poles = [];
  const brk = (type, x, y, v = 0) => world.breakables.push({ id: world.breakables.length, type, x, y, v });
  const P = (type, x, y, v = 0, extra) => { const p = { type, x, y, v }; if (extra) Object.assign(p, extra); props.push(p); return p; };
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = I(x, y), t = tiles[i];
    const r = world.region[i];
    if (r < 0) {
      if (t === T.BRIDGE && (x + y) % 9 === 0 && (tAt(x - 1, y) === T.WATER || tAt(x, y - 1) === T.WATER)) {
        P('lamp', x * TILE + 8, y * TILE + 12, 1); lights.push({ x: x * TILE + 8, y: y * TILE - 14, r: 46, c: '#22e5ff' });
      }
      continue;
    }
    const biome = regions[r].biome;
    const h = hash2(x, y, ps), h2 = hash2(x, y, ps + 17);
    const px = x * TILE + 8, py = y * TILE + 12;
    const v = (h2 * 1000) | 0;
    if (t === T.SAND) {
      if (world.coast[i] > 1.8 && h < 0.045) P('palm', px, py, v);
      else if (h > 0.96) P('umbrella', px, py, v);
      else if (h > 0.945) P('chair', px, py, v);
      else if (h2 < 0.0025 && world.coast[i] > 2) { P('lifeguard', px, py, v); lights.push({ x: px, y: py - 30, r: 40, c: '#ff3b5c' }); }
    } else if (t === T.SIDEWALK) {
      const nearRoad = near(x, y, T.ROAD);
      if (nearRoad && (x * 7 + y * 13) % 11 === 0 && h < 0.7) {
        P('lamp', px, py, 0);
        lights.push({ x: px, y: py - 26, r: 58, c: h < 0.35 ? '#ff4fd8' : '#ffd88a', anim: h2 < 0.06 ? 'broken' : undefined, seed: h2 * 100 });
      } else if (h < 0.03 && biome !== 'downtown') P('palm', px, py, v);
      else if (h < 0.06) P('bin', px, py, v);
      else if (h < 0.075) P('bench', px, py, v);
      else if (h < 0.085) P('hydrant', px, py, v);
      else if (h < 0.095 && biome === 'downtown') { P('vending', px, py, v); lights.push({ x: px, y: py - 10, r: 26, c: v % 2 ? '#22e5ff' : '#ff4fd8' }); }
      else if (h < 0.102 && nearRoad && tAt(x + 1, y) === T.SIDEWALK) { P('busstop', px + 4, py, v); lights.push({ x: px + 4, y: py - 12, r: 30, c: '#9af0ff' }); }
      else if (h < 0.108 && (biome === 'downtown' || biome === 'suburb')) { P('banca', px, py, v); lights.push({ x: px, y: py - 10, r: 22, c: '#ffd88a' }); }
      else if (h < 0.125 && biome !== 'suburb') P('bags', px, py, v);
      else if (h < 0.132 && biome === 'downtown') { P('cart', px, py, v); lights.push({ x: px, y: py - 10, r: 26, c: '#ffb84a', flicker: true }); world.smokers.push({ x: px + 2, y: py - 14, k: 'grill' }); }
      else if (h < 0.140 && (biome === 'industrial' || biome === 'downtown')) P('cone', px, py, v);
      else if (h < 0.146 && biome === 'suburb') P('plant', px, py, v);
      else if (h < 0.150 && nearRoad) brk('transformer', px, py, v);
      else if (biome === 'suburb' && nearRoad && (x * 5 + y * 3) % 13 === 0 && h > 0.85) { poles.push({ x: px, y: py }); P('pole', px, py, v); }
    } else if (t === T.STAIRS) {
      if ((x * 3 + y * 7) % 9 === 0 && h > 0.45) { poles.push({ x: px, y: py }); P('pole', px, py, v); }
      else if (h < 0.035) P('bags', px, py, v);
      else if (h < 0.05 && near(x, y, T.BUILD)) brk('gastank', px, py, v);
      else if (h < 0.058) P('bin', px, py, v);
    } else if (t === T.CALCADAO) {
      if (h < 0.05) P('palm', px, py, v);
      else if (h > 0.985) { P('lamp', px, py, 1); lights.push({ x: px, y: py - 26, r: 50, c: '#22e5ff' }); }
      else if (h > 0.97) { P('coco', px, py, v); lights.push({ x: px, y: py - 10, r: 24, c: '#ffd88a' }); }
      else if (h > 0.955) P('bench', px, py, v);
      else if (h > 0.948) P('bin', px, py, v);
    } else if (t === T.GRASS) {
      if ((biome === 'beach' || biome === 'suburb' || biome === 'base') && h < 0.025) P('palm', px, py, v);
      else if ((biome === 'jungle' || biome === 'favela') && h < 0.04) P('banana', px, py, v);
      else if (biome === 'suburb' && h < 0.035) P('plant', px, py, v);
      else if (biome === 'favela' && h > 0.985) brk('gastank', px, py, v);
    } else if (t === T.DIRT) {
      if (biome === 'favela' && h < 0.014) {
        P('barrel', px, py, 0);
        lights.push({ x: px, y: py - 8, r: 40, c: '#ff8a3d', flicker: true });
      } else if (biome === 'favela' && h > 0.975) P('banana', px, py, v);
      else if (biome === 'favela' && h > 0.955) P('bags', px, py, v);
      else if (biome === 'favela' && h > 0.94 && near(x, y, T.BUILD)) brk('gastank', px, py, v);
      else if (h > 0.93 && h < 0.94) P('tires', px, py, v);
    } else if (t === T.METAL) {
      if (h < 0.012) { P('barrel', px, py, 0); lights.push({ x: px, y: py - 8, r: 40, c: '#ff8a3d', flicker: true }); }
      else if (h < 0.035) brk('xbarrel', px, py, v);
      else if (h < 0.06) P('crate', px, py, v);
      else if (h < 0.075) P('pallet', px, py, v);
      else if (h < 0.083) P('dumpster', px, py, v);
      else if (h < 0.09) P('drums', px, py, v);
    } else if (t === T.CONCRETE) {
      if (biome === 'downtown' && h < 0.012) { P('vending', px, py, v); lights.push({ x: px, y: py - 10, r: 26, c: '#22e5ff' }); }
      else if (biome === 'downtown' && h < 0.03) P('planter', px, py, v);
      else if ((biome === 'downtown' || biome === 'industrial') && h < 0.04) P('bin', px, py, v);
      else if (biome === 'industrial' && h < 0.06) brk('xbarrel', px, py, v);
      else if (biome === 'industrial' && h < 0.08) P('crate', px, py, v);
    } else if (t === T.ROAD) {
      if (h < 0.006) brk('car', px, py, (h * 100000) | 0);
      else if (hash2(x, y, seed + 5) < 0.004) world.smokers.push({ x: x * TILE + 8, y: y * TILE + 8, k: 'steam' });
    }
  }
  // building heights (floors), signs, billboards, holograms, chimneys
  for (const b of world.buildings) {
    const h = hash2(b.x, b.y, ps + 1), h2 = hash2(b.x, b.y, ps + 2), h3 = hash2(b.x, b.y, ps + 3), h4 = hash2(b.x, b.y, ps + 4);
    b.floors = buildingFloors(b, h4);
    b.H = b.style === 'container' ? 9 : b.floors * FLOOR_PX + 4;
    const brandOf = (cats, hh) => { const list = BRANDS.map((B, i) => [B, i]).filter(([B]) => cats.includes(B.cat)); return list[(hh * 9973 | 0) % list.length][1]; };
    const sx = (b.x + b.w / 2) * TILE, sy = (b.y + b.h) * TILE + 5;          // street in front of the south facade
    let sign = null;
    if (b.style === 'shop' || (b.style === 'house' && h < 0.35) || b.style === 'kiosk') sign = { kind: 'panel', brand: brandOf(['food', 'shop', 'night'], h2) };
    else if (b.style === 'tower') sign = h < 0.45 ? { kind: 'panel', brand: brandOf(['corp', 'night', 'shop'], h2) } : h < 0.9 ? { kind: 'vertical', brand: brandOf(['corp', 'night', 'food'], h2), right: h3 < 0.5 } : null;
    else if (b.style === 'apartment' && h < 0.6) sign = { kind: 'vertical', brand: brandOf(['night', 'food', 'shop'], h2), right: h3 < 0.5 };
    else if ((b.style === 'warehouse' || b.style === 'factory') && h < 0.6 && b.w >= 4) sign = { kind: 'panel', brand: brandOf(['ind'], h2) };
    else if (b.style === 'club') sign = { kind: 'marquee', brand: brandOf(['night'], h2) };
    else if (b.style === 'church') sign = { kind: 'cross' };
    else if (b.style === 'favela' && h < 0.15 && b.w >= 3) sign = { kind: 'panel', brand: brandOf(['food', 'night', 'shop'], h2) };
    if (sign) {
      b.sign = sign;
      sign.c = sign.kind === 'cross' ? '#ff3b5c' : BRANDS[sign.brand].c;
      sign.c2 = sign.kind === 'cross' ? '#ffffff' : BRANDS[sign.brand].c2;
      // animated neon: some flicker, some swap colors, some pulse
      sign.anim = sign.kind === 'marquee' ? 'chase' : h3 < 0.14 ? 'flicker' : h3 < 0.34 ? 'swap' : h3 < 0.5 ? 'pulse' : 'steady';
      const lx = sign.kind === 'vertical' ? (sign.right ? (b.x + b.w) * TILE - 4 : b.x * TILE + 4) : sx;
      lights.push({ x: lx, y: sy, r: 50 + b.w * 4, c: sign.c, c2: sign.c2, anim: sign.anim, seed: h * 100 });
    }
    // rooftop billboards (towers, apartments, warehouses) and holograms (tall towers)
    if ((b.style === 'tower' || b.style === 'apartment' || b.style === 'warehouse') && b.w >= 4 && b.h >= 3 && h2 > 0.62) {
      b.board = { brand: brandOf(['corp', 'food', 'night', 'shop'], h3), anim: h < 0.3 ? 'swap' : 'steady' };
    } else if (b.style === 'tower' && b.floors >= 6 && b.w >= 4 && h3 > 0.5) {
      const brand = brandOf(['corp', 'night', 'food'], h);
      world.holos.push({ x: sx, y: (b.y + b.h / 2) * TILE, z: b.H, brand, seed: (h * 1000) | 0 });
    }
    // lit windows spill a little warm light at the foot of the building at night
    if (b.style !== 'container' && b.style !== 'ruin' && h < 0.55) lights.push({ x: sx, y: sy, r: 22 + b.w * 3, c: b.style === 'tower' ? '#9ab8ff' : '#ffcf7a', night: true });
    if (b.style === 'factory' || (b.style === 'warehouse' && h3 < 0.25)) world.smokers.push({ x: b.x * TILE + 8 + ((h2 * (b.w - 1)) | 0) * TILE, y: (b.y + 1) * TILE, z: b.H, k: 'smoke' });
    if (b.style === 'club') lights.push({ x: sx, y: sy + 4, r: 64, c: '#ff3fa4', c2: '#22e5ff', anim: 'strobe', seed: h * 100 });
  }
  // compound cores & base stations
  for (const R of regions) {
    const C = R.compound;
    props.push({ type: 'core', x: C.coreX * TILE + 8, y: C.coreY * TILE + 10, region: R.id });
    if (C.stations) for (const s of C.stations) {
      props.push({ type: 'station', kind: s.kind, x: s.x * TILE + 8, y: s.y * TILE + 12 });
      lights.push({ x: s.x * TILE + 8, y: s.y * TILE, r: 50, c: STATION_COLORS[s.kind] });
    }
    // bases are well lit: floodlights in the corners and over the core
    if (R.base) {
      for (const [fx, fy] of [[C.x + 2, C.y + 2], [C.x + C.w - 3, C.y + 2], [C.x + 2, C.y + C.h - 3], [C.x + C.w - 3, C.y + C.h - 3]]) {
        props.push({ type: 'flood', x: fx * TILE + 8, y: fy * TILE + 12, v: 0 });
        lights.push({ x: fx * TILE + 8, y: fy * TILE + 4, r: 120, c: '#fff4dc', base: true });
      }
      lights.push({ x: (C.coreX + 0.5) * TILE, y: (C.coreY + 0.5) * TILE, r: 150, c: '#ffe8c8', base: true });
    }
  }
  // power lines between poles ("gatos" in the favela)
  for (let a = 0; a < poles.length; a++) {
    let links = 0;
    for (let b = a + 1; b < poles.length && links < 2; b++) {
      const d = Math.hypot(poles[a].x - poles[b].x, poles[a].y - poles[b].y);
      if (d > 8 && d < 7 * TILE) { world.wires.push({ x1: poles[a].x, y1: poles[a].y - 30, x2: poles[b].x, y2: poles[b].y - 30 }); links++; }
    }
  }
  // buckets
  const cw = Math.ceil(W / CHUNK), ch = Math.ceil(H / CHUNK);
  const bucket = (px, py) => Math.max(0, Math.min(ch - 1, Math.floor(py / TILE / CHUNK))) * cw + Math.max(0, Math.min(cw - 1, Math.floor(px / TILE / CHUNK)));
  const grid = (list, fx = (o) => o.x, fy = (o) => o.y) => {
    const g = Array.from({ length: cw * ch }, () => []);
    for (const o of list) g[bucket(fx(o), fy(o))].push(o);
    return g;
  };
  world.propGrid = grid(props);
  world.lightGrid = grid(lights);
  world.breakGrid = grid(world.breakables);
  world.wireGrid = grid(world.wires, (o) => (o.x1 + o.x2) / 2, (o) => (o.y1 + o.y2) / 2);
  world.smokeGrid = grid(world.smokers);
  world.holoGrid = grid(world.holos);
  world.gridW = cw; world.gridH = ch;
  world.bucket = bucket;
}

// building heights: floors per style (deterministic from the building's own hash)
export const FLOOR_PX = 13;
export function buildingFloors(b, r) {
  switch (b.style) {
    case 'favela': return 1 + (b.fr >= 2 ? 1 : 0) + (r < 0.35 ? 1 : 0);
    case 'house': return 1 + (r < 0.4 ? 1 : 0);
    case 'shop': return 2 + (r < 0.4 ? 1 : 0);
    case 'church': return 3;
    case 'apartment': return 3 + Math.floor(r * 3) + (b.w * b.h > 18 ? 1 : 0);
    case 'tower': return Math.min(10, 4 + b.fr + Math.floor(r * 3) + (b.w * b.h > 24 ? 1 : 0));
    case 'club': return 2;
    case 'warehouse': return 2;
    case 'factory': return 3;
    case 'kiosk': return 1;
    case 'ruin': return 1 + (r < 0.5 ? 1 : 0);
    default: return 1;
  }
}

export const STATION_COLORS = { arsenal: '#ff3f8e', clinic: '#3ddc84', locker: '#22e5ff', vault: '#ffd23f', garage: '#ff8a3d' };

// ---------------------------------------------------------------- queries & collision
export const tileAt = (world, tx, ty) => (tx < 0 || ty < 0 || tx >= world.W || ty >= world.H ? T.WATER : world.tiles[ty * world.W + tx]);

export function solidAt(world, px, py) {
  return SOLID[tileAt(world, Math.floor(px / TILE), Math.floor(py / TILE))] === 1;
}
export function opaqueAt(world, px, py) {
  const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
  if (tx < 0 || ty < 0 || tx >= world.W || ty >= world.H) return true;
  return OPAQUE[world.tiles[ty * world.W + tx]] === 1;
}

export function regionAt(world, px, py) {
  const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
  if (tx < 0 || ty < 0 || tx >= world.W || ty >= world.H) return -1;
  return world.region[ty * world.W + tx];
}

export function boxHits(world, x, y, r) {
  const x0 = Math.floor((x - r) / TILE), x1 = Math.floor((x + r) / TILE);
  const y0 = Math.floor((y - r) / TILE), y1 = Math.floor((y + r) / TILE);
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
    if (SOLID[tileAt(world, tx, ty)]) return true;
  }
  return false;
}

// Moves an entity with axis-separated sliding against solid tiles.
export function moveBox(world, e, dx, dy, r) {
  if (dx) {
    const nx = e.x + dx;
    if (!boxHits(world, nx, e.y, r)) e.x = nx;
    else {
      const snap = dx > 0 ? Math.floor((nx + r) / TILE) * TILE - r - 0.01 : (Math.floor((nx - r) / TILE) + 1) * TILE + r + 0.01;
      if (!boxHits(world, snap, e.y, r) && Math.abs(snap - e.x) <= Math.abs(dx) + 0.02) e.x = snap;
    }
  }
  if (dy) {
    const ny = e.y + dy;
    if (!boxHits(world, e.x, ny, r)) e.y = ny;
    else {
      const snap = dy > 0 ? Math.floor((ny + r) / TILE) * TILE - r - 0.01 : (Math.floor((ny - r) / TILE) + 1) * TILE + r + 0.01;
      if (!boxHits(world, e.x, snap, r) && Math.abs(snap - e.y) <= Math.abs(dy) + 0.02) e.y = snap;
    }
  }
}

// Nearest open (walkable) spot to a pixel position, searching outward ring by ring.
export function nearestOpen(world, px, py, r = 5) {
  if (!boxHits(world, px, py, r)) return { x: px, y: py };
  const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
  for (let d = 1; d < 30; d++) {
    let best = null, bd = Infinity;
    for (let y = ty - d; y <= ty + d; y++) for (let x = tx - d; x <= tx + d; x++) {
      if (Math.max(Math.abs(x - tx), Math.abs(y - ty)) !== d) continue;
      const cx = x * TILE + 8, cy = y * TILE + 8;
      if (boxHits(world, cx, cy, r)) continue;
      if (world.reach && !world.reach[y * world.W + x]) continue;
      const dd = (cx - px) ** 2 + (cy - py) ** 2;
      if (dd < bd) { bd = dd; best = { x: cx, y: cy }; }
    }
    if (best) return best;
  }
  return { x: px, y: py };
}

export function lineOfSight(world, x0, y0, x1, y1) {
  const d = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.ceil(d / 6);
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    if (opaqueAt(world, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
  }
  return true;
}

// Casts a ray until it hits an opaque tile. Returns the distance travelled.
export function rayCast(world, x, y, ang, maxD) {
  const cx = Math.cos(ang), cy = Math.sin(ang);
  for (let d = 0; d < maxD; d += 3) if (opaqueAt(world, x + cx * d, y + cy * d)) return d;
  return maxD;
}

// ---------------------------------------------------------------- BFS flow fields (enemy pathing)
export function bfsField(world, tx, ty, radius) {
  const size = radius * 2 + 1, ox = tx - radius, oy = ty - radius;
  const dist = new Int16Array(size * size).fill(-1);
  const q = new Int32Array(size * size);
  let h = 0, t = 0;
  const start = radius * size + radius;
  dist[start] = 0; q[t++] = start;
  while (h < t) {
    const kk = q[h++], lx = kk % size, ly = (kk / size) | 0;
    const d = dist[kk] + 1;
    for (let n = 0; n < 4; n++) {
      const nx = lx + (n === 0 ? 1 : n === 1 ? -1 : 0), ny = ly + (n === 2 ? 1 : n === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const nk = ny * size + nx;
      if (dist[nk] >= 0) continue;
      if (SOLID[tileAt(world, ox + nx, oy + ny)]) { dist[nk] = 32000; continue; }
      dist[nk] = d; q[t++] = nk;
    }
  }
  return { ox, oy, size, dist, cx: tx, cy: ty };
}

// Direction (unit vector) to walk along a field from a pixel position, or null if outside / unreachable.
export function fieldDir(world, f, px, py) {
  const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
  const lx = tx - f.ox, ly = ty - f.oy;
  if (lx < 0 || ly < 0 || lx >= f.size || ly >= f.size) return null;
  const here = f.dist[ly * f.size + lx];
  if (here < 0 || here >= 32000) return null;
  if (here === 0) return { x: (tx * TILE + 8 - px), y: (ty * TILE + 8 - py), done: true };
  let best = here, bx = 0, by = 0;
  const get = (x, y) => (x < 0 || y < 0 || x >= f.size || y >= f.size ? 32000 : (f.dist[y * f.size + x] < 0 ? 32000 : f.dist[y * f.size + x]));
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    if (dx && dy && (get(lx + dx, ly) >= 32000 || get(lx, ly + dy) >= 32000)) continue;
    const v = get(lx + dx, ly + dy) + (dx && dy ? 0.4 : 0);
    if (v < best) { best = v; bx = dx; by = dy; }
  }
  if (!bx && !by) return null;
  const txp = (tx + bx) * TILE + 8, typ = (ty + by) * TILE + 8;
  const vx = txp - px, vy = typ - py, l = Math.hypot(vx, vy) || 1;
  return { x: vx / l, y: vy / l };
}

// Small top-down image of a world for previews and the map screen (1 pixel per tile).
export function mapImageData(world, out) {
  const { W, H, tiles } = world;
  const d = out.data;
  const BIOME = { base: [106, 100, 120], beach: [74, 138, 74], favela: [154, 90, 58], downtown: [90, 90, 112], suburb: [63, 127, 67], industrial: [79, 88, 102], jungle: [42, 106, 50] };
  for (let i = 0; i < W * H; i++) {
    const t = tiles[i];
    let c;
    if (t === T.WATER) c = [16, 60, 100];
    else if (t === T.SAND) c = [214, 190, 130];
    else if (t === T.CALCADAO) c = [200, 200, 190];
    else if (t === T.ROAD) c = [34, 32, 44];
    else if (t === T.BRIDGE) c = [150, 120, 90];
    else if (t === T.SIDEWALK || t === T.STAIRS) c = [110, 106, 120];
    else if (t === T.BUILD) c = [70, 62, 84];
    else if (t === T.WALL) c = [180, 176, 196];
    else if (t === T.TREE) c = [24, 80, 34];
    else c = BIOME[world.regions[world.region[i]]?.biome] || [80, 80, 80];
    d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255;
  }
  return out;
}
