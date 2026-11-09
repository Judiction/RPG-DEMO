// Procedural city generation + tile collision helpers.
// generateWorld(seed) is deterministic: host and clients build the exact same city from the seed.

import { makeRng, fbm, hash2 } from './rng.js';
import { TILE, FACTIONS, NAME_PARTS } from './data.js';

export const W = 256, H = 256;

export const T = {
  WATER: 0, SAND: 1, GRASS: 2, DIRT: 3, ROAD: 4, SIDEWALK: 5, CALCADAO: 6, CONCRETE: 7,
  BUILD: 8, WALL: 9, STAIRS: 10, METAL: 11, TREE: 12, PAD: 13,
};
export const SOLID = new Uint8Array(16);
SOLID[T.WATER] = SOLID[T.BUILD] = SOLID[T.WALL] = SOLID[T.TREE] = 1;
export const OPAQUE = new Uint8Array(16);           // blocks bullets and sight
OPAQUE[T.BUILD] = OPAQUE[T.WALL] = OPAQUE[T.TREE] = 1;

const GROUND = { base: T.CONCRETE, beach: T.GRASS, favela: T.DIRT, downtown: T.CONCRETE, suburb: T.GRASS, industrial: T.METAL, jungle: T.GRASS };

export const CHUNK = 16;                            // tiles per prop/light bucket

export function generateWorld(seed) {
  const rng = makeRng(seed);
  const N = W * H;
  const tiles = new Uint8Array(N);
  let region = new Int16Array(N).fill(-1);
  const coast = new Float32Array(N);
  const reserved = new Uint8Array(N);
  const I = (x, y) => y * W + x;
  const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;

  // ---------------------------------------------------------------- coastline
  const side = rng.int(0, 3);                       // which edge the ocean is on
  const bayU = rng.range(50, 200), bayDepth = rng.range(4, 22), bayW = rng.range(12, 26);
  const cseed = seed ^ 0x51ab;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let u, v;
    if (side === 0) { u = x; v = H - 1 - y; }
    else if (side === 1) { u = y; v = W - 1 - x; }
    else if (side === 2) { u = x; v = y; }
    else { u = y; v = x; }
    const od = 14 + fbm(u * 0.03, 0.5, cseed, 3) * 14 + bayDepth * Math.exp(-(((u - bayU) / bayW) ** 2));
    coast[I(x, y)] = v - od;
  }

  // ---------------------------------------------------------------- region seeds (poisson-ish)
  const seeds = [];
  const minD = 36;
  for (let a = 0; a < 6000 && seeds.length < 70; a++) {
    const x = rng.int(9, W - 10), y = rng.int(9, H - 10);
    if (coast[I(x, y)] < 15) continue;
    let ok = true;
    for (const s of seeds) if ((s.x - x) ** 2 + (s.y - y) ** 2 < minD * minD) { ok = false; break; }
    if (ok) seeds.push({ x, y });
  }

  // ---------------------------------------------------------------- voronoi with warped borders
  const ws1 = seed ^ 0x1234, ws2 = seed ^ 0x4321;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = I(x, y);
    if (coast[i] < 0) continue;
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
    for (const [k, v] of near) if (v > bc) { bc = v; target = k; }
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
    if (x + 1 < W) { const b = region[i + 1]; if (b >= 0 && b !== r) { nbSets[r].add(b); nbSets[b].add(r); } }
    if (y + 1 < H) { const b = region[i + W]; if (b >= 0 && b !== r) { nbSets[r].add(b); nbSets[b].add(r); } }
  }
  regions.forEach((R, k) => {
    R.neighbors = [...nbSets[k]];
    R.cx = Math.round(R.sx / R.tiles);
    R.cy = Math.round(R.sy / R.tiles);
    if (region[I(R.cx, R.cy)] !== k) { R.cx = R.seedX; R.cy = R.seedY; }
  });

  // ---------------------------------------------------------------- base, tiers, factions
  let baseId = 0, bestD = Infinity;
  for (const R of regions) {
    const d = (R.cx - W / 2) ** 2 + (R.cy - H / 2) ** 2 + (coast[I(R.cx, R.cy)] < 40 ? 4000 : 0);
    if (d < bestD) { bestD = d; baseId = R.id; }
  }
  const base = regions[baseId];
  base.base = true;
  const q = [baseId];
  for (const R of regions) R.tier = -1;
  base.tier = 0;
  while (q.length) {
    const r = q.shift();
    for (const n of regions[r].neighbors) if (regions[n].tier < 0) { regions[n].tier = regions[r].tier + 1; q.push(n); }
  }
  for (const R of regions) if (R.tier < 0) R.tier = 1;

  const offset = rng.range(0, Math.PI * 2);
  const factionRegions = [[], [], []];
  for (const R of regions) {
    if (R.base) continue;
    let a = Math.atan2(R.cy - base.cy, R.cx - base.cx) - offset;
    a = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    R.faction = Math.min(2, Math.floor(a / (Math.PI * 2 / 3)));
    factionRegions[R.faction].push(R.id);
  }
  const hqs = [-1, -1, -1];
  for (let f = 0; f < 3; f++) {
    let best = -1, bs = -1;
    for (const id of factionRegions[f]) {
      const R = regions[id];
      const s = R.tier * 1000 + Math.hypot(R.cx - base.cx, R.cy - base.cy) + R.tiles * 0.01;
      if (s > bs) { bs = s; best = id; }
    }
    hqs[f] = best;
    if (best >= 0) regions[best].hq = true;
  }

  // ---------------------------------------------------------------- biomes + names
  const used = new Set();
  for (const R of regions) {
    const elev = fbm(R.cx * 0.02, R.cy * 0.02, seed + 7, 3);
    if (R.base) R.biome = 'base';
    else if (R.coastTiles / R.tiles > 0.16) R.biome = 'beach';
    else if (elev > 0.6) R.biome = rng.chance(0.75) ? 'favela' : 'jungle';
    else R.biome = rng.weighted(FACTIONS[R.faction].biomes);
    if (R.base) { R.name = 'QG da Laje'; continue; }
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
    if (c < 0) { tiles[i] = T.WATER; continue; }
    const R = regions[region[i]];
    let g = GROUND[R.biome];
    const n = fbm(x * 0.12, y * 0.12, gseed, 2);
    if (R.biome === 'favela' && n > 0.62) g = T.GRASS;
    if (R.biome === 'industrial' && n > 0.58) g = T.CONCRETE;
    if (R.biome === 'suburb' && n > 0.66) g = T.DIRT;
    if (R.biome === 'jungle' && n > 0.68) g = T.DIRT;
    const sandW = 4.2 + fbm(x * 0.1, y * 0.1, gseed + 3, 2) * 2.2;
    if (c < sandW) g = T.SAND;
    else if (c < sandW + 2) g = T.CALCADAO;
    tiles[i] = g;
  }

  // ---------------------------------------------------------------- roads on region borders
  const isLandGround = (t) => t !== T.WATER && t !== T.SAND && t !== T.CALCADAO;
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
      for (let x = R.minX; x <= R.maxX; x++) for (let k = 0; k < 2; k++) {
        if (inb(x, yy + k) && region[I(x, yy + k)] === R.id && isLandGround(tiles[I(x, yy + k)])) roadMask[I(x, yy + k)] = 1;
      }
    }
    if (vert) {
      const xx = R.cx + rng.int(-4, 4) + (R.biome === 'base' ? 14 : 0);
      for (let y = R.minY; y <= R.maxY; y++) for (let k = 0; k < 2; k++) {
        if (inb(xx + k, y) && region[I(xx + k, y)] === R.id && isLandGround(tiles[I(xx + k, y)])) roadMask[I(xx + k, y)] = 1;
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
        if (t === T.WATER || t === T.SAND || t === T.CALCADAO) return false;
        if (reserved[I(x, y)]) return false;
      }
      let inRegion = 0;
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (region[I(x, y)] === R.id) inRegion++;
      if (inRegion < w * h * 0.8) return false;
      R.compound = { x: x0, y: y0, w, h, coreX: x0 + (w >> 1), coreY: y0 + (h >> 1) };
      return true;
    };
    const cands = [[R.cx, R.cy], [R.seedX, R.seedY]];
    for (let k = 0; k < 40; k++) cands.push([R.cx + rng.int(-8, 8), R.cy + rng.int(-8, 8)]);
    for (const [cx, cy] of cands) if (tryAt(cx, cy)) { placed = true; break; }
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
      if (!inside) { if (tiles[i] === T.WATER) continue; if (!roadMask[i] && tiles[i] !== T.SIDEWALK && tiles[i] !== T.STAIRS) tiles[i] = GROUND[R.biome] === T.METAL ? T.CONCRETE : GROUND[R.biome]; continue; }
      const edge = x === C.x || y === C.y || x === C.x + C.w - 1 || y === C.y + C.h - 1;
      const midX = C.x + (C.w >> 1), midY = C.y + (C.h >> 1);
      const isGate = (Math.abs(x - midX) <= gate && (y === C.y || y === C.y + C.h - 1)) ||
        (Math.abs(y - midY) <= gate && (x === C.x || x === C.x + C.w - 1));
      tiles[i] = edge && !isGate ? T.WALL : T.CONCRETE;
    }
    tiles[I(C.coreX, C.coreY)] = T.PAD;
    if (R.base) {
      C.stations = [
        { kind: 'arsenal', x: C.x + 4, y: C.y + 3 },
        { kind: 'clinic', x: C.x + C.w - 5, y: C.y + 3 },
        { kind: 'locker', x: C.x + 4, y: C.y + C.h - 4 },
        { kind: 'vault', x: C.x + C.w - 5, y: C.y + C.h - 4 },
      ];
    }
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
  const SPEC = {
    favela: { per: 7, w: [2, 4], h: [2, 3], m: 1, fr: 1, style: 'favela' },
    suburb: { per: 12, w: [3, 5], h: [3, 4], m: 1, fr: 1, style: 'house' },
    downtown: { per: 16, w: [3, 7], h: [3, 6], m: 1, fr: 2, style: 'tower' },
    industrial: { per: 20, w: [4, 8], h: [3, 5], m: 1, fr: 1, style: 'warehouse' },
    beach: { per: 26, w: [3, 4], h: [2, 3], m: 1, fr: 1, style: 'kiosk' },
    jungle: { per: 90, w: [2, 4], h: [2, 3], m: 1, fr: 1, style: 'ruin' },
    base: { per: 24, w: [3, 6], h: [3, 5], m: 1, fr: 2, style: 'tower' },
  };
  for (const R of regions) {
    const S = SPEC[R.biome];
    const attempts = R.tiles * 2;
    let n = 0;
    for (let a = 0; a < attempts && n < R.tiles / S.per; a++) {
      let w = rng.int(S.w[0], S.w[1]), h = rng.int(S.h[0], S.h[1]), m = S.m, style = S.style, fr = S.fr;
      if (R.biome === 'industrial' && rng.chance(0.4)) { style = 'container'; w = rng.int(2, 3); h = 1; m = 1; fr = 0; }
      const x0 = rng.int(R.minX, R.maxX - w), y0 = rng.int(R.minY, R.maxY - h);
      if (!canPlace(R.id, x0, y0, w, h, m)) continue;
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) tiles[I(x, y)] = T.BUILD;
      buildings.push({ x: x0, y: y0, w, h, style, fr: Math.min(fr, h - 1), r: R.id, seed: rng.int(0, 1e9) });
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
    seed, W, H, tiles, region, regions, buildings, coast, baseId, factionRegions, hqs,
    props: [], lights: [], propGrid: null, lightGrid: null, reach: null, spawnTiles: null,
  };
  let reach = floodReach(world, base.compound.coreX, base.compound.coreY);
  for (const R of regions) {
    const C = R.compound;
    if (!reach[I(C.coreX, C.coreY)]) {
      carvePath(world, C.coreX, C.coreY, reach);
      reach = floodReach(world, base.compound.coreX, base.compound.coreY);
    }
  }
  world.reach = reach;

  // spawn tiles per region (reachable, open, not inside compounds)
  world.spawnTiles = regions.map(() => []);
  for (let i = 0; i < N; i++) {
    if (!reach[i] || region[i] < 0 || reserved[i]) continue;
    world.spawnTiles[region[i]].push(i);
  }

  // ---------------------------------------------------------------- props & lights
  buildProps(world, rng);
  return world;
}

function floodReach(world, sx, sy) {
  const { tiles } = world;
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

// Opens a path from (sx, sy) to the reachable area, cutting through trees/walls (and, if it must, a building).
function carvePath(world, sx, sy, reach) {
  const { tiles } = world;
  for (const allowBuild of [false, true]) {
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
        if (tt === T.WATER || (tt === T.BUILD && !allowBuild)) continue;
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
      if (SOLID[tiles[i]]) tiles[i] = T.CONCRETE;
      i = prev[i];
    }
    return;
  }
}

function buildProps(world, rng) {
  const { tiles, regions, seed } = world;
  const props = world.props, lights = world.lights;
  const I = (x, y) => y * W + x;
  const ps = seed ^ 0xfacade;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = I(x, y), t = tiles[i];
    const r = world.region[i];
    if (r < 0) continue;
    const biome = regions[r].biome;
    const h = hash2(x, y, ps);
    const px = x * TILE + 8, py = y * TILE + 12;
    if (t === T.SAND) {
      if (world.coast[i] > 1.8 && h < 0.045) props.push({ type: 'palm', x: px, y: py, v: (h * 1000) | 0 });
      else if (h > 0.96) props.push({ type: 'umbrella', x: px, y: py, v: (h * 1000) | 0 });
    } else if (t === T.SIDEWALK) {
      const nearRoad = tiles[i - 1] === T.ROAD || tiles[i + 1] === T.ROAD || tiles[i - W] === T.ROAD || tiles[i + W] === T.ROAD;
      if (nearRoad && (x * 7 + y * 13) % 11 === 0 && h < 0.7) {
        props.push({ type: 'lamp', x: px, y: py, v: 0 });
        lights.push({ x: px, y: py - 26, r: 48, c: h < 0.35 ? '#ff4fd8' : '#ffd88a' });
      } else if (h < 0.03 && biome !== 'downtown') props.push({ type: 'palm', x: px, y: py, v: (h * 1000) | 0 });
    } else if (t === T.CALCADAO) {
      if (h < 0.05) props.push({ type: 'palm', x: px, y: py, v: (h * 1000) | 0 });
      else if (h > 0.985) {
        props.push({ type: 'lamp', x: px, y: py, v: 1 });
        lights.push({ x: px, y: py - 26, r: 50, c: '#22e5ff' });
      }
    } else if (t === T.GRASS) {
      if ((biome === 'beach' || biome === 'suburb' || biome === 'base') && h < 0.025) props.push({ type: 'palm', x: px, y: py, v: (h * 1000) | 0 });
      else if (biome === 'jungle' && h < 0.04) props.push({ type: 'banana', x: px, y: py, v: (h * 1000) | 0 });
      else if (biome === 'favela' && h < 0.04) props.push({ type: 'banana', x: px, y: py, v: (h * 1000) | 0 });
    } else if (t === T.DIRT || t === T.METAL || t === T.STAIRS) {
      if ((biome === 'favela' || biome === 'industrial') && h < 0.014) {
        props.push({ type: 'barrel', x: px, y: py, v: 0 });
        lights.push({ x: px, y: py - 8, r: 40, c: '#ff8a3d', flicker: true });
      } else if (biome === 'favela' && h > 0.975) props.push({ type: 'banana', x: px, y: py, v: (h * 1000) | 0 });
    } else if (t === T.ROAD) {
      if (h < 0.006) props.push({ type: 'car', x: px, y: py, v: (h * 100000) | 0 });
    }
  }
  // signs on buildings (neon), + window light
  for (const b of world.buildings) {
    const h = hash2(b.x, b.y, ps + 1);
    if ((b.style === 'tower' || b.style === 'house' || b.style === 'kiosk' || b.style === 'warehouse') && h < 0.6 && b.w >= 3) {
      const colors = ['#ff3fa4', '#22e5ff', '#ffd23f', '#3ddc84', '#a66bff', '#ff6a2b'];
      b.sign = { c: colors[(h * 1000 | 0) % colors.length], text: SIGNS[(h * 7919 | 0) % SIGNS.length] };
      lights.push({ x: (b.x + b.w / 2) * TILE, y: (b.y + b.h - b.fr) * TILE + 4, r: 46 + b.w * 3, c: b.sign.c, flicker: h < 0.1 });
    }
    if (b.style === 'favela' && h < 0.5) lights.push({ x: (b.x + b.w / 2) * TILE, y: (b.y + b.h) * TILE - 6, r: 26, c: '#ffcf7a' });
  }
  // compound cores & base stations
  for (const R of regions) {
    const C = R.compound;
    props.push({ type: 'core', x: C.coreX * TILE + 8, y: C.coreY * TILE + 10, region: R.id });
    if (C.stations) for (const s of C.stations) {
      props.push({ type: 'station', kind: s.kind, x: s.x * TILE + 8, y: s.y * TILE + 12 });
      lights.push({ x: s.x * TILE + 8, y: s.y * TILE, r: 50, c: STATION_COLORS[s.kind] });
    }
  }
  // buckets
  const cw = Math.ceil(W / CHUNK), ch = Math.ceil(H / CHUNK);
  world.propGrid = Array.from({ length: cw * ch }, () => []);
  world.lightGrid = Array.from({ length: cw * ch }, () => []);
  const bucket = (px, py) => Math.min(ch - 1, Math.floor(py / TILE / CHUNK)) * cw + Math.min(cw - 1, Math.floor(px / TILE / CHUNK));
  for (const p of props) world.propGrid[bucket(p.x, p.y)].push(p);
  for (const l of lights) world.lightGrid[bucket(l.x, l.y)].push(l);
  world.gridW = cw; world.gridH = ch;
}

export const STATION_COLORS = { arsenal: '#ff3f8e', clinic: '#3ddc84', locker: '#22e5ff', vault: '#ffd23f' };
const SIGNS = ['BAR', 'LAN', 'AÇAÍ', '24H', 'BAILE', 'FARMA', 'CHIPS', 'PASTEL', 'SUCO', 'HOTEL', 'TATTOO', 'ROBÔ', 'CAFÉ', 'LOJA', 'BOTECO', 'NET', 'MODS', 'SAMBA'];

// ---------------------------------------------------------------- queries & collision
export const tileAt = (world, tx, ty) => (tx < 0 || ty < 0 || tx >= W || ty >= H ? T.WATER : world.tiles[ty * W + tx]);

export function solidAt(world, px, py) {
  return SOLID[tileAt(world, Math.floor(px / TILE), Math.floor(py / TILE))] === 1;
}
export function opaqueAt(world, px, py) {
  const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
  if (tx < 0 || ty < 0 || tx >= W || ty >= H) return true;
  return OPAQUE[world.tiles[ty * W + tx]] === 1;
}

export function regionAt(world, px, py) {
  const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
  if (tx < 0 || ty < 0 || tx >= W || ty >= H) return -1;
  return world.region[ty * W + tx];
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
    const k = q[h++], lx = k % size, ly = (k / size) | 0;
    const d = dist[k] + 1;
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
